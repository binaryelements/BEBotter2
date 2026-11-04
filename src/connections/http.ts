import { ConnectionError } from "./store.js";

export type HttpConfig = { auth?: { in: "header" | "query"; name: string; prefix?: string } };
export type HttpRequest = { method: string; path: string; query?: Record<string, string>; headers?: Record<string, string>; body?: string };

const MAX_OUTPUT = 20_000;
const MAX_BODY = 100_000;
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// hop-by-hop headers and the ones that would let a caller act as someone else
const BLOCKED_HEADERS = new Set([
  "host", "cookie", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length",
  // headers some servers and proxies obey to rewrite the path, host or method
  "x-original-url", "x-rewrite-url", "x-override-url", "x-http-method-override", "x-http-method", "x-method-override",
  "x-forwarded-host", "x-forwarded-prefix", "x-forwarded-path", "x-forwarded-proto", "x-original-host", "x-host", "forwarded",
]);

const fail = (message: string): never => {
  throw new ConnectionError(message);
};

type Mask = ((text: string, max?: number) => string) & { longest: number };

/** Every form of the secret a target could echo back: raw, URL- and form-encoded, JSON-escaped, base64. */
function secretForms(secret: string): string[] {
  const json = JSON.stringify(secret).slice(1, -1);
  const unicode = (upper: boolean) => secret.replace(/[^A-Za-z0-9]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")[upper ? "toUpperCase" : "toLowerCase"]()}`);
  const forms = [
    secret, encodeURIComponent(secret), new URLSearchParams({ s: secret }).toString().slice(2),
    json, json.replaceAll("/", "\\/"), unicode(false), unicode(true),
    // unpadded, so it also matches inside longer base64
    Buffer.from(secret).toString("base64").replace(/=+$/, ""),
  ];
  return [...new Set(forms)].filter((f) => f.length > 0).sort((a, b) => b.length - a.length);
}

/**
 * Replaces the secret with [secret] and keeps the first `max` characters of the original text, so a
 * secret crossing the cap is dropped, never cut in half. Text cut at a read limit must hold
 * `max + longest` characters for every secret starting before `max` to be whole.
 */
function masker(secret?: string): Mask {
  const forms = secret ? secretForms(secret) : [];
  const re = forms.length ? new RegExp(forms.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : undefined;
  const mask = (text: string, max = Infinity) => {
    let out = "";
    let last = 0;
    for (const m of re ? text.matchAll(re) : []) {
      if (m.index >= max) break;
      out += text.slice(last, m.index) + "[secret]";
      last = m.index + m[0].length;
    }
    return (out + text.slice(last, Math.max(last, Math.min(text.length, max)))).slice(0, max);
  };
  return Object.assign(mask, { longest: forms[0]?.length ?? 0 });
}

/** Resolves a model-chosen path under the base URL, or refuses it before any request. */
function resolvePath(target: string, path: string): URL {
  const pathPart = path.split(/[?#]/)[0]!;
  const plain = pathPart.replace(/%2e/gi, ".").replace(/%2f/gi, "/").replace(/%5c/gi, "\\").replace(/%3b/gi, ";");
  // %25 is a double encoding a server may decode twice; "..;" climbs on servers that strip path parameters
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(path + plain) || /%25/i.test(pathPart) || plain.split("/").some((seg) => seg.split(";")[0] === ".."))
    fail("The path must be relative to the connection's URL, without .. segments, double encoding, backslashes or control characters");
  const base = new URL(target);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) fail(`The path must stay under ${base.pathname}`);
  return url;
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (text.length < max) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return text.slice(0, max);
}

async function send(fetchFn: typeof fetch, url: URL, init: RequestInit, scrub: Mask, timeoutMs: number): Promise<Response> {
  try {
    return await fetchFn(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = e as { name?: string; message?: string; cause?: { code?: string } };
    return fail(scrub(`Request failed: ${err.cause?.code ?? (err.name === "TimeoutError" ? "timed out" : (err.message ?? "unknown error"))}`));
  }
}

/** One request on an http connection; the service adds the secret and nothing returned holds it. */
export async function sendHttp(
  fetchFn: typeof fetch,
  conn: { target: string; config: HttpConfig; secret?: string },
  req: HttpRequest,
  timeoutMs = 60_000,
): Promise<{ status: number; text: string }> {
  const scrub = masker(conn.secret);
  if (!HTTP_TOKEN.test(req.method)) fail("Invalid method");
  if (req.body !== undefined && req.body.length > MAX_BODY) fail(`The body is over ${MAX_BODY} characters`);
  const url = resolvePath(conn.target, req.path);
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.append(k, v);
  const auth = conn.config.auth;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    const name = k.toLowerCase();
    if (!HTTP_TOKEN.test(k) || BLOCKED_HEADERS.has(name) || (auth?.in === "header" && name === auth.name.toLowerCase())) fail(`The ${k} header cannot be set`);
    if (/[\x00-\x1f\x7f]/.test(v)) fail(`The ${k} header value holds control characters`);
    headers.set(k, v);
  }
  if (auth && conn.secret) {
    if (auth.in === "header") headers.set(auth.name, (auth.prefix ?? "") + conn.secret);
    else url.searchParams.set(auth.name, conn.secret);
  }
  const res = await send(fetchFn, url, { method: req.method, headers, ...(req.body !== undefined ? { body: req.body } : {}) }, scrub, timeoutMs);
  const location = res.headers.get("location");
  const head = `HTTP ${res.status} ${res.statusText}\n${location ? `Location: ${location}\n` : ""}`;
  const body = await readCapped(res, MAX_OUTPUT + scrub.longest);
  return { status: res.status, text: scrub(head + body, MAX_OUTPUT) };
}

export const callHttp = async (...args: Parameters<typeof sendHttp>): Promise<string> => (await sendHttp(...args)).text;

type JsonRpc = { id?: number; result?: Record<string, unknown>; error?: { message?: string } };

/** headers: every header a server added on the admin site sends; its first value is the one masked in errors. */
type McpConn = { target: string; headerName?: string; secret?: string; headers?: Record<string, string> };

/** Connects to an MCP server over Streamable HTTP and returns its tool names. */
export const listMcpTools = async (fetchFn: typeof fetch, conn: McpConn, timeoutMs?: number): Promise<string[]> =>
  (await listMcpToolInfo(fetchFn, conn, timeoutMs)).map((t) => t.name);

/** Its tools, each with whether the server marks it read-only (the MCP `readOnlyHint` annotation). */
export async function listMcpToolInfo(fetchFn: typeof fetch, conn: McpConn, timeoutMs = 30_000): Promise<{ name: string; readOnly: boolean }[]> {
  // shortcut: only one secret is masked; a server with several secret headers could echo the others in an error
  const scrub = masker(conn.secret ?? Object.values(conn.headers ?? {})[0]);
  const url = new URL(conn.target);
  const headers = new Headers({ Accept: "application/json, text/event-stream", "Content-Type": "application/json" });
  if (conn.headerName && conn.secret) headers.set(conn.headerName, conn.secret);
  for (const [k, v] of Object.entries(conn.headers ?? {})) headers.set(k, v);
  let nextId = 1;
  const post = async (method: string, params?: unknown, notify = false): Promise<Record<string, unknown>> => {
    const id = nextId++;
    const res = await send(fetchFn, url, { method: "POST", headers: new Headers(headers), body: JSON.stringify({ jsonrpc: "2.0", ...(notify ? {} : { id }), method, ...(params ? { params } : {}) }) }, scrub, timeoutMs);
    const text = await readCapped(res, 1_000_000);
    if (!res.ok) fail(scrub(`MCP ${method} failed: ${res.status} ${res.statusText}`));
    const session = res.headers.get("mcp-session-id");
    if (session) headers.set("Mcp-Session-Id", session);
    if (notify) return {};
    const messages = (res.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim())
      : [text];
    let reply: JsonRpc | undefined;
    for (const m of messages) {
      try {
        const parsed = JSON.parse(m) as JsonRpc;
        if (parsed?.id === id) reply = parsed;
      } catch {
        // not JSON: ignored, and reported below if no reply came
      }
    }
    if (reply?.error) fail(scrub(`MCP ${method} failed: ${String(reply.error.message ?? "error")}`, 500));
    return reply?.result ?? fail(scrub(`MCP ${method} failed: no readable answer (${res.status} ${res.statusText})`));
  };
  const init = await post("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "be-botter", version: "2" } });
  if (typeof init.protocolVersion === "string") headers.set("MCP-Protocol-Version", init.protocolVersion);
  await post("notifications/initialized", undefined, true);
  const tools: { name: string; readOnly: boolean }[] = [];
  let cursor: unknown;
  for (let page = 0; page < 20; page++) {
    const r = await post("tools/list", cursor ? { cursor } : undefined);
    for (const t of Array.isArray(r.tools) ? (r.tools as { name?: unknown; annotations?: { readOnlyHint?: unknown } }[]) : [])
      if (typeof t?.name === "string") tools.push({ name: scrub(t.name), readOnly: t.annotations?.readOnlyHint === true });
    cursor = r.nextCursor;
    if (typeof cursor !== "string") break;
  }
  return tools;
}
