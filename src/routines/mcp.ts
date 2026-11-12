import { createSdkMcpServer, tool } from "../engine/mcp.js";
import type { McpServerHandle } from "../engine/mcp.js";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { DirectoryError } from "../org/directory.js";
import { createRoutine, deleteRoutine, listRoutines } from "./store.js";

type Ctx = { tenantId: string; definitionId: string; chatId: string; personId: string; post?: (text: string) => Promise<void> };

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (e: unknown) => {
  if (!(e instanceof DirectoryError)) console.error("routine tool failed", e instanceof Error ? e.message : e);
  return { isError: true, content: [{ type: "text" as const, text: e instanceof DirectoryError ? e.message : "Routine error" }] };
};
const OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_PENDING = 50;
const MAX_BACKGROUND = 3;
const MAX_SCHEDULES = 10;
const MAX_AHEAD_MS = 366 * 24 * 3600_000;

export function routineMcpServer(deps: { db: Db }, ctx: Ctx): McpServerHandle {
  const pendingHere = async () =>
    (await listRoutines(deps.db, ctx.tenantId, ctx.definitionId)).filter((r) => r.chatId === ctx.chatId && r.enabled && r.schedule === null);
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
          const pending = (await listRoutines(deps.db, ctx.tenantId, ctx.definitionId)).filter((r) => r.chatId === ctx.chatId && r.enabled && r.schedule === null);
          if (pending.length >= MAX_PENDING) throw new DirectoryError(`This chat already has ${MAX_PENDING} pending reminders`);
          await createRoutine(deps.db, ctx.tenantId, { definitionId: ctx.definitionId, chatId: ctx.chatId, prompt, runAt, createdByPersonId: ctx.personId });
          return ok(`Reminder set for ${runAt.toISOString()}`);
        } catch (e) {
          return fail(e);
        }
      },
    ),
    tool(
      "schedule",
      "Create a recurring routine in this chat: `prompt` is what you are asked to do each time and `schedule` is a cron expression in the company's time zone (five fields: minute hour day month weekday, e.g. \"0 7 * * *\" for 7am every day, \"*/30 * * * *\" every half hour). It runs unattended, with nobody to answer a confirmation, so schedule only work that needs no approval: checks, reads and reports. A write during a run is denied. Tell the person what you scheduled and when it first runs, and that an admin can change or remove it on the admin site.",
      { schedule: z.string(), prompt: z.string(), quiet: z.boolean().optional() },
      async ({ schedule, prompt, quiet }) => {
        try {
          const mine = (await listRoutines(deps.db, ctx.tenantId, ctx.definitionId)).filter((r) => r.chatId === ctx.chatId && r.enabled && r.schedule !== null);
          if (mine.length >= MAX_SCHEDULES) throw new DirectoryError(`This chat already has ${MAX_SCHEDULES} recurring routines`);
          const r = await createRoutine(deps.db, ctx.tenantId, { definitionId: ctx.definitionId, chatId: ctx.chatId, prompt, schedule, quiet: quiet ?? false, createdByPersonId: ctx.personId });
          return ok(`Recurring routine ${r.id} saved (${schedule}). ${r.runAt ? `Next run ${r.runAt.toISOString()}.` : ""}`);
        } catch (e) {
          return fail(e);
        }
      },
    ),
    tool("reminders", "List the reminders, background jobs and recurring routines in this chat, with their ids.", {}, async () => {
      try {
        const waiting = (await listRoutines(deps.db, ctx.tenantId, ctx.definitionId)).filter((r) => r.chatId === ctx.chatId && r.enabled);
        if (!waiting.length) return ok("Nothing is waiting in this chat");
        return ok(waiting.map((r) => `${r.id} | ${r.schedule ? `every ${r.schedule}` : (r.runAt?.toISOString() ?? "")} | ${r.background ? "background job" : r.schedule ? "recurring" : "reminder"} | ${r.prompt.slice(0, 200)}`).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }),
    tool("cancel_reminder", "Cancel a reminder, background job or recurring routine in this chat, by the id `reminders` lists. Nothing from another chat can be cancelled.", { id: z.string() }, async ({ id }) => {
      try {
        // only something of this chat's: another chat's reminders and routines are not this chat's to cancel
        const mine = (await listRoutines(deps.db, ctx.tenantId, ctx.definitionId)).filter((r) => r.chatId === ctx.chatId && r.enabled).some((r) => r.id === id);
        if (!mine) throw new DirectoryError("No such reminder in this chat");
        await deleteRoutine(deps.db, ctx.tenantId, id);
        return ok("Cancelled");
      } catch (e) {
        return fail(e);
      }
    }),
    // offered in a chat only: a job starting jobs could fan out without anyone watching
    ...(ctx.post
      ? []
      : [
          tool(
            "background",
            "Start a job now that runs on its own while this chat carries on, and posts its results here when it is done. Decide before you start working: anything likely to take more than a minute (comparing several websites, finding the cheapest, research across many pages) goes here straight away instead of into your reply. The job does not see this chat, so `task` must say everything it needs: dates, places, what to compare, how to report, and every preference the person has given in this chat. Then tell the person it will take a few minutes, that you have started it, and that the results will be posted here.",
            { task: z.string() },
            async ({ task }) => {
              try {
                const waiting = (await listRoutines(deps.db, ctx.tenantId, ctx.definitionId)).filter((r) => r.chatId === ctx.chatId && r.enabled && r.background);
                if (waiting.length >= MAX_BACKGROUND) throw new DirectoryError(`This chat already has ${MAX_BACKGROUND} background jobs waiting`);
                // a second ahead: a run time must be in the future; the scheduler picks it up on its next tick
                await createRoutine(deps.db, ctx.tenantId, { definitionId: ctx.definitionId, chatId: ctx.chatId, prompt: task, runAt: new Date(Date.now() + 1000), background: true, createdByPersonId: ctx.personId });
                return ok("Started; its results will be posted in this chat");
              } catch (e) {
                return fail(e);
              }
            },
          ),
        ]),
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
