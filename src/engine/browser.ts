import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

const require = createRequire(import.meta.url);
const CLI = join(dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");
// headless Chromium says "HeadlessChrome", which sites like Google Flights block; say desktop Chrome on Linux, at the version installed
const core = dirname(require.resolve("playwright-core/package.json", { paths: [require.resolve("@playwright/mcp")] }));
const chromeMajor = (JSON.parse(readFileSync(join(core, "browsers.json"), "utf8")) as { browsers: { name: string; browserVersion?: string }[] })
  .browsers.find((b) => b.name === "chromium")?.browserVersion?.split(".")[0] ?? "140";
export const USER_AGENT = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;

/**
 * A headless Chromium the bot drives, for pages that only show their content once their scripts run (flight prices, shops).
 * --isolated keeps the profile in memory per process, so cookies or logins from one person's chat never reach another's.
 * shortcut: the browser can reach anything this container can, private addresses included; put it behind an egress proxy when bots browse on behalf of outsiders
 */
export const browserMcpServer = (): McpServerConfig => ({
  type: "stdio",
  command: process.execPath,
  // the app runs as root in its container, where Chromium's own sandbox cannot start; the container is the sandbox
  args: [CLI, "--headless", "--isolated", "--browser", "chromium", "--no-sandbox", "--user-agent", USER_AGENT, "--output-dir", join(tmpdir(), "browser")],
  env: Object.fromEntries(["PATH", "HOME", "PLAYWRIGHT_BROWSERS_PATH"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!])),
});

/** Looking, clicking and typing in a throwaway profile; running page code and uploading the bot's files are not on this list, so they ask. */
export const BROWSER_READS = [
  "navigate", "navigate_back", "navigate_forward", "reload", "snapshot", "take_screenshot", "click", "hover", "type", "press_key",
  "press_sequentially", "fill_form", "select_option", "check", "uncheck", "wait_for", "tabs", "close", "resize", "handle_dialog", "find",
  "console_messages", "network_requests", "verify_element_visible", "verify_list_visible", "verify_text_visible", "verify_value",
].map((t) => `mcp__browser__browser_${t}`);
