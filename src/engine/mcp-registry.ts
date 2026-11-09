import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { EngineImage, EngineTool, ToolResult } from "./engine.js";
import type { McpServerConfig } from "./mcp.js";
import type { McpPool } from "./mcp-pool.js";

/** A tool as the model sees it: the server's name is folded into the tool name, as the SDK does. */
export type McpTool = EngineTool;

/** What a tool call hands back: text for the transcript, and any image the model may look at. */
export type McpToolResult = ToolResult;

type Content = { type: string; text?: string; data?: string; mimeType?: string; uri?: string; resource?: { text?: string } };

const CONNECT_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;

// runs code in the browser server's process, which can read this container's files and secrets; the old runtime blocked it
const BLOCKED = new Set(["mcp__browser__browser_run_code_unsafe"]);

export const mcpToolName = (server: string, tool: string) => `mcp__${server}__${tool}`;

/**
 * The app's MCP client. In-process servers are connected over a linked in-memory transport; configured
 * servers use HTTP or stdio. It is created for one turn and closed at the end, so a tool call cannot
 * outlive the turn that authorised it.
 */
export class McpRegistry {
  private clients = new Map<string, Client>();
  private poolKeys = new Map<string, string>();
  private tools?: McpTool[];

  constructor(
    private readonly servers: Record<string, McpServerConfig>,
    private readonly opts: { fetch?: typeof fetch; key?: string; pool?: McpPool } = {},
  ) {}

  async listTools(): Promise<McpTool[]> {
    if (this.tools) return this.tools;
    const out: McpTool[] = [];
    for (const [server, config] of Object.entries(this.servers)) {
      try {
        const client = await this.client(server, config);
        for (const tool of (await client.listTools(undefined, { timeout: LIST_TIMEOUT_MS })).tools) {
          const name = mcpToolName(server, tool.name);
          if (BLOCKED.has(name)) continue;
          out.push({ name, description: tool.description ?? "", inputSchema: tool.inputSchema as Record<string, unknown> });
        }
      } catch (err) {
        // a server that cannot start costs the bot that server, not the reply
        console.error(`mcp ${server} could not list its tools:`, err instanceof Error ? err.message : "error");
      }
    }
    this.tools = out;
    return out;
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    if (BLOCKED.has(name)) return { text: "That tool is not available.", isError: true };
    const match = /^mcp__(.+?)__(.+)$/.exec(name);
    if (!match) return { text: `Not an MCP tool: ${name}`, isError: true };
    const server = match[1]!;
    const tool = match[2]!;
    const config = this.servers[server];
    if (!config) return { text: `No MCP server named ${server}.`, isError: true };
    try {
      const client = await this.client(server, config);
      const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) });
      const content = (result.content ?? []) as Content[];
      const texts: string[] = [];
      const images: EngineImage[] = [];
      for (const c of content) {
        if (c.type === "text" && c.text !== undefined) texts.push(c.text);
        else if (c.type === "image" && c.data && c.mimeType) images.push({ data: c.data, mimeType: c.mimeType });
        else if (c.type === "resource" && c.resource?.text !== undefined) texts.push(c.resource.text);
        else if (c.type === "resource_link" && c.uri) texts.push(c.uri);
      }
      return { text: texts.join("\n"), ...(result.isError ? { isError: true } : {}), ...(images.length ? { images } : {}) };
    } catch (err) {
      console.error(`mcp ${server} tool ${tool} failed:`, err instanceof Error ? err.message : "error");
      return { text: `The tool ${tool} did not answer.`, isError: true };
    }
  }

  async close(): Promise<void> {
    for (const [server, client] of this.clients) {
      const key = this.poolKeys.get(server);
      if (key) this.opts.pool?.release(key);
      else await client.close().catch((err) => console.error("closing an MCP client failed", err instanceof Error ? err.name : "unknown"));
    }
    this.clients.clear();
    this.poolKeys.clear();
    this.tools = undefined;
  }

  private async client(server: string, config: McpServerConfig): Promise<Client> {
    const existing = this.clients.get(server);
    if (existing) return existing;
    if (config.type === "stdio" && this.opts.pool) {
      const key = this.poolKey(server, config);
      const client = await this.opts.pool.acquire(key, () => this.connect(config));
      this.clients.set(server, client);
      this.poolKeys.set(server, key);
      return client;
    }
    const client = await this.connect(config);
    this.clients.set(server, client);
    return client;
  }

  private async connect(config: McpServerConfig): Promise<Client> {
    const client = new Client({ name: "bebotter", version: "1.0.0" });
    if (config.type === "sdk") {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await config.instance.connect(serverTransport);
      await client.connect(clientTransport, { timeout: CONNECT_TIMEOUT_MS });
    } else if (config.type === "http") {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(config.url), {
          ...(config.headers ? { requestInit: { headers: config.headers } } : {}),
          ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
        }),
        { timeout: CONNECT_TIMEOUT_MS },
      );
    } else {
      await client.connect(new StdioClientTransport({ command: config.command, ...(config.args ? { args: config.args } : {}), ...(config.env ? { env: config.env } : {}) }), { timeout: CONNECT_TIMEOUT_MS });
    }
    return client;
  }

  private poolKey(server: string, config: Extract<McpServerConfig, { type: "stdio" }>): string {
    const scope = config.pool === "definition" ? (this.opts.key?.split(":")[1] ?? "definition") : (this.opts.key ?? "chat");
    return `${scope}:${server}`;
  }
}
