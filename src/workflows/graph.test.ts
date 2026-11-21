import { describe, expect, it } from "vitest";
import { checkGraph, exitsOf, nextNode, parseGraph, type AiNode, type WorkflowGraph, type WorkflowNode } from "./graph.js";

const b = { label: "x", x: 0, y: 0 };
const trigger: WorkflowNode = { ...b, id: "t", type: "trigger", trigger: "email" };
const ai: AiNode = { ...b, id: "a", type: "ai", instruction: "do", success: "ok", results: [{ name: "done", meaning: "done" }] };
const wait: WorkflowNode = { ...b, id: "w", type: "wait", minutes: 5, businessHours: false };
const ask: WorkflowNode = { ...b, id: "k", type: "ask", question: "q", choices: ["yes", "no"], timeoutMinutes: 10 };
const end: WorkflowNode = { ...b, id: "e", type: "end", outcome: "fin" };
const valid = (): WorkflowGraph => ({
  nodes: [trigger, { ...ai }, wait, end],
  edges: [
    { from: "t", exit: "next", to: "a" },
    { from: "a", exit: "done", to: "w" },
    { from: "w", exit: "time_up", to: "e" },
  ],
  holidays: ["2026-12-25"],
});

describe("exitsOf", () => {
  it("lists exits per type", () => {
    expect(exitsOf(trigger)).toEqual(["next"]);
    expect(exitsOf(ai)).toEqual(["done", "needs_person", "new_message"]);
    expect(exitsOf(wait)).toEqual(["time_up", "new_message"]);
    expect(exitsOf(ask)).toEqual(["yes", "no", "no_answer", "new_message"]);
    expect(exitsOf(end)).toEqual([]);
  });
});

describe("nextNode", () => {
  it("follows an edge, else needs_person", () => {
    expect(nextNode(valid(), "t", "next")).toBe("a");
    expect(nextNode(valid(), "a", "new_message")).toBe("needs_person");
  });
});

describe("checkGraph", () => {
  it("accepts a valid graph", () => expect(checkGraph(valid())).toEqual([]));
  it("flags two triggers", () => {
    const g = valid();
    g.nodes.push({ ...trigger, id: "t2" });
    g.edges.push({ from: "t2", exit: "next", to: "e" });
    expect(checkGraph(g)).toHaveLength(1);
  });
  it("flags an edge to a missing node", () => {
    const g = valid();
    g.edges.push({ from: "a", exit: "needs_person", to: "nope" });
    expect(checkGraph(g)).toHaveLength(1);
  });
  it("flags an unreachable node", () => {
    const g = valid();
    g.nodes.push({ ...end, id: "e2" });
    expect(checkGraph(g)).toHaveLength(1);
  });
  it("flags a reserved ai result name", () => {
    const g = valid();
    g.nodes[1] = { ...ai, results: [{ name: "new_message", meaning: "m" }] };
    g.edges[1] = { from: "a", exit: "new_message", to: "w" };
    expect(checkGraph(g)).toHaveLength(1);
  });
});

describe("checkGraph ambiguous exits", () => {
  const withAsk = (a: Partial<typeof ask> & { choices?: string[]; timeoutMinutes?: number }): WorkflowGraph => ({
    nodes: [trigger, { ...ask, ...a } as WorkflowNode, end],
    edges: [{ from: "t", exit: "next", to: "k" }, { from: "k", exit: "no_answer", to: "e" }],
    holidays: [],
  });
  it("flags duplicate ai result names", () => {
    const g = valid();
    g.nodes[1] = { ...ai, results: [{ name: "done", meaning: "a" }, { name: "done", meaning: "b" }] };
    expect(checkGraph(g)).toHaveLength(1);
  });
  it("flags a reserved ask choice", () => {
    expect(checkGraph(withAsk({ choices: ["yes", "no_answer"] }))).toHaveLength(1);
    expect(checkGraph(withAsk({ choices: ["yes", "new_message"] }))).toHaveLength(1);
  });
  it("flags a duplicate ask choice", () => {
    expect(checkGraph(withAsk({ choices: ["yes", "yes"] }))).toHaveLength(1);
  });
  it("flags two edges from the same exit", () => {
    const g = valid();
    g.edges.push({ from: "t", exit: "next", to: "e" });
    expect(checkGraph(g)).toHaveLength(1);
  });
  it("flags ask timeoutMinutes below 1", () => {
    expect(checkGraph(withAsk({ timeoutMinutes: 0 }))).toHaveLength(1);
  });
});

describe("parseGraph", () => {
  it("accepts a valid graph", () => expect(parseGraph(valid()).nodes).toHaveLength(4));
  it("throws on a node without type", () => {
    expect(() => parseGraph({ nodes: [{ id: "t", label: "x", x: 0, y: 0 }], edges: [], holidays: [] })).toThrow();
  });
  it("drops an AI step's tools list, which nothing enforces yet", () => {
    const g = valid();
    g.nodes = g.nodes.map((n) => (n.type === "ai" ? { ...n, tools: ["mcp__x__y"] } : n));
    expect(parseGraph(g).nodes.find((n) => n.type === "ai")).not.toHaveProperty("tools");
  });
});
