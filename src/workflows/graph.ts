import { z } from "zod";
import { DirectoryError } from "../org/directory.js";
import type { WorkflowGraph, WorkflowNode } from "./types.js";

export type { NodeBase, TriggerNode, AiNode, WaitNode, AskNode, EndNode, WorkflowNode, Edge, WorkflowGraph } from "./types.js";

export const NEEDS_PERSON = "needs_person";
export const NEW_MESSAGE = "new_message";

export function exitsOf(n: WorkflowNode): string[] {
  switch (n.type) {
    case "trigger": return ["next"];
    case "ai": return [...n.results.map((r) => r.name), NEEDS_PERSON, NEW_MESSAGE];
    case "wait": return ["time_up", NEW_MESSAGE];
    case "ask": return [...n.choices, "no_answer", NEW_MESSAGE];
    case "end": return [];
  }
}

export function nextNode(g: WorkflowGraph, nodeId: string, exit: string): string | typeof NEEDS_PERSON {
  return g.edges.find((e) => e.from === nodeId && e.exit === exit)?.to ?? NEEDS_PERSON;
}

const dupes = (xs: string[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];

export function checkGraph(g: WorkflowGraph): string[] {
  const problems: string[] = [];
  const triggers = g.nodes.filter((n) => n.type === "trigger");
  if (triggers.length !== 1) problems.push(`Needs exactly one trigger, found ${triggers.length}`);
  const byId = new Map<string, WorkflowNode>();
  for (const n of g.nodes) {
    if (byId.has(n.id)) problems.push(`Duplicate step id "${n.id}"`);
    byId.set(n.id, n);
  }
  for (const n of g.nodes) {
    if (n.type === "ai") {
      if (n.results.length === 0) problems.push(`"${n.label}" has no results`);
      for (const r of n.results) if (!r.name.trim()) problems.push(`"${n.label}" has a result with no name`);
      for (const r of n.results) if (r.name === NEEDS_PERSON || r.name === NEW_MESSAGE) problems.push(`"${n.label}" has a result named "${r.name}", which is reserved`);
      dupes(n.results.map((r) => r.name)).forEach((d) => problems.push(`"${n.label}" has two results named "${d}"`));
    }
    if (n.type !== "end" && !g.edges.some((e) => e.from === n.id)) problems.push(`"${n.label}" leads nowhere`);
    if (n.type === "wait" && n.minutes < 1) problems.push(`"${n.label}" must wait at least 1 minute`);
    if (n.type === "ask") {
      if (n.choices.length === 0) problems.push(`"${n.label}" has no choices`);
      for (const c of n.choices) if (!c.trim()) problems.push(`"${n.label}" has a choice with no name`);
      for (const c of n.choices) if (c === "no_answer" || c === NEW_MESSAGE) problems.push(`"${n.label}" has a choice named "${c}", which is reserved`);
      dupes(n.choices).forEach((d) => problems.push(`"${n.label}" has two choices named "${d}"`));
      if (n.timeoutMinutes < 1) problems.push(`"${n.label}" must wait at least 1 minute for an answer`);
    }
  }
  dupes(g.edges.map((e) => `${e.from}\u0000${e.exit}`)).forEach((d) => problems.push(`Two links leave the same exit "${d.split("\u0000")[1]}" of step "${d.split("\u0000")[0]}"`));
  for (const e of g.edges) {
    const from = byId.get(e.from);
    if (!from) problems.push(`A link starts at unknown step "${e.from}"`);
    else if (!exitsOf(from).includes(e.exit)) problems.push(`"${from.label}" has no exit "${e.exit}"`);
    if (!byId.has(e.to)) problems.push(`A link goes to unknown step "${e.to}"`);
  }
  if (triggers.length === 1) {
    const seen = new Set<string>([triggers[0].id]);
    const queue = [triggers[0].id];
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      for (const e of g.edges) if (e.from === id && byId.has(e.to) && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
    }
    for (const n of g.nodes) if (!seen.has(n.id)) problems.push(`"${n.label}" can't be reached from the trigger`);
  }
  for (const h of g.holidays) if (!/^\d{4}-\d{2}-\d{2}$/.test(h)) problems.push(`Holiday "${h}" is not YYYY-MM-DD`);
  return problems;
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
