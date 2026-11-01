import { describe, expect, it, vi } from "vitest";
import { GraphError, graphFetch } from "./client.js";

const TOKEN = "eyJ0b2stZ3JhcGgtc2VjcmV0";

/** A fake fetch answering from a queue, recording each request. */
function fakeFetch(...answers: Response[]) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return answers.shift() ?? new Response("{}");
  });
  return { fn: fn as unknown as typeof fetch, requests };
}

const graphError = (status: number, code: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { code, message: `token ${TOKEN} was bad`, innerError: { request: TOKEN } } }), { status, headers });

describe("graphFetch", () => {
  it("calls Graph v1.0 with the bearer from the closure, asking for it on every call", async () => {
    const f = fakeFetch(new Response('{"a":1}'), new Response('{"b":2}'));
    const token = vi.fn(async () => TOKEN);
    const r = await graphFetch({ fetchFn: f.fn, token }, "/me/messages?$top=5");
    await graphFetch({ fetchFn: f.fn, token }, "/me/sendMail", { method: "POST", json: { x: 1 } });
    expect(await r.json()).toEqual({ a: 1 });
    expect(f.requests[0]!.url).toBe("https://graph.microsoft.com/v1.0/me/messages?$top=5");
    expect(f.requests[0]!.init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    expect(f.requests[1]!.init).toMatchObject({ method: "POST", body: '{"x":1}', headers: { "Content-Type": "application/json" } });
    expect(token).toHaveBeenCalledTimes(2);
  });

  it("without a token asks for sign-in and calls nothing", async () => {
    const f = fakeFetch();
    const e = await graphFetch({ fetchFn: f.fn, token: async () => undefined }, "/me").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GraphError);
    expect(e).toMatchObject({ status: 401 });
    expect(f.requests).toHaveLength(0);
  });

  it("retries once on 429 or 503 after Retry-After, capped at 10 s", async () => {
    const sleep = vi.fn(async () => {});
    const f = fakeFetch(graphError(429, "TooManyRequests", { "Retry-After": "3" }), new Response('{"ok":true}'));
    expect(await (await graphFetch({ fetchFn: f.fn, token: async () => TOKEN, sleep }, "/me")).json()).toEqual({ ok: true });
    const g = fakeFetch(graphError(503, "ServiceUnavailable", { "Retry-After": "120" }), graphError(503, "ServiceUnavailable"));
    const e = await graphFetch({ fetchFn: g.fn, token: async () => TOKEN, sleep }, "/me").catch((x: unknown) => x);
    expect(sleep.mock.calls).toEqual([[3000], [10_000]]);
    expect(g.requests).toHaveLength(2);
    expect(e).toMatchObject({ status: 503, code: "ServiceUnavailable" });
  });

  it("never retries a 401, and the error carries only status and code", async () => {
    const f = fakeFetch(graphError(401, "InvalidAuthenticationToken"), new Response("{}"));
    const e = (await graphFetch({ fetchFn: f.fn, token: async () => TOKEN, sleep: async () => {} }, "/me").catch((x: unknown) => x)) as GraphError;
    expect(f.requests).toHaveLength(1);
    expect(e).toMatchObject({ status: 401, code: "InvalidAuthenticationToken" });
    expect(`${e.message} ${e.stack} ${JSON.stringify(e)}`).not.toContain(TOKEN);
    expect(e.message).not.toContain("was bad");
  });

  it("a code that is not a plain identifier, or no JSON at all, becomes unknown", async () => {
    const f = fakeFetch(new Response(JSON.stringify({ error: { code: `bad ${TOKEN}` } }), { status: 400 }), new Response(`<html>${TOKEN}</html>`, { status: 500 }));
    const deps = { fetchFn: f.fn, token: async () => TOKEN };
    expect(await graphFetch(deps, "/me").catch((x: unknown) => x)).toMatchObject({ status: 400, code: "unknown" });
    expect(await graphFetch(deps, "/me").catch((x: unknown) => x)).toMatchObject({ status: 500, code: "unknown" });
  });
});
