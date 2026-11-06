import { createSdkMcpServer, tool } from "../engine/mcp.js";
import type { McpServerHandle } from "../engine/mcp.js";
import { z } from "zod";
import { runOnComputer } from "./computer.js";
import type { DockerClient } from "./docker.js";

export function computerMcpServer(docker: DockerClient, containerId: string): McpServerHandle {
  return createSdkMcpServer({
    name: "computer",
    tools: [
      tool("bash", "Run a shell command on your own Linux computer.", { command: z.string() }, async ({ command }) => ({
        content: [{ type: "text" as const, text: await runOnComputer(docker, containerId, command) }],
      })),
    ],
  });
}
