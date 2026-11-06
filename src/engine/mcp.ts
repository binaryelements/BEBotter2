import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

/** The shape the app's tools are written against: a tool's arguments as a Zod raw shape. */
export type ZodShape = Record<string, z.ZodTypeAny>;
export type ShapeArgs<S extends ZodShape> = { [K in keyof S]: z.infer<S[K]> };

export type ToolDefinition<S extends ZodShape = ZodShape> = {
  name: string;
  description: string;
  inputSchema: S;
  handler: (args: ShapeArgs<S>, extra?: unknown) => Promise<CallToolResult> | CallToolResult;
  annotations?: ToolAnnotations;
};

/** The one line a server file needs: `tool(name, description, zodShape, handler)`. */
export function tool<S extends ZodShape>(
  name: string,
  description: string,
  inputSchema: S,
  handler: (args: ShapeArgs<S>, extra?: unknown) => Promise<CallToolResult> | CallToolResult,
  annotations?: ToolAnnotations,
): ToolDefinition<S> {
  return { name, description, inputSchema, handler, ...(annotations ? { annotations } : {}) };
}

/**
 * An in-process MCP server. The instance is the open `McpServer` from @modelcontextprotocol/sdk,
 * so the same object can be handed to the Claude Agent SDK or connected to by the app's own client.
 */
export type McpServerHandle = { type: "sdk"; name: string; instance: McpServer };

export type McpServerConfig =
  | McpServerHandle
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> };

export type McpServerOptions = {
  name: string;
  version?: string;
  instructions?: string;
  tools?: ToolDefinition<any>[];
};

export function createSdkMcpServer(options: McpServerOptions): McpServerHandle {
  const server = new McpServer(
    { name: options.name, version: options.version ?? "1.0.0" },
    options.instructions ? { instructions: options.instructions } : undefined,
  );
  for (const t of options.tools ?? []) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.inputSchema as never, ...(t.annotations ? { annotations: t.annotations } : {}) },
      t.handler as never,
    );
  }
  return { type: "sdk", name: options.name, instance: server };
}
