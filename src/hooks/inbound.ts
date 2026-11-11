import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import express from "express";
import type { Application } from "express";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { botDefinitions } from "../db/schema.js";
import { runRoutine } from "../routines/scheduler.js";
import type { SchedulerDeps } from "../routines/scheduler.js";
import { decrypt } from "../secrets/cipher.js";

/**
 * A bot's one inbound URL: an outside system (an email notification, a monitor, a form) posts to it, the bot runs a
 * turn on what arrived, and the reply goes to the chat the admin picked. The secret is in the path, over https.
 */
export type InboundHookDeps = SchedulerDeps & { db: Db; secretsKey: Buffer };

/** A fresh secret for a bot's inbound URL; the caller stores it encrypted. */
export const newHookSecret = (): string => randomBytes(24).toString("base64url");

const digest = (s: string) => createHash("sha256").update(s).digest();
const same = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

export type HookPayload = { text: string; from?: string; subject?: string };
export type HookResult = { status: number; message?: string; run?: () => Promise<void> };

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

/** The prompt the bot wakes up to; short, so the payload itself is what it reads. */
export function hookPrompt(p: HookPayload): string {
  return [
    "An outside system posted this to your inbound webhook.",
    "Do what it asks. If it is only a notification, reply with what needs attention in a line or two, or \"Nothing to do.\".",
    p.from ? `From: ${p.from}` : "",
    p.subject ? `Subject: ${p.subject}` : "",
    "",
    p.text,
  ].filter((l) => l !== "").join("\n").slice(0, 4000);
}

/** Verifies the URL and the body, then hands back the run to start once the caller has answered 202. */
export async function receiveHook(deps: InboundHookDeps, id: string, secret: string, body: unknown): Promise<HookResult> {
  const [def] = await deps.db.select().from(botDefinitions).where(eq(botDefinitions.id, id));
  // unknown bot, no URL made, or nowhere to answer: nothing for the sender to retry
  if (!def || !def.inboundSecret || !def.inboundChatId || !def.inboundBy) return { status: 404 };
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
  return {
    status: 202,
    run: () =>
      runRoutine(deps, {
        id: `hook-${def.id}`,
        tenantId: def.tenantId,
        chatId: def.inboundChatId!,
        definitionId: def.id,
        createdByPersonId: def.inboundBy!,
        prompt: hookPrompt(payload),
        background: true,
        quiet: false,
        grantPersonId: null,
      }),
  };
}

/** Mounts `POST /hooks/:id/:secret`; an answer is posted as a turn, so the sender never waits for the model. */
export function mountInboundHook(app: Application, deps: InboundHookDeps): void {
  app.post(
    "/hooks/:id/:secret",
    express.json({ limit: "64kb" }),
    express.text({ limit: "64kb", type: ["text/*", "application/x-www-form-urlencoded"] }),
    (req, res) => {
      void receiveHook(deps, req.params.id ?? "", req.params.secret ?? "", req.body)
        .then((r) => {
          res.sendStatus(r.status);
          if (r.run) void r.run().catch((e) => console.error(`inbound hook ${req.params.id}:`, e instanceof Error ? e.message : "error"));
        })
        .catch((e) => {
          console.error(`inbound hook ${req.params.id}:`, e instanceof Error ? e.message : "error");
          res.sendStatus(500);
        });
    },
  );
}
