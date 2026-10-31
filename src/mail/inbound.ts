import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import type { Application, RequestHandler } from "express";
import { eq, lt } from "drizzle-orm";
import { beginAction, completeAction } from "../audit/audit.js";
import type { Db } from "../db/client.js";
import { botDefinitions, chatAssignments, mailboxes, mailDeliveries } from "../db/schema.js";
import { decrypt } from "../secrets/cipher.js";

export type InboundDeps = {
  db: Db;
  secretsKey: Buffer;
  send: (chatId: string, message: string) => Promise<void>;
  now?: () => Date;
};

const MAX_AGE_MS = 5 * 60_000;
const errName = (e: unknown) => (e instanceof Error ? e.name : "error");

// the header format is undocumented: take unix seconds or milliseconds, or an ISO date
function parseTimestamp(raw: string): number {
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw) < 1e12 ? Number(raw) * 1000 : Number(raw);
  return Date.parse(raw);
}

function validSignature(secret: string, timestamp: string, body: Buffer, signature: string): boolean {
  const want = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest();
  const got = Buffer.from(signature.trim().replace(/^sha256=/, ""), "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

// sender and subject are untrusted and Teams renders markdown, links and mentions
const plain = (s: string) => s.replace(/[\\`*_~[\]()<>#|@&]/g, "\\$&");
const oneLine = (s: unknown, max: number) => (typeof s === "string" ? s : "").replace(/\s+/g, " ").trim().slice(0, max);

export function mailInbound(deps: InboundDeps): RequestHandler[] {
  const { db, secretsKey } = deps;
  const now = deps.now ?? (() => new Date());

  const handle: RequestHandler = async (req, res) => {
    try {
      const body = req.body as unknown;
      if (!Buffer.isBuffer(body)) return void res.sendStatus(400);
      let event: { id?: unknown; type?: unknown; agent?: unknown; message?: { from_address?: unknown; subject?: unknown } };
      try {
        event = JSON.parse(body.toString("utf8"));
      } catch {
        return void res.sendStatus(400);
      }
      const [box] = typeof event.agent === "string" ? await db.select().from(mailboxes).where(eq(mailboxes.agent, event.agent)) : [];
      // unknown or inactive mailbox: nothing to tell, and nothing for the sender to retry
      if (!box || box.status !== "active" || !box.webhookSecretCipher || !box.address) return void res.sendStatus(200);

      const timestamp = String(req.header("x-agentmail-timestamp") ?? "");
      const signature = String(req.header("x-agentmail-signature") ?? "");
      if (!timestamp || !signature || !validSignature(decrypt(secretsKey, box.webhookSecretCipher), timestamp, body, signature)) return void res.sendStatus(401);
      if (!(Math.abs(now().getTime() - parseTimestamp(timestamp)) <= MAX_AGE_MS)) return void res.sendStatus(200);

      if (event.type !== "message.received" || typeof event.id !== "string") return void res.sendStatus(200);
      await db.delete(mailDeliveries).where(lt(mailDeliveries.receivedAt, new Date(now().getTime() - 24 * 3600_000)));
      const fresh = await db.insert(mailDeliveries).values({ id: event.id }).onConflictDoNothing().returning({ id: mailDeliveries.id });
      if (!fresh.length) return void res.sendStatus(200);
      res.sendStatus(200); // recorded: a Teams failure below must not make BE AgentMail retry

      const sender = oneLine(event.message?.from_address, 320);
      const ownDomain = box.address.slice(box.address.lastIndexOf("@") + 1).toLowerCase();
      if (!sender || sender.slice(sender.lastIndexOf("@") + 1).toLowerCase() === ownDomain) return;
      const subject = oneLine(event.message?.subject, 200);
      const text = `New email to ${box.address} from ${plain(sender)}: ${plain(subject)}`;
      const [def] = await db.select({ tenantId: botDefinitions.tenantId }).from(botDefinitions).where(eq(botDefinitions.id, box.definitionId));
      if (!def) return;
      for (const { chatId } of await db.select({ chatId: chatAssignments.chatId }).from(chatAssignments).where(eq(chatAssignments.definitionId, box.definitionId))) {
        // one chat's failure (Teams or audit) never stops the notices to the others
        let status: "done" | "failed" = "done";
        try {
          await deps.send(chatId, text);
        } catch (e) {
          status = "failed";
          console.error("mail notice:", errName(e));
        }
        try {
          const id = await beginAction(db, { tenantId: def.tenantId, chatId, definitionId: box.definitionId, kind: "message", summary: `Email from ${sender}: ${subject}`.slice(0, 200) });
          await completeAction(db, id, { status });
        } catch (e) {
          console.error("mail notice:", errName(e));
        }
      }
    } catch (e) {
      console.error("mail inbound:", errName(e));
      if (!res.headersSent) res.sendStatus(500); // nothing was recorded, so a retry is useful
    }
  };
  return [express.raw({ type: () => true, limit: "1mb" }), handle];
}

/** startServer installs express.json() before beforeListen; move the route ahead of it so the signed bytes arrive intact. */
export function mountMailInbound(app: Application, deps: InboundDeps): void {
  app.post("/mail/inbound", ...mailInbound(deps));
  // Express 5 (what startServer uses) keeps the router at app.router, Express 4 at app._router
  type Stack = { stack?: { route?: { path: string }; name: string }[] };
  const a = app as unknown as { router?: Stack; _router?: Stack };
  const stack = (a._router ?? a.router)?.stack; // reading app.router throws on Express 4, so _router first
  const mine = stack?.findIndex((l) => l.route?.path === "/mail/inbound") ?? -1;
  const json = stack?.findIndex((l) => l.name === "jsonParser") ?? -1;
  if (!stack || mine < 0 || json < 0) throw new Error("mail inbound: cannot find the Express json layer to mount before");
  if (mine > json) stack.splice(json, 0, ...stack.splice(mine, 1));
  if (stack.findIndex((l) => l.route?.path === "/mail/inbound") > stack.findIndex((l) => l.name === "jsonParser")) throw new Error("mail inbound: route is not before the json parser");
}
