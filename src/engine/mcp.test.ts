import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { testDb } from "../db/test-db.js";
import { knowledgeMcpServer } from "../knowledge/mcp.js";
import { upsertTenant } from "../org/org.js";
import { imageSize, McpRegistry } from "./mcp-registry.js";
import { createSdkMcpServer, tool } from "./mcp.js";

/** Just enough of a PNG for its header: signature, then IHDR width and height. */
const png = (w: number, h: number) => {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.toString("base64");
};

const demo = () =>
  createSdkMcpServer({
    name: "demo",
    tools: [
      tool("echo", "Echo the text back.", { text: z.string() }, async ({ text }) => ({ content: [{ type: "text" as const, text: `echo:${text}` }] })),
      tool("fail", "Always fail.", {}, async () => ({ isError: true, content: [{ type: "text" as const, text: "nope" }] })),
      tool("picture", "Return a picture.", {}, async () => ({ content: [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }] })),
      tool("tall", "Return a full-page screenshot.", {}, async () => ({ content: [{ type: "image" as const, data: png(1280, 20000), mimeType: "image/png" }] })),
    ],
  });

describe("createSdkMcpServer", () => {
  it("returns an open McpServer the Claude runtime also accepts", () => {
    const handle = demo();
    expect(handle).toMatchObject({ type: "sdk", name: "demo" });
    expect(Object.keys((handle.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)).toEqual(["echo", "fail", "picture", "tall"]);
  });
});

describe("McpRegistry", () => {
  it("lists an in-process server's tools under the mcp__server__tool names", async () => {
    const registry = new McpRegistry({ demo: demo() });
    try {
      const tools = await registry.listTools();
      expect(tools.map((t) => t.name)).toEqual(["mcp__demo__echo", "mcp__demo__fail", "mcp__demo__picture", "mcp__demo__tall"]);
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

  it("leaves out an image too large for the model and says why, so the turn goes on", async () => {
    const registry = new McpRegistry({ demo: demo() });
    try {
      const result = await registry.call("mcp__demo__tall", {});
      expect(result.images).toBeUndefined();
      expect(result.text).toContain("1280x20000 px was left out");
    } finally {
      await registry.close();
    }
  });

  it("reads PNG and JPEG sizes from the header", () => {
    expect(imageSize(png(800, 600))).toEqual([800, 600]);
    // SOI, an APP0 segment of 16 bytes, then SOF0: length 17, precision 8, height 300, width 400
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...Array(14).fill(0), 0xff, 0xc0, 0, 17, 8, 0x01, 0x2c, 0x01, 0x90, 3, 0, 0, 0, 0, 0]);
    expect(imageSize(jpeg.toString("base64"))).toEqual([400, 300]);
    expect(imageSize("aGVsbG8=")).toBeUndefined();
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

  it("does not expose the browser's server-side code tool", async () => {
    const server = createSdkMcpServer({
      name: "browser",
      tools: [
        tool("browser_run_code_unsafe", "Run code.", {}, async () => ({ content: [{ type: "text" as const, text: "ran" }] })),
        tool("browser_navigate", "Go.", {}, async () => ({ content: [{ type: "text" as const, text: "ok" }] })),
      ],
    });
    const registry = new McpRegistry({ browser: server });
    try {
      expect((await registry.listTools()).map((t) => t.name)).toEqual(["mcp__browser__browser_navigate"]);
      await expect(registry.call("mcp__browser__browser_run_code_unsafe", {})).resolves.toMatchObject({ isError: true });
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
