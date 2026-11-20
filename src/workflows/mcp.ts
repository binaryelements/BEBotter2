import { createSdkMcpServer, tool } from "../engine/mcp.js";
import type { McpServerHandle } from "../engine/mcp.js";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { workflowRuns } from "../db/schema.js";
import { NEEDS_PERSON } from "./graph.js";

// read on every call: a warm engine outlives the turn that built it
type Ctx = { readonly runId: string; readonly nodeId: string; readonly stepStartedAt: string; readonly results: string[]; readonly saves: string[] };

const text = (t: string, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: "text" as const, text: t }] });
const ALWAYS = ["thread_id", "email"];

export function workflowMcpServer(deps: { db: Db }, ctx: Ctx): McpServerHandle {
  return createSdkMcpServer({
    name: "workflow",
    tools: [
      tool(
        "report_result",
        "Report how this workflow step ended. `result` is one of the step's results (or \"needs_person\" when you cannot tell or cannot go on), `reason` says why in a sentence, and `fields` saves named values the later steps need. Call it once, then end the step.",
        { result: z.string(), reason: z.string(), fields: z.record(z.string(), z.string()).optional() },
        async ({ result, reason, fields }) => {
          const allowed = [...ctx.results, NEEDS_PERSON];
          if (!allowed.includes(result)) return text(`Unknown result "${result}". Use one of: ${allowed.join(", ")}.`, true);
          const bad = Object.keys(fields ?? {}).filter((k) => !ALWAYS.includes(k) && !ctx.saves.includes(k));
          if (bad.length) return text(`These fields are not saved by this step: ${bad.join(", ")}. Allowed: ${[...ctx.saves, ...ALWAYS].join(", ")}.`, true);
          const moved = await deps.db.transaction(async (tx) => {
            // locked, so a concurrent merge of keys and fields cannot lose an update
            const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, ctx.runId)).for("update");
            // a turn from an older claim of the same step (its lease ran out and the step was claimed again) must not report for the new one
            if (!run || run.nodeId !== ctx.nodeId || run.status !== "running" || run.stepStartedAt?.toISOString() !== ctx.stepStartedAt) return true;
            const keys = { ...run.keys, threadIds: [...run.keys.threadIds], emails: [...run.keys.emails] };
            const thread = fields?.thread_id?.trim();
            if (thread && !keys.threadIds.includes(thread)) keys.threadIds.push(thread);
            const email = fields?.email?.trim().toLowerCase();
            if (email && !keys.emails.includes(email)) keys.emails.push(email);
            await tx
              .update(workflowRuns)
              .set({ reportedResult: { result, reason, ...(fields ? { fields } : {}) }, fields: { ...run.fields, ...(fields ?? {}) }, keys, updatedAt: new Date() })
              .where(and(eq(workflowRuns.id, ctx.runId), eq(workflowRuns.nodeId, ctx.nodeId), eq(workflowRuns.status, "running"), eq(workflowRuns.stepStartedAt, new Date(ctx.stepStartedAt))));
            return false;
          });
          return moved ? text("This step has moved on", true) : text("Recorded. End the step now.");
        },
      ),
    ],
  });
}
