import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { DirectoryError } from "../org/directory.js";
import { createRoutine } from "./store.js";

type Ctx = { tenantId: string; definitionId: string; chatId: string; personId: string; post?: (text: string) => Promise<void> };

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (e: unknown) => {
  if (!(e instanceof DirectoryError)) console.error("routine tool failed", e instanceof Error ? e.message : e);
  return { isError: true, content: [{ type: "text" as const, text: e instanceof DirectoryError ? e.message : "Routine error" }] };
};
const OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_AHEAD_MS = 366 * 24 * 3600_000;

export function routineMcpServer(deps: { db: Db }, ctx: Ctx): McpSdkServerConfigWithInstance {
  const tools = [
    tool(
      "remind",
      "Schedule a one-off reminder for yourself in this chat. `at` is an ISO 8601 date-time with an explicit offset or Z, in the future and at most 366 days ahead. `prompt` is what you will be asked to do then.",
      { at: z.string(), prompt: z.string() },
      async ({ at, prompt }) => {
        try {
          const runAt = new Date(at);
          if (!OFFSET.test(at) || Number.isNaN(runAt.getTime())) throw new DirectoryError("`at` must be an ISO 8601 date-time with an offset or Z");
          if (runAt.getTime() > Date.now() + MAX_AHEAD_MS) throw new DirectoryError("`at` is more than 366 days ahead");
          await createRoutine(deps.db, ctx.tenantId, { definitionId: ctx.definitionId, chatId: ctx.chatId, prompt, runAt, createdByPersonId: ctx.personId });
          return ok(`Reminder set for ${runAt.toISOString()}`);
        } catch (e) {
          return fail(e);
        }
      },
    ),
    ...(ctx.post
      ? [
          tool("post", "Post a message to the chat for this routine run.", { text: z.string() }, async ({ text }) => {
            try {
              await ctx.post!(text);
              return ok("Posted");
            } catch (e) {
              return fail(e);
            }
          }),
        ]
      : []),
  ];
  return createSdkMcpServer({ name: "routine", tools });
}
