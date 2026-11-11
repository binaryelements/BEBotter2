import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import express from "express";
import type { Application } from "express";
import { eq, sql } from "drizzle-orm";
import { beginAction, completeAction } from "../audit/audit.js";
import type { Db } from "../db/client.js";
import { botDefinitions, chatAssignments } from "../db/schema.js";
import { decrypt } from "../secrets/cipher.js";

/**
 * A bot's one inbound URL, like its mailbox: an outside system (an email notification, a monitor, a form) posts to it
 * and the message is handed to the bot, in every chat the bot is in. The secret is in the path, over https.
 */
export type InboundHookDeps = { db: Db; secretsKey: Buffer; send: (chatId: string, message: string) => Promise<void> };

/** A fresh secret for a bot's inbound URL; the caller stores it encrypted. */
export const newHookSecret = (): string => randomBytes(24).toString("base64url");

const digest = (s: string) => createHash("sha256").update(s).digest();
const same = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

export type HookPayload = { text: string; from?: string; subject?: string };
export type HookResult = { status: number; message?: string; deliver?: () => Promise<void> };

const word = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim().slice(0, max) : "");

/** Reads what was posted: JSON with text/message/body/content (and optional from/subject), or a plain-text body. */
export function readPayload(body: unknown): HookPayload | undefined {
  if (typeof body === "string") return body.trim() ? { text: word(body, 8000) } : undefined;
  if (!body || typeof body !== "object") return undefined;
  const f = body as Record<string, unknown>;
  const text = word(f.text ?? f.message ?? f.body ?? f.content, 8000);
  if (!text) return undefined;
  const from = word(f.from ?? f.from_address ?? f.sender, 200);
  const subject = word(f.subject, 200);
  return { text, ...(from ? { from } : {}), ...(subject ? { subject } : {}) };
}

/** What the bot's people see: like the mail notice, sender and subject first, then the message itself. */
export function hookNotice(p: HookPayload): string {
  const origin = p.from || "an outside system";
  const head = p.subject ? `Webhook from ${origin}: ${p.subject}` : `Webhook from ${origin}`;
  return `${head}\n\n${p.text}`.slice(0, 9000);
}

const errName = (e: unknown) => (e instanceof Error ? e.name : "error");

/** Verifies the URL and the body, then hands back the delivery to start once the caller has answered 202. */
export async function receiveHook(deps: InboundHookDeps, id: string, secret: string, body: unknown): Promise<HookResult> {
  const [def] = await deps.db.select().from(botDefinitions).where(eq(botDefinitions.id, id));
  // unknown bot or no URL made: nothing for the sender to retry
  if (!def || !def.inboundSecret) return { status: 404 };
  let stored: string;
  try {
    stored = decrypt(deps.secretsKey, def.inboundSecret);
  } catch {
    return { status: 404 };
  }
  if (!same(stored, secret)) return { status: 401 };
  const payload = readPayload(body);
  if (!payload) return { status: 400, message: "Send JSON with a text field, or a plain-text body" };
  await deps.db
    .update(botDefinitions)
    .set({ inboundAt: new Date(), inboundHits: sql`${botDefinitions.inboundHits} + 1` })
    .where(eq(botDefinitions.id, def.id));
  const text = hookNotice(payload);
  return {
    status: 202,
    deliver: async () => {
      const chats = await deps.db.select({ chatId: chatAssignments.chatId }).from(chatAssignments).where(eq(chatAssignments.definitionId, def.id));
      for (const { chatId } of chats) {
        // one chat's failure (Teams or audit) never stops the notices to the others
        let status: "done" | "failed" = "done";
        try {
          await deps.send(chatId, text);
        } catch (e) {
          status = "failed";
          console.error("inbound hook:", errName(e));
        }
        try {
          const auditId = await beginAction(deps.db, { tenantId: def.tenantId, chatId, definitionId: def.id, kind: "message", summary: `Webhook from ${payload.from || "an outside system"}${payload.subject ? `: ${payload.subject}` : ""}`.slice(0, 200) });
          await completeAction(deps.db, auditId, { status });
        } catch (e) {
          console.error("inbound hook:", errName(e));
        }
      }
    },
  };
}

/** Mounts `POST /hooks/:id/:secret`; the message is posted as the bot, so the sender never waits on Teams. */
export function mountInboundHook(app: Application, deps: InboundHookDeps): void {
  app.post("/hooks/:id/:secret", (req, res) => {
    void bodyOf(req)
      .then((body) => receiveHook(deps, req.params.id ?? "", req.params.secret ?? "", body))
      .then((r) => {
        res.sendStatus(r.status);
        if (r.deliver) void r.deliver().catch((e) => console.error(`inbound hook ${req.params.id}:`, errName(e)));
      })
      .catch((e) => {
        console.error(`inbound hook ${req.params.id}:`, errName(e));
        if (!res.headersSent) res.sendStatus(500);
      });
  });
}

/**
 * The body as posted. The Teams SDK installs express.json() for every route, so a JSON body is already parsed (and the
 * stream used up); anything else is still on the stream and is read here, then tried as JSON.
 */
async function bodyOf(req: express.Request): Promise<unknown> {
  if (String(req.headers["content-type"] ?? "").includes("json")) return req.body;
  if (typeof req.body === "string") return req.body;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  // a form body, or a parser earlier in the chain left something usable
  return req.body && typeof req.body === "object" && Object.keys(req.body as object).length ? req.body : undefined;
}
