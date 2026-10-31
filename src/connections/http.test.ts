import { describe, expect, it } from "vitest";
import { callHttp, listMcpTools } from "./http.js";

type Seen = { url: string; init: RequestInit };
function fakeFetch(respond: (url: string, init: RequestInit) => Response = () => new Response("ok")) {
  const seen: Seen[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init: init ?? {} });
    return respond(String(input), init ?? {});
  }) as typeof fetch;
  return { fn, seen };
}

const SECRET = "s3cr3t-token";
const conn = { target: "https://api.example.test/v1", config: { auth: { in: "header" as const, name: "Authorization", prefix: "Bearer " } }, secret: SECRET };

describe("callHttp", () => {
  it("adds the secret header and never returns the secret", async () => {
    const f = fakeFetch(() => new Response(`echo ${SECRET} and ${encodeURIComponent(SECRET)}`, { status: 200, statusText: "OK" }));
    const out = await callHttp(f.fn, conn, { method: "GET", path: "tickets", query: { open: "1" } });
    expect(f.seen[0]!.url).toBe("https://api.example.test/v1/tickets?open=1");
    expect(new Headers(f.seen[0]!.init.headers).get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(f.seen[0]!.init.redirect).toBe("manual");
    expect(out.startsWith("HTTP 200 OK\n")).toBe(true);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[secret]");

    const q = fakeFetch(() => { throw new Error(`connect failed for https://api.example.test/?key=${SECRET}`); });
    const queryConn = { target: "https://api.example.test/", config: { auth: { in: "query" as const, name: "key" } }, secret: SECRET };
    const err = await callHttp(q.fn, queryConn, { method: "GET", path: "x", query: { key: "mine" } }).catch((e: Error) => e.message);
    expect(new URL(q.seen[0]!.url).searchParams.getAll("key")).toEqual([SECRET]);
    expect(err).not.toContain(SECRET);
  });

  it("refuses absolute, protocol-relative and climbing paths", async () => {
    const f = fakeFetch();
    for (const path of ["https://evil", "//evil", "../x", "a/../../x", "%2e%2e/x", "a/.%2E/../x", "a\\..\\x", "\\\\evil", "a%2f..%2f..%2fx", "x\ny", "/other", "javascript:alert(1)", "%252e%252e/x", "a/..;/x", "..%3b/x", "a/%252f"]) {
      await expect(callHttp(f.fn, conn, { method: "GET", path }), path).rejects.toThrow();
    }
    expect(f.seen).toEqual([]);
    await callHttp(f.fn, conn, { method: "GET", path: "/v1/ok" });
    await callHttp(f.fn, { ...conn, target: "https://api.example.test/v1/" }, { method: "GET", path: "" });
    expect(f.seen.map((s) => s.url)).toEqual(["https://api.example.test/v1/ok", "https://api.example.test/v1/"]);
  });

  it("refuses a caller-set auth or Host header", async () => {
    const f = fakeFetch();
    for (const h of ["Authorization", "host", "Cookie", "Connection", "Transfer-Encoding", "Proxy-Authorization", "X-Original-URL", "X-Rewrite-URL", "X-HTTP-Method-Override", "X-Forwarded-Host"]) {
      await expect(callHttp(f.fn, conn, { method: "GET", path: "x", headers: { [h]: "v" } }), h).rejects.toThrow(/header/);
    }
    await expect(callHttp(f.fn, conn, { method: "GET", path: "x", headers: { "X-A": "a\r\nInjected: 1" } })).rejects.toThrow();
    await expect(callHttp(f.fn, conn, { method: "POST", path: "x", body: "x".repeat(100_001) })).rejects.toThrow(/body/i);
    expect(f.seen).toEqual([]);
    await callHttp(f.fn, conn, { method: "POST", path: "x", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(f.seen[0]!.init).toMatchObject({ method: "POST", body: "{}" });
  });

  it("does not follow redirects", async () => {
    const f = fakeFetch(() => new Response(null, { status: 302, statusText: "Found", headers: { Location: `https://elsewhere.test/?t=${SECRET}` } }));
    const out = await callHttp(f.fn, conn, { method: "GET", path: "x" });
    expect(f.seen).toHaveLength(1);
    expect(out).toBe("HTTP 302 Found\nLocation: https://elsewhere.test/?t=[secret]\n");
  });

  it("a secret straddling the cap never comes back in part", async () => {
    const secret = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn";
    const prefixes = Array.from({ length: secret.length - 5 }, (_, i) => secret.slice(0, i + 6));
    for (let offset = 19_700; offset <= 20_050; offset++) {
      // a target that echoes the secret wherever the model's padding puts it, many times so masking shrinks the text
      const f = fakeFetch(() => new Response(`${secret}x`.repeat(5) + "x".repeat(offset) + secret + "y".repeat(100)));
      const out = await callHttp(f.fn, { ...conn, secret }, { method: "GET", path: "x" });
      expect(out.length).toBeLessThanOrEqual(20_000);
      for (const p of prefixes) expect(out, `offset ${offset}`).not.toContain(p);
    }
    const mcp = fakeFetch(() => Response.json({ jsonrpc: "2.0", id: 1, error: { message: "x".repeat(480) + secret } }));
    const err = await listMcpTools(mcp.fn, { target: "https://mcp.example.test/mcp", headerName: "K", secret }).catch((e: Error) => e.message);
    for (const p of prefixes) expect(err).not.toContain(p);
  });

  it("masks escaped and encoded echoes of the secret", async () => {
    const secret = 'a/b+c=d"e';
    const unicode = secret.replace(/[^A-Za-z0-9]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    const echoes = [`{"t":"a\\/b+c=d\\"e"}`, JSON.stringify({ t: secret }), encodeURIComponent(secret), new URLSearchParams({ t: secret }).toString(), Buffer.from(secret).toString("base64"), `{"t":"${unicode}"}`];
    for (const echo of echoes) {
      const f = fakeFetch(() => new Response(echo));
      const out = await callHttp(f.fn, { ...conn, secret }, { method: "GET", path: "x" });
      expect(out, echo).toContain("[secret]");
      for (const form of [secret, "a\\/b+c=d", "a/b+c=d", "a%2Fb%2Bc", Buffer.from(secret).toString("base64").slice(0, 8)]) expect(out, echo).not.toContain(form);
    }
  });

  it("caps the response", async () => {
    const f = fakeFetch(() => new Response("y".repeat(50_000)));
    const out = await callHttp(f.fn, conn, { method: "GET", path: "x" });
    expect(out.length).toBeLessThanOrEqual(20_000);
    expect(out.startsWith("HTTP 200")).toBe(true);
  });
});

describe("listMcpTools", () => {
  it("initializes, carries the session and lists tools from JSON or SSE", async () => {
    const f = fakeFetch((_url, init) => {
      const msg = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (msg.method === "initialize")
        return Response.json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }, { headers: { "Mcp-Session-Id": "sess-1" } });
      if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "list_tickets" }, { name: "close_ticket" }] } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    });
    const tools = await listMcpTools(f.fn, { target: "https://mcp.example.test/mcp", headerName: "X-Api-Key", secret: SECRET });
    expect(tools).toEqual(["list_tickets", "close_ticket"]);
    expect(f.seen.map((s) => JSON.parse(String(s.init.body)).method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    const h = new Headers(f.seen[2]!.init.headers);
    expect(h.get("x-api-key")).toBe(SECRET);
    expect(h.get("mcp-session-id")).toBe("sess-1");
    expect(h.get("accept")).toBe("application/json, text/event-stream");
    expect(new Headers(f.seen[0]!.init.headers).get("mcp-session-id")).toBeNull();
  });

  it("a non-2xx answer fails with its status and never the secret", async () => {
    const f = fakeFetch(() => new Response(`bad key ${SECRET}`, { status: 401, statusText: "Unauthorized" }));
    const err = await listMcpTools(f.fn, { target: "https://mcp.example.test/mcp", headerName: "X-Api-Key", secret: SECRET }).catch((e: Error) => e.message);
    expect(err).toContain("401 Unauthorized");
    expect(err).not.toContain(SECRET);
  });
});
