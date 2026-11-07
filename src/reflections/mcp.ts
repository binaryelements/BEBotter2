import { and, asc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { auditEvents, chats, people, sessions } from "../db/schema.js";
import type { EngineMessage } from "../engine/engine.js";
import { createSdkMcpServer, tool } from "../engine/mcp.js";
import type { McpServerHandle } from "../engine/mcp.js";
import { listLearnings } from "../learnings/store.js";
import { DirectoryError } from "../org/directory.js";
import { applyLearningAction, createProposal, dayInZone } from "./store.js";
import type { LearningAction, ReflectionMode } from "./store.js";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (e: unknown) => {
  if (!(e instanceof DirectoryError)) console.error("reflection tool failed", e instanceof Error ? e.message : e);
  return { isError: true, content: [{ type: "text" as const, text: e instanceof DirectoryError ? e.message : "Reflection error" }] };
};

const MAX_OUTPUT = 24_000;
const cut = (s: string, n = MAX_OUTPUT) => (s.length <= n ? s : `${s.slice(0, n)}\n… (truncated)`);
const clock = (d: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

export type ReflectionResult = {
  summary: string;
  wentWell?: string;
  wentWrong?: string;
  corrections?: string;
  willDo?: string;
};

export type ReflectionCtx = {
  tenantId: string;
  definitionId: string;
  ownerPersonId: string | null;
  day: string;
  timeZone: string;
  /** The moment the reflection runs; the activity lookback is measured from it. */
  now: Date;
  mode: Exclude<ReflectionMode, "off">;
  reflectionId: string;
  defaultChatId: string | null;
  /** The person a learning is attributed to: the approving admin, or the tenant's first admin in auto mode. */
  authorPersonId: string;
  post?: (text: string) => Promise<void>;
  /** Set when the auto-mode post went out, so the runner does not post a second one. */
  posted?: boolean;
  /** Set by `finish`; the runner saves it after the turn. */
  result?: ReflectionResult;
};

const transcript = (messages: EngineMessage[]): string => {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "user") lines.push(`Person: ${m.text}`);
    else if (m.role === "assistant") {
      if (m.text) lines.push(`Bot: ${m.text}`);
      for (const c of m.toolCalls ?? []) lines.push(`Bot called ${c.name} ${JSON.stringify(c.input).slice(0, 300)}`);
    } else lines.push(`Tool result: ${m.text.slice(0, 500)}`);
  }
  return lines.join("\n");
};

