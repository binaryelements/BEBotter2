import { z } from "zod";
import { DirectoryError } from "../org/directory.js";
import type { WorkflowGraph, WorkflowNode } from "./types.js";

export type { NodeBase, TriggerNode, AiNode, WaitNode, AskNode, EndNode, WorkflowNode, Edge, WorkflowGraph } from "./types.js";

export { NEEDS_PERSON, NEW_MESSAGE, exitsOf, checkGraph, graphProblems } from "./check.js";
export type { Problem } from "./check.js";
import { NEEDS_PERSON } from "./check.js";

export function nextNode(g: WorkflowGraph, nodeId: string, exit: string): string | typeof NEEDS_PERSON {
  return g.edges.find((e) => e.from === nodeId && e.exit === exit)?.to ?? NEEDS_PERSON;
}

const base = { id: z.string(), label: z.string(), x: z.number(), y: z.number() };
const node = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("trigger"), trigger: z.enum(["email", "manual"]), fields: z.array(z.string()).optional() }),
  z.object({
    ...base, type: z.literal("ai"), instruction: z.string(), success: z.string(),
    results: z.array(z.object({ name: z.string(), meaning: z.string() })),
    saves: z.array(z.string()).optional(),
  }),
  z.object({ ...base, type: z.literal("wait"), minutes: z.number(), businessHours: z.boolean() }),
  z.object({ ...base, type: z.literal("ask"), question: z.string(), choices: z.array(z.string()), personId: z.string().optional(), timeoutMinutes: z.number() }),
  z.object({ ...base, type: z.literal("end"), outcome: z.string() }),
]);
const graphSchema = z.object({
  nodes: z.array(node),
  edges: z.array(z.object({ from: z.string(), exit: z.string(), to: z.string() })),
  holidays: z.array(z.string()),
});

export function parseGraph(x: unknown): WorkflowGraph {
  const r = graphSchema.safeParse(x);
  if (!r.success) throw new DirectoryError(`Invalid workflow: ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}`);
  return r.data;
}
