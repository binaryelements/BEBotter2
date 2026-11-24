// Pure canvas model (no React). Exits and publish checks come from the server's own rules, bundled in.
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
  if (nodes.find((n) => n.id === c.source)?.type === "end") return "nothing leaves End";
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

// Lays the steps out left to right with ELK, which keeps each step's exits in their order so fewer links cross.
// elk is an ELK instance (fetched on first use in the browser). Only positions change; sizes are the rendered ones when known.
export async function tidy(nodes, edges, elk) {
  const ports = new Set();
  const children = nodes.map((n) => {
    const exits = EXITS(n.data).map((x, i) => ({ id: `${n.id}>${x}`, layoutOptions: { "elk.port.side": "EAST", "elk.port.index": String(i) } }));
    for (const p of [`${n.id}>in`, ...exits.map((p) => p.id)]) ports.add(p);
    return { id: n.id, width: n.measured?.width ?? 210, height: n.measured?.height ?? 60, layoutOptions: { "elk.portConstraints": "FIXED_ORDER" },
      ports: [{ id: `${n.id}>in`, layoutOptions: { "elk.port.side": "WEST" } }, ...exits] };
  });
  const links = edges
    .map((e) => ({ id: e.id, sources: [`${e.source}>${e.sourceHandle}`], targets: [`${e.target}>in`] }))
    .filter((e) => ports.has(e.sources[0]) && ports.has(e.targets[0]));
  const out = await elk.layout({
    id: "root",
    layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.spacing.nodeNode": "24", "elk.layered.spacing.nodeNodeBetweenLayers": "56",
      // loops back (a reply restarts the chase) are reversed from the trigger outwards, so the flow reads from the trigger
      "elk.layered.cycleBreaking.strategy": "DEPTH_FIRST" },
    children, edges: links,
  });
  const at = new Map(out.children.map((c) => [c.id, c]));
  return nodes.map((n) => ({ ...n, position: { x: Math.round(at.get(n.id).x), y: Math.round(at.get(n.id).y) } }));
}
