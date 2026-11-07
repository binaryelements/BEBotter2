import { eq } from "drizzle-orm";
import { createSdkMcpServer, tool } from "../engine/mcp.js";
import type { McpServerHandle } from "../engine/mcp.js";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { departmentMembers } from "../db/schema.js";
import { rememberMemory, searchMemory, touchMemory } from "../memory/store.js";
import { DirectoryError } from "../org/directory.js";
import { addLearning, deleteLearning, listLearnings, updateLearning } from "./store.js";

type Ctx = { tenantId: string; definitionId: string; chatId: string; personId: string };

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (e: unknown) => {
  if (!(e instanceof DirectoryError)) console.error("learning tool failed", e instanceof Error ? e.message : e);
  return { isError: true, content: [{ type: "text" as const, text: e instanceof DirectoryError ? e.message : "Learning error" }] };
};

/** personal: a Personal assistant, whose learnings belong to the person it works for. */
export function learningsMcpServer(deps: { db: Db }, ctx: Ctx, personal: boolean): McpServerHandle {
  const owner = () => (personal ? ctx.personId : null);
  // a chat changes only learnings it can see: on Personal, never another person's
  const visible = async (id: string) => {
    if (!(await listLearnings(deps.db, ctx.tenantId, ctx.definitionId, owner())).some((l) => l.id === id)) throw new DirectoryError("No such learning");
  };
  const whom = personal ? "the person you work for, in all their chats" : "everyone who uses you, in every chat";
  return createSdkMcpServer({
    name: "learnings",
    tools: [
      tool(
        "learn",
        `Save a teaching. Whenever someone tells you how to do something, what to say, what to call something, or corrects you, save it as one short instruction in your own words, e.g. "Call scheduled runs reminders". It applies at once to ${whom}. Do not save one-off details of a single task, or anything private. Say briefly that you will remember it.`,
        { text: z.string() },
        async ({ text }) => {
          try {
            const l = await addLearning(deps.db, ctx.tenantId, { definitionId: ctx.definitionId, text, taughtByPersonId: ctx.personId, chatId: ctx.chatId, ownerPersonId: owner() });
            return ok(`Saved as ${l.id}`);
          } catch (e) {
            return fail(e);
          }
        },
      ),
      tool(
        "remember",
        "Save a detailed fact, procedure or preference to long-term memory. It is retrieved when relevant, so it does not crowd every message. Use `learn` only for a short rule that must always apply.",
        { text: z.string(), kind: z.enum(["fact", "rule", "procedure", "preference"]).optional(), importance: z.number().int().min(1).max(5).optional() },
        async ({ text, kind, importance }) => {
          try {
            const m = await rememberMemory(deps.db, { tenantId: ctx.tenantId, definitionId: ctx.definitionId, ownerPersonId: owner(), text, kind, importance, source: "taught" });
            return ok(`Remembered as ${m.id}`);
          } catch (e) {
            return fail(e);
          }
        },
      ),
      tool(
        "recall",
        "Search long-term memory for facts, procedures or preferences relevant to a question. Use it when you need something you were not given automatically.",
        { query: z.string(), limit: z.number().int().min(1).max(20).optional() },
        async ({ query, limit }) => {
          try {
            const departments = (
              await deps.db.select({ id: departmentMembers.departmentId }).from(departmentMembers).where(eq(departmentMembers.personId, ctx.personId))
            ).map((r) => r.id);
            const rows = await searchMemory(
              deps.db,
              { tenantId: ctx.tenantId, definitionId: ctx.definitionId, ownerPersonId: owner(), departmentIds: departments, chatId: ctx.chatId },
              query,
              limit ?? 10,
            );
            if (!rows.length) return ok("Nothing relevant in long-term memory.");
            await touchMemory(deps.db, rows.map((r) => r.id));
            return ok(rows.map((r) => `${r.id} | ${r.kind} | importance ${r.importance} | ${r.text}`).join("\n"));
          } catch (e) {
            return fail(e);
          }
        },
      ),
      tool("learnings", "List what you have been taught, with ids, for when someone asks what you have learnt or wants to change it.", {}, async () => {
        try {
          const rows = await listLearnings(deps.db, ctx.tenantId, ctx.definitionId, owner());
          return ok(rows.length ? rows.map((l) => `${l.id} | ${l.createdAt.toISOString().slice(0, 10)} | ${l.text}`).join("\n") : "Nothing learnt yet");
        } catch (e) {
          return fail(e);
        }
      }),
      tool("update_learning", "Reword a learning, by the id `learnings` lists, when someone corrects or refines it.", { id: z.string(), text: z.string() }, async ({ id, text }) => {
        try {
          await visible(id);
          await updateLearning(deps.db, ctx.tenantId, ctx.definitionId, id, text);
          return ok("Updated");
        } catch (e) {
          return fail(e);
        }
      }),
      tool("forget", "Remove a learning, by the id `learnings` lists, when someone says it is wrong or no longer applies.", { id: z.string() }, async ({ id }) => {
        try {
          await visible(id);
          await deleteLearning(deps.db, ctx.tenantId, ctx.definitionId, id);
          return ok("Forgotten");
        } catch (e) {
          return fail(e);
        }
      }),
    ],
  });
}
