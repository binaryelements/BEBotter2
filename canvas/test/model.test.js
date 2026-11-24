import { describe, expect, it } from "vitest";
import { exitsOf } from "../../src/workflows/graph.ts";
import { EXITS, newNode, openExits, relink, tidy, toFlow, toGraph, whyNot } from "../src/model.js";

const node = (type, id, extra) => ({ id, label: id, x: 10, y: 20, type, ...extra });
const nodes = [
  node("trigger", "t", { trigger: "email" }),
  node("ai", "a", { instruction: "i", success: "s", results: [{ name: "ok", meaning: "m" }, { name: "bad", meaning: "n" }] }),
  node("wait", "w", { minutes: 60, businessHours: false }),
  node("ask", "q", { question: "?", choices: ["yes", "no"], timeoutMinutes: 5 }),
  node("end", "e", { outcome: "done" }),
];
const graph = {
  nodes,
  edges: [
    { from: "t", exit: "next", to: "a" },
    { from: "a", exit: "ok", to: "w" },
    { from: "w", exit: "time_up", to: "q" },
    { from: "q", exit: "yes", to: "e" },
  ],
  holidays: ["2026-12-25"],
};

describe("canvas model", () => {
  it("round-trips a graph", () => {
    const { nodes: n, edges: e } = toFlow(graph);
    expect(e[0]).toEqual({ id: "t:next", source: "t", sourceHandle: "next", target: "a" });
    expect(n[1]).toMatchObject({ id: "a", type: "ai", position: { x: 10, y: 20 } });
    expect(toGraph(n, e, graph.holidays)).toEqual(graph);
    n[0].position = { x: 1.6, y: 2.4 };
    expect(toGraph(n, e, []).nodes[0]).toMatchObject({ x: 2, y: 2 });
  });

  it("EXITS matches exitsOf for every node type", () => {
    for (const n of nodes) expect(EXITS(n)).toEqual(exitsOf(n));
    expect(EXITS(nodes[4])).toEqual([]);
  });

  it("openExits lists unlinked exits but not new_message", () => {
    const open = openExits(graph);
    expect(open).toContainEqual({ nodeId: "a", exit: "bad" });
    expect(open).toContainEqual({ nodeId: "a", exit: "needs_person" });
    expect(open).not.toContainEqual({ nodeId: "a", exit: "ok" });
    expect(open.some((o) => o.exit === "new_message")).toBe(false);
  });

  it("whyNot refuses bad links", () => {
    const { nodes: n, edges: e } = toFlow(graph);
    expect(whyNot({ source: "a", sourceHandle: "bad", target: "t" }, n, e)).toBe("nothing links into the trigger");
    expect(whyNot({ source: "a", sourceHandle: "ok", target: "e" }, n, e)).toBe("that exit is already linked");
    expect(whyNot({ source: "e", sourceHandle: "x", target: "w" }, n, e)).toBe("nothing leaves End");
    expect(whyNot({ source: "a", sourceHandle: "bad", target: "e" }, n, e)).toBeNull();
  });

  it("newNode has defaults", () => {
    const n = newNode("ai", { x: 1, y: 2 });
    expect(n).toMatchObject({ type: "ai", x: 1, y: 2, label: "ai step", instruction: "", success: "", results: [{ name: "done", meaning: "" }] });
    expect(n.id).toMatch(/^ai_/);
    expect(newNode("ask", { x: 0, y: 0 })).toMatchObject({ choices: ["yes", "no"], timeoutMinutes: 480 });
    expect(newNode("wait", { x: 0, y: 0 })).toMatchObject({ minutes: 480, businessHours: true });
    expect(newNode("end", { x: 0, y: 0 }).outcome).toBe("");
    expect(newNode("trigger", { x: 0, y: 0 }).trigger).toBe("email");
  });

  it("relink follows a renamed exit and drops a removed one", () => {
    const { edges } = toFlow(graph);
    const renamed = relink(edges, "a", ["fine", "bad", "needs_person", "new_message"], { ok: "fine" });
    expect(renamed).toContainEqual({ id: "a:fine", source: "a", sourceHandle: "fine", target: "w" });
    expect(renamed).toHaveLength(4);
    expect(relink(edges, "a", ["bad", "needs_person", "new_message"])).toHaveLength(3);
    expect(relink(edges, "a", ["bad", "needs_person", "new_message"]).some((e) => e.source === "a")).toBe(false);
  });
});

describe("tidy", () => {
  it("lays the steps out left to right along the links and changes nothing else", () => {
    const { nodes: ns, edges: es } = toFlow(graph);
    const out = tidy(ns, es);
    const x = Object.fromEntries(out.map((n) => [n.id, n.position.x]));
    expect(x.t).toBeLessThan(x.a);
    expect(x.a).toBeLessThan(x.w);
    expect(x.w).toBeLessThan(x.q);
    expect(x.q).toBeLessThan(x.e);
    expect(out.map((n) => n.data)).toEqual(ns.map((n) => n.data));
    expect(toGraph(out, es, []).edges).toEqual(graph.edges);
  });
});
