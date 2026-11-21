// Pure graph rules (no server imports), so the canvas bundles the same checks the server runs at publish.
import type { WorkflowGraph, WorkflowNode } from "./types.js";

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

const dupes = (xs: string[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];

export type Problem = { nodeId?: string; message: string };

/** Everything that stops a graph from being published, each tied to its step when it has one. Shared by the server and the canvas. */
export function graphProblems(g: WorkflowGraph): Problem[] {
  const problems: Problem[] = [];
  const at = (n: WorkflowNode | undefined, message: string) => problems.push(n ? { nodeId: n.id, message } : { message });
  const triggers = g.nodes.filter((n) => n.type === "trigger");
  if (triggers.length !== 1) at(undefined, `Needs exactly one trigger, found ${triggers.length}`);
  const byId = new Map<string, WorkflowNode>();
  for (const n of g.nodes) {
    if (byId.has(n.id)) at(n, `Duplicate step id "${n.id}"`);
    byId.set(n.id, n);
  }
  for (const n of g.nodes) {
    if (!n.label.trim()) at(n, "A step has no label");
    if (n.type === "ai") {
      if (!n.instruction.trim()) at(n, `"${n.label}" has no instruction`);
      if (!n.success.trim()) at(n, `"${n.label}" has no success test`);
      if (n.results.length === 0) at(n, `"${n.label}" has no results`);
      for (const r of n.results) if (!r.name.trim()) at(n, `"${n.label}" has a result with no name`);
      for (const r of n.results) if (r.name === NEEDS_PERSON || r.name === NEW_MESSAGE) at(n, `"${n.label}" has a result named "${r.name}", which is reserved`);
      dupes(n.results.map((r) => r.name)).forEach((d) => at(n, `"${n.label}" has two results named "${d}"`));
    }
    if (n.type !== "end" && !g.edges.some((e) => e.from === n.id)) at(n, `"${n.label}" leads nowhere`);
    if (n.type === "wait" && n.minutes < 1) at(n, `"${n.label}" must wait at least 1 minute`);
    if (n.type === "ask") {
      if (!n.question.trim()) at(n, `"${n.label}" has no question`);
      if (n.choices.length === 0) at(n, `"${n.label}" has no choices`);
      for (const c of n.choices) if (!c.trim()) at(n, `"${n.label}" has a choice with no name`);
      for (const c of n.choices) if (c === "no_answer" || c === NEW_MESSAGE) at(n, `"${n.label}" has a choice named "${c}", which is reserved`);
      dupes(n.choices).forEach((d) => at(n, `"${n.label}" has two choices named "${d}"`));
      if (n.timeoutMinutes < 1) at(n, `"${n.label}" must wait at least 1 minute for an answer`);
    }
  }
  dupes(g.edges.map((e) => `${e.from}\u0000${e.exit}`)).forEach((d) => at(byId.get(d.split("\u0000")[0]), `Two links leave the same exit "${d.split("\u0000")[1]}" of step "${d.split("\u0000")[0]}"`));
  for (const e of g.edges) {
    const from = byId.get(e.from);
    if (!from) at(undefined, `A link starts at unknown step "${e.from}"`);
    else if (!exitsOf(from).includes(e.exit)) at(from, `"${from.label}" has no exit "${e.exit}"`);
    if (!byId.has(e.to)) at(from, `A link goes to unknown step "${e.to}"`);
  }
  if (triggers.length === 1) {
    const seen = new Set<string>([triggers[0].id]);
    const queue = [triggers[0].id];
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      for (const e of g.edges) if (e.from === id && byId.has(e.to) && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
    }
    for (const n of g.nodes) if (!seen.has(n.id)) at(n, `"${n.label}" can't be reached from the trigger`);
  }
  for (const h of g.holidays) if (!/^\d{4}-\d{2}-\d{2}$/.test(h)) at(undefined, `Holiday "${h}" is not YYYY-MM-DD`);
  return problems;
}

export const checkGraph = (g: WorkflowGraph): string[] => graphProblems(g).map((p) => p.message);
