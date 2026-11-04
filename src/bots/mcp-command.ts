import { DirectoryError } from "../org/directory.js";

export type ParsedMcpAdd = { name: string; transport: "http" | "stdio"; url?: string; command?: string; args?: string[]; headers?: Record<string, string> };

/** Splits a shell line the way a POSIX shell would for plain words, quotes and backslashes (no variables or globs). */
function words(line: string): string[] {
  const out: string[] = [];
  let cur: string | undefined;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!)) cur += line[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      cur ??= "";
    } else if (c === "\\") {
      if (line[i + 1] === "\n") i++; // line continuation
      else if (i + 1 < line.length) cur = (cur ?? "") + line[++i];
    } else if (/\s/.test(c)) {
      if (cur !== undefined) out.push(cur);
      cur = undefined;
    } else cur = (cur ?? "") + c;
  }
  if (quote) throw new DirectoryError("The command has an unclosed quote");
  if (cur !== undefined) out.push(cur);
  return out;
}

/** Reads a `claude mcp add …` command, as MCP servers usually publish it, into a server for the bot. */
export function parseMcpAdd(line: string): ParsedMcpAdd {
  const w = words(line.trim());
  let i = 0;
  if (w[i] === "claude") i++;
  if (w[i] === "mcp") i++;
  if (w[i] !== "add") throw new DirectoryError("Paste a command that starts with claude mcp add");
  i++;
  let transport = "stdio";
  const headers: Record<string, string> = {};
  const positional: string[] = [];
  for (; i < w.length; i++) {
    const a = w[i]!;
    const is = (short: string, long: string) => a === short || a === long || a.startsWith(`${short}=`) || a.startsWith(`${long}=`);
    const value = (flag: string) => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : (w[++i] ?? (() => { throw new DirectoryError(`${flag} needs a value`); })()));
    if (a === "--") {
      positional.push(...w.slice(i + 1));
      break;
    } else if (is("-t", "--transport")) transport = value("--transport");
    else if (is("-H", "--header")) {
      const h = value("--header");
      const colon = h.indexOf(":");
      // never echo the header: without a colon it may be the secret itself
      if (colon < 1) throw new DirectoryError('A header must look like "Name: value"');
      headers[h.slice(0, colon).trim()] = h.slice(colon + 1).trim();
    } else if (is("-s", "--scope")) value("--scope");
    else if (is("-e", "--env")) throw new DirectoryError("Servers that need --env settings can't be added here yet");
    else if (a.startsWith("-")) throw new DirectoryError(`Unknown option ${a.split("=")[0]}`);
    else positional.push(a);
  }
  const [name, target, ...rest] = positional;
  if (!name || !target) throw new DirectoryError("The command needs a name and a URL or command");
  if (transport === "http" || transport === "sse") {
    if (rest.length) throw new DirectoryError("An http server takes only a name and a URL");
    return { name, transport: "http", url: target, ...(Object.keys(headers).length ? { headers } : {}) };
  }
  if (transport !== "stdio") throw new DirectoryError(`Transport must be http or stdio, not ${transport}`);
  if (Object.keys(headers).length) throw new DirectoryError("Headers only go with an http server");
  return { name, transport: "stdio", command: target, ...(rest.length ? { args: rest } : {}) };
}
