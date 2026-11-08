import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { alertLog, auditEvents, tenants } from "../db/schema.js";
import { getDefinition } from "../bots/definitions.js";
import { getTenantSettings } from "../org/org.js";
import type { agentMailAdmin } from "../mail/agentmail.js";
import type { BalanceReader } from "../engine/balances.js";

export type AlertKind = "balance" | "failures" | "approvals";

export type AlertDeps = {
  db: Db;
  admin: ReturnType<typeof agentMailAdmin>;
  balance?: BalanceReader;
};

/** The shared outgoing mailbox for operational alerts. */
const FROM_LOCAL = "teammate-admin";
const FROM_AGENT = "be-teammate-admin";
const WINDOW_MS = 24 * 60 * 60_000;

let inboxCache: { id: string } | undefined;

async function ensureAlertInbox(admin: ReturnType<typeof agentMailAdmin>): Promise<{ id: string } | undefined> {
  if (inboxCache) return inboxCache;
  try {
    const found = await admin.findInbox(FROM_LOCAL);
    if (found) return (inboxCache = { id: found.id });
    const made = await admin.createInbox(FROM_LOCAL, "BE Teammate Admin", FROM_AGENT);
    return (inboxCache = { id: made.id });
  } catch (e) {
    console.error("alert inbox:", e instanceof Error ? e.message : "error");
    return undefined;
  }
}

const recipients = (emails: string | null | undefined) => (emails ?? "").split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);

const senderName = async (db: Db, tenantId: string, botId: string | null | undefined) => {
  const bot = botId ? await getDefinition(db, tenantId, botId) : undefined;
  return bot ? `${bot.displayName ?? bot.label} · BE Teammate` : "BE Teammate";
};

/** Send one alert unless the same kind and fingerprint went out inside the window. */
export async function sendAlert(deps: AlertDeps, tenantId: string, kind: AlertKind, fingerprint: string, subject: string, body: string, windowMs = WINDOW_MS): Promise<boolean> {
  const s = await getTenantSettings(deps.db, tenantId);
  if (kind === "balance" && !s.alertLowBalance) return false;
  if (kind === "failures" && !s.alertFailures) return false;
  if (kind === "approvals" && !s.alertApprovals) return false;
  const to = recipients(s.alertEmails);
  if (!to.length) return false;
  const [recent] = await deps.db
    .select({ id: alertLog.id })
    .from(alertLog)
    .where(and(eq(alertLog.tenantId, tenantId), eq(alertLog.kind, kind), eq(alertLog.fingerprint, fingerprint), gte(alertLog.sentAt, new Date(Date.now() - windowMs))))
    .limit(1);
  if (recent) return false;
  const inbox = await ensureAlertInbox(deps.admin);
  if (!inbox) return false;
  try {
    await deps.admin.sendMessage({ inboxId: inbox.id, to, subject: `[BE Teammate] ${subject}`, text: `${body}\n\n— ${await senderName(deps.db, tenantId, s.alertBotId)}` });
  } catch (e) {
    console.error("alert send:", e instanceof Error ? e.message : "error");
    return false;
  }
  await deps.db.insert(alertLog).values({ id: crypto.randomUUID(), tenantId, kind, fingerprint });
  return true;
}

/** A test from the settings page: no throttle, no condition check. */
export async function sendTestAlert(deps: AlertDeps, tenantId: string): Promise<boolean> {
  const s = await getTenantSettings(deps.db, tenantId);
  const to = recipients(s.alertEmails);
  if (!to.length) return false;
  const inbox = await ensureAlertInbox(deps.admin);
  if (!inbox) return false;
  await deps.admin.sendMessage({
    inboxId: inbox.id,
    to,
    subject: "[BE Teammate] Test alert",
    text: `This is a test from the settings page. Alerts will come from this address when something needs attention.\n\n— ${await senderName(deps.db, tenantId, s.alertBotId)}`,
  });
  return true;
}

/** Every few minutes: low provider balance, failed actions, approvals still waiting. */
export function startAlertScheduler(deps: AlertDeps, everyMs = 5 * 60_000): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      for (const t of await deps.db.select({ id: tenants.id }).from(tenants)) {
        const s = await getTenantSettings(deps.db, t.id);
        if (!recipients(s.alertEmails).length) continue;
        if (s.alertLowBalance && deps.balance) {
          const wallet = await deps.balance().catch(() => undefined);
          if (wallet && (!wallet.available || wallet.total < (s.alertBalanceThreshold ?? 5))) {
            const amount = `${wallet.currency === "USD" ? "$" : ""}${wallet.total.toFixed(2)}`;
            await sendAlert(
              deps,
              t.id,
              "balance",
              "low-balance",
              `DeepSeek balance is ${amount}`,
              `The DeepSeek account has ${amount} left. Top it up so the bots keep answering.\n\n${wallet.available ? "" : `The balance check failed: ${wallet.error ?? "unknown"}.`}`,
            );
          }
        }
        if (s.alertFailures) {
          const since = new Date(Date.now() - 60 * 60_000);
          const failures = await deps.db
            .select({ id: auditEvents.id, summary: auditEvents.summary, toolName: auditEvents.toolName, startedAt: auditEvents.startedAt })
            .from(auditEvents)
            .where(and(eq(auditEvents.tenantId, t.id), eq(auditEvents.status, "failed"), gte(auditEvents.startedAt, since)))
            .orderBy(desc(auditEvents.startedAt))
            .limit(10);
          if (failures.length) {
            const fingerprint = `failures-${new Date().toISOString().slice(0, 13)}`;
            await sendAlert(
              deps,
              t.id,
              "failures",
              fingerprint,
              `${failures.length} failed action${failures.length === 1 ? "" : "s"} in the last hour`,
              failures.map((f) => `- ${f.summary}${f.toolName ? ` (${f.toolName})` : ""} at ${f.startedAt.toISOString().slice(11, 16)} UTC`).join("\n"),
            );
          }
        }
        if (s.alertApprovals) {
          const since = new Date(Date.now() - 10 * 60_000);
          const approvals = await deps.db
            .select({ id: auditEvents.id, summary: auditEvents.summary, startedAt: auditEvents.startedAt })
            .from(auditEvents)
            .where(and(eq(auditEvents.tenantId, t.id), eq(auditEvents.status, "pending"), eq(auditEvents.kind, "tool"), gte(auditEvents.startedAt, since)))
            .limit(10);
          if (approvals.length) {
            const fingerprint = approvals.map((a) => a.id).sort().join(",");
            await sendAlert(
              deps,
              t.id,
              "approvals",
              fingerprint,
              `${approvals.length} approval${approvals.length === 1 ? "" : "s"} waiting`,
              approvals.map((a) => `- ${a.summary}`).join("\n"),
            );
          }
        }
      }
    } catch (e) {
      console.error("alert scheduler:", e instanceof Error ? e.message : "error");
    }
    if (!stopped) timer = setTimeout(tick, everyMs);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