/** The tools the daily reflection uses: read the day, read the chat, read and change its learnings, post, finish. */
export function reflectionMcpServer(deps: { db: Db }, ctx: ReflectionCtx): McpServerHandle {
  const owner = ctx.ownerPersonId;
  const visible = async () => listLearnings(deps.db, ctx.tenantId, ctx.definitionId, owner);
  const owned = async (id: string) => {
    if (!(await visible()).some((l) => l.id === id)) throw new DirectoryError("No such learning");
  };
  const write = async (action: LearningAction, input: { learningId?: string; text?: string; reason?: string }) => {
    if (ctx.mode === "propose") {
      await createProposal(deps.db, {
        tenantId: ctx.tenantId,
        definitionId: ctx.definitionId,
        ownerPersonId: owner,
        reflectionId: ctx.reflectionId,
        action,
        learningId: input.learningId ?? null,
        text: input.text ?? null,
        reason: input.reason ?? null,
      });
      return "Proposed; an admin will review it.";
    }
    await applyLearningAction(deps.db, {
      tenantId: ctx.tenantId,
      definitionId: ctx.definitionId,
      ownerPersonId: owner,
      action,
      learningId: input.learningId ?? null,
      text: input.text ?? null,
      personId: ctx.authorPersonId,
    });
    return "Applied.";
  };

  const tools = [
    tool(
      "activity",
      "List this bot's recorded activity for the day being reviewed: messages, tool calls, denials and failures, with the person and chat. Use it first to see what happened.",
      {},
      async () => {
        try {
          const since = new Date(ctx.now.getTime() - 3 * 86_400_000);
          const rows = await deps.db
            .select({
              at: auditEvents.startedAt,
              kind: auditEvents.kind,
              toolName: auditEvents.toolName,
              summary: auditEvents.summary,
              status: auditEvents.status,
              chatId: auditEvents.chatId,
              person: people.name,
            })
            .from(auditEvents)
            .leftJoin(people, eq(people.id, auditEvents.personId))
            .where(
              and(
                eq(auditEvents.tenantId, ctx.tenantId),
                eq(auditEvents.definitionId, ctx.definitionId),
                gte(auditEvents.startedAt, since),
                owner ? eq(auditEvents.personId, owner) : undefined,
              ),
            )
            .orderBy(asc(auditEvents.startedAt))
            .limit(500);
          const day = rows.filter((r) => dayInZone(r.at, ctx.timeZone) === ctx.day);
          if (!day.length) return ok("No activity recorded for this day.");
          const lines = day.map((r) => {
            const who = r.person ?? "someone";
            const what = r.kind === "tool" ? `tool ${r.toolName ?? "?"}` : "message";
            return `${clock(r.at, ctx.timeZone)} | ${who} | ${what} | ${r.status} | chat ${r.chatId ?? "-"} | ${r.summary}`;
          });
          return ok(cut(`${day.length} rows for ${ctx.day}:\n${lines.join("\n")}`));
        } catch (e) {
          return fail(e);
        }
      },
    ),
    tool(
      "conversation",
      "Read the current transcript of one chat, so you can see what the person said and where they corrected the bot. Omit chatId to list the chats with activity today.",
      { chatId: z.string().optional() },
      async ({ chatId }) => {
        try {
          if (!chatId) {
            const since = new Date(ctx.now.getTime() - 3 * 86_400_000);
            const rows = await deps.db
              .select({ chatId: auditEvents.chatId, label: chats.label, type: chats.conversationType })
              .from(auditEvents)
              .leftJoin(chats, eq(chats.id, auditEvents.chatId))
              .where(
                and(
                  eq(auditEvents.tenantId, ctx.tenantId),
                  eq(auditEvents.definitionId, ctx.definitionId),
                  gte(auditEvents.startedAt, since),
                  owner ? eq(auditEvents.personId, owner) : undefined,
                ),
              )
              .groupBy(auditEvents.chatId, chats.label, chats.conversationType);
            const today = rows.filter((r) => r.chatId);
            return ok(today.length ? today.map((r) => `${r.chatId} | ${r.type ?? "chat"} | ${r.label ?? ""}`).join("\n") : "No chats with activity today.");
          }
          const [chat] = await deps.db.select().from(chats).where(and(eq(chats.id, chatId), eq(chats.tenantId, ctx.tenantId)));
          if (!chat) throw new DirectoryError("No such chat");
          if (owner && chat.ownerPersonId !== owner) throw new DirectoryError("That chat is not this person's");
          const [session] = await deps.db
            .select({ messages: sessions.messages, summary: sessions.summary })
            .from(sessions)
            .where(and(eq(sessions.chatId, chatId), eq(sessions.definitionId, ctx.definitionId)));
          if (!session) return ok("No transcript stored for that chat.");
          const messages = (session.messages ?? []).slice(-60);
          const text = transcript(messages);
          return ok(cut(`${session.summary ? `Earlier summary:\n${session.summary}\n\n` : ""}${text || "The transcript is empty."}`));
        } catch (e) {
          return fail(e);
        }
      },
    ),
    tool("learnings", "List the bot's current learnings, with ids, so you can correct or remove one instead of adding a duplicate.", {}, async () => {
      try {
        const rows = await visible();
        return ok(rows.length ? rows.map((l) => `${l.id} | ${l.text}`).join("\n") : "Nothing learnt yet.");
      } catch (e) {
        return fail(e);
      }
    }),
    tool(
      "learn",
      "Save one short, durable instruction the bot should follow from now on. Use it for a correction or a preference that will still be true next week. Do not save one-off task details or anything private.",
      { text: z.string() },
      async ({ text }) => {
        try {
          const t = text.trim();
          if (!t) throw new DirectoryError("A learning needs some text");
          if (t.length > 1_000) throw new DirectoryError("A learning is at most 1000 characters");
          return ok(await write("add", { text: t }));
        } catch (e) {
          return fail(e);
        }
      },
    ),
    tool(
      "update_learning",
      "Reword an existing learning, by the id `learnings` lists, when the day shows it was wrong or incomplete.",
      { id: z.string(), text: z.string() },
      async ({ id, text }) => {
        try {
          await owned(id);
          const t = text.trim();
          if (!t) throw new DirectoryError("An updated learning needs text");
          if (t.length > 1_000) throw new DirectoryError("A learning is at most 1000 characters");
          return ok(await write("update", { learningId: id, text: t }));
        } catch (e) {
          return fail(e);
        }
      },
    ),
    tool("forget", "Remove an existing learning, by the id `learnings` lists, when the day shows it is wrong or no longer applies.", { id: z.string(), reason: z.string().optional() }, async ({ id, reason }) => {
      try {
        await owned(id);
        return ok(await write("remove", { learningId: id, reason }));
      } catch (e) {
        return fail(e);
      }
    }),
    ...(ctx.mode === "auto" && ctx.defaultChatId && ctx.post
      ? [
          tool("post", "Post a short message to the default group: what the bot learnt today and what it will do differently. Use it once, after the learnings are saved.", { text: z.string() }, async ({ text }) => {
            try {
              const t = text.trim();
              if (!t) throw new DirectoryError("A post needs some text");
              await ctx.post!(t.slice(0, 4_000));
              ctx.posted = true;
              return ok("Posted.");
            } catch (e) {
              return fail(e);
            }
          }),
        ]
      : []),
    tool(
      "finish",
      "Finish the reflection. Give the day's summary, what went well, what went wrong, what the person corrected, and what the bot will do differently. Call it once, last.",
      { summary: z.string(), wentWell: z.string().optional(), wentWrong: z.string().optional(), corrections: z.string().optional(), willDo: z.string().optional() },
      async ({ summary, wentWell, wentWrong, corrections, willDo }) => {
        try {
          const s = summary.trim();
          if (!s) throw new DirectoryError("A reflection needs a summary");
          ctx.result = { summary: s, wentWell, wentWrong, corrections, willDo };
          return ok("Reflection saved.");
        } catch (e) {
          return fail(e);
        }
      },
    ),
  ];
  return createSdkMcpServer({ name: "reflection", tools });
}
