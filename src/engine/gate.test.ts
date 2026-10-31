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
  it("built-in tools classify as specified", () => {
    const table: [string, string][] = [
      ...["list", "read", "search", "write"].map((t) => [`mcp__knowledge__${t}`, "read"] as [string, string]),
      ...["list", "request", "verify", "ssh_read", "http_read"].map((t) => [`mcp__connections__${t}`, "read"] as [string, string]),
      ["mcp__connections__ssh_change", "write"],
      ["mcp__connections__http_change", "write"],
      ["mcp__connections__approve", "approve"],
      ["mcp__routine__remind", "read"],
      ["mcp__routine__post", "read"],
      ["mcp__computer__bash", "read"],
      ["mcp__connections__other", "write"],
      ["mcp__knowledge__other", "write"],
    ];
    for (const [name, want] of table) expect([name, classify(name, def)]).toEqual([name, want]);
    const listed = [{ name: "conn-helpdesk", readOnlyTools: ["list_tickets"] }];
    expect(classify("mcp__conn-helpdesk__list_tickets", def, listed)).toBe("read");
    expect(classify("mcp__conn-helpdesk__list_tickets", def)).toBe("write");
    expect(classify("mcp__conn-helpdesk__close", def, listed)).toBe("write");
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
