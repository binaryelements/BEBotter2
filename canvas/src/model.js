// Pure canvas model (no React). Exits and publish checks come from the server's own rules, bundled in.
import { graphlib, layout } from "@dagrejs/dagre";
import { exitsOf, graphProblems } from "../../src/workflows/check.ts";

export const EXITS = exitsOf;
export { graphProblems };

export const toFlow = (g) => ({
  nodes: g.nodes.map((n) => ({ id: n.id, type: n.type, position: { x: n.x, y: n.y }, data: n })),
  edges: g.edges.map((e) => ({ id: `${e.from}:${e.exit}`, source: e.from, sourceHandle: e.exit, target: e.to })),
});

export const toGraph = (nodes, edges, holidays) => ({
  nodes: nodes.map((n) => ({ ...n.data, x: Math.round(n.position.x), y: Math.round(n.position.y) })),
  edges: edges.map((e) => ({ from: e.source, exit: e.sourceHandle, to: e.target })),
  holidays,
});

// Open new_message exits go to a person by design, so they are not listed.
export const openExits = (g) =>
  g.nodes.flatMap((n) => EXITS(n)
    .filter((exit) => exit !== "new_message" && !g.edges.some((e) => e.from === n.id && e.exit === exit))
    .map((exit) => ({ nodeId: n.id, exit })));

export function whyNot(c, nodes, edges) {
  if (nodes.find((n) => n.id === c.target)?.type === "trigger") return "nothing links into the trigger";
  if (edges.some((e) => e.source === c.source && e.sourceHandle === c.sourceHandle)) return "that exit is already linked";
  return null;
}

let seq = 0;
export const uid = (prefix) => `${prefix}_${Date.now().toString(36)}${(++seq).toString(36)}`;

export const NAMES = { trigger: "trigger", ai: "ai step", wait: "wait", ask: "ask a person", end: "end" };
const DEFAULTS = {
  trigger: () => ({ trigger: "email" }),
  ai: () => ({ instruction: "", success: "", results: [{ name: "done", meaning: "" }] }),
  wait: () => ({ minutes: 480, businessHours: true }),
  ask: () => ({ question: "", choices: ["yes", "no"], timeoutMinutes: 480 }),
  end: () => ({ outcome: "" }),
};
export const newNode = (type, { x, y }) => ({ id: uid(type), type, label: NAMES[type], x, y, ...DEFAULTS[type]() });

// After a step's exits change: links on a renamed exit follow it (renamed maps old exit -> new), links on removed exits go.
export function relink(edges, id, exits, renamed = {}) {
  return edges
    .map((e) => (e.source === id && renamed[e.sourceHandle] !== undefined ? { ...e, id: `${id}:${renamed[e.sourceHandle]}`, sourceHandle: renamed[e.sourceHandle] } : e))
    .filter((e) => e.source !== id || exits.includes(e.sourceHandle));
}

// Lays the steps out left to right in columns that follow the links. Only positions change; sizes are the rendered ones when known.
export function tidy(nodes, edges) {
  const g = new graphlib.Graph().setGraph({ rankdir: "LR", nodesep: 24, ranksep: 56 }).setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: n.measured?.width ?? 210, height: n.measured?.height ?? 60 });
  for (const e of edges) g.setEdge(e.source, e.target);
  layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return { ...n, position: { x: Math.round(p.x - p.width / 2), y: Math.round(p.y - p.height / 2) } };
  });
}
