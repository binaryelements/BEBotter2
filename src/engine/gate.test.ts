import { describe, expect, it } from "vitest";
import type { BotDefinition } from "../db/schema.js";
import { classify } from "./gate.js";

const def = {
  mcpServers: [{ name: "tickets", transport: "http", readOnlyTools: ["list_tickets"] }],
} as unknown as BotDefinition;

describe("classify", () => {
  it("treats WebSearch and WebFetch as read", () => {
    expect(classify("WebSearch", def)).toBe("read");
    expect(classify("WebFetch", def)).toBe("read");
  });
  it("treats the computer's bash as read", () => {
    expect(classify("mcp__computer__bash", def)).toBe("read");
  });
  it("does not let a declared server named computer claim the built-in read rule", () => {
    const d = { mcpServers: [{ name: "computer", transport: "http", readOnlyTools: [] }] } as unknown as BotDefinition;
    expect(classify("mcp__computer__bash", d)).toBe("write");
  });
  it("treats a listed read-only MCP tool as read", () => {
    expect(classify("mcp__tickets__list_tickets", def)).toBe("read");
  });
  it("treats an unlisted MCP tool as write", () => {
    expect(classify("mcp__tickets__close_ticket", def)).toBe("write");
    expect(classify("mcp__other__list_tickets", def)).toBe("write");
  });
  it("treats anything else as write", () => {
    for (const n of ["Bash", "Write", "Edit", "Mystery"]) expect(classify(n, def)).toBe("write");
  });
});
