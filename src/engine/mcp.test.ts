import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { testDb } from "../db/test-db.js";
import { knowledgeMcpServer } from "../knowledge/mcp.js";
import { upsertTenant } from "../org/org.js";
import { McpRegistry } from "./mcp-registry.js";
import { createSdkMcpServer, tool } from "./mcp.js";

const demo = () =>
  createSdkMcpServer({
    name: "demo",
    tools: [
      tool("echo", "Echo the text back.", { text: z.string() }, async ({ text }) => ({ content: [{ type: "text" as const, text: `echo:${text}` }] })),
      tool("fail", "Always fail.", {}, async () => ({ isError: true, content: [{ type: "text" as const, text: "nope" }] })),
      tool("picture", "Return a picture.", {}, async () => ({ content: [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }] })),
    ],
  });

describe("createSdkMcpServer", () => {
  it("returns an open McpServer the Claude runtime also accepts", () => {
    const handle = demo();
    expect(handle).toMatchObject({ type: "sdk", name: "demo" });
    expect(Object.keys((handle.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)).toEqual(["echo", "fail", "picture"]);
  });
});

describe("McpRegistry", () => {
  it("lists an in-process server's tools under the mcp__server__tool names", async () => {
    const registry = new McpRegistry({ demo: demo() });
    try {
      const tools = await registry.listTools();
      expect(tools.map((t) => t.name)).toEqual(["mcp__demo__echo", "mcp__demo__fail", "mcp__demo__picture"]);
      expect(tools.find((t) => t.name === "mcp__demo__echo")).toMatchObject({
        description: "Echo the text back.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      });
    } finally {
      await registry.close();
    }
  });

  it("calls a tool and returns its text or error", async () => {
    const registry = new McpRegistry({ demo: demo() });
    try {
      await expect(registry.call("mcp__demo__echo", { text: "hi" })).resolves.toEqual({ text: "echo:hi" });
      await expect(registry.call("mcp__demo__fail", {})).resolves.toEqual({ text: "nope", isError: true });
    } finally {
      await registry.close();
    }
  });

  it("carries an image result through for the model to look at", async () => {
    const registry = new McpRegistry({ demo: demo() });
    try {
      await expect(registry.call("mcp__demo__picture", {})).resolves.toEqual({ text: "", images: [{ data: "aGVsbG8=", mimeType: "image/png" }] });
    } finally {
      await registry.close();
    }
  });

  it("refuses a name that is not an MCP tool or names no known server", async () => {
    const registry = new McpRegistry({ demo: demo() });
    try {
      await expect(registry.call("WebSearch", {})).resolves.toMatchObject({ isError: true });
      await expect(registry.call("mcp__other__echo", { text: "hi" })).resolves.toMatchObject({ isError: true });
    } finally {
      await registry.close();
    }
  });

  it("calls a real app server through the same client", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const registry = new McpRegistry({
      knowledge: knowledgeMcpServer({ db, secretsKey: Buffer.alloc(32, 1) }, { tenantId: "t1", definitionId: "d1", chatId: "c1", personId: "p1" }),
    });
    try {
      expect((await registry.listTools()).map((t) => t.name)).toContain("mcp__knowledge__list");
      await expect(registry.call("mcp__knowledge__list", {})).resolves.toEqual({ text: "No notes" });
    } finally {
      await registry.close();
    }
  });

  it("does not list a server whose transport cannot start", async () => {
    const registry = new McpRegistry({ broken: { type: "stdio", command: "/nonexistent-bebotter-mcp" } });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(registry.listTools()).resolves.toEqual([]);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      await registry.close();
    }
  });
});
