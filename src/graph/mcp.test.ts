import { describe, expect, it, vi } from "vitest";
import { GRAPH_CAPABILITIES } from "../db/schema.js";
import type { GraphCapability } from "../db/schema.js";
import { m365McpServer } from "./mcp.js";

const TOKEN = "eyJ0b2stZ3JhcGgtc2VjcmV0";
type Result = { isError?: boolean; content: { text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
type Seen = { method: string; url: URL; headers: Record<string, string>; body?: string };

/** Graph faked at fetch: answers by "METHOD path", recording every request. */
function graph(answers: Record<string, () => Response> = {}) {
  const seen: Seen[] = [];
  const fetchFn = (async (u: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(u));
    const method = init.method ?? "GET";
    seen.push({ method, url, headers: (init.headers ?? {}) as Record<string, string>, ...(typeof init.body === "string" ? { body: init.body } : {}) });
    const answer = answers[`${method} ${url.hostname === "graph.microsoft.com" ? url.pathname.replace("/v1.0", "") : url.href}`];
    return answer ? answer() : new Response(null, { status: 202 });
  }) as typeof fetch;
  return { fetchFn, seen };
}
const json = (v: unknown, status = 200) => () => new Response(JSON.stringify(v), { status });

function server(fetchFn: typeof fetch, capabilities: readonly GraphCapability[] = GRAPH_CAPABILITIES, token: () => Promise<string | undefined> = async () => TOKEN) {
  const signInLost = vi.fn();
  const s = m365McpServer({ fetchFn, sleep: async () => {} }, { graphToken: token, signInLost }, capabilities);
  const tools = (s.instance as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
  return {
    signInLost,
    names: Object.keys(tools).sort(),
    call: (name: string, args: Record<string, unknown> = {}) => tools[name]!.handler(args),
  };
}
const out = (r: Result) => JSON.parse(r.content[0]!.text) as unknown;

const message = {
  id: "m1", subject: "Invoice", from: { emailAddress: { name: "Bea", address: "bea@example.test" } },
  toRecipients: [{ emailAddress: { name: "Ann", address: "ann@example.test" } }], receivedDateTime: "2026-11-01T08:00:00Z", bodyPreview: "x".repeat(400),
};

describe("m365 mcp", () => {
  it("offers only the tools of the definition's capabilities", () => {
    const g = graph();
    expect(server(g.fetchFn).names).toEqual(
      ["create_event", "find_free_time", "list_chats", "list_events", "list_mail", "read_chat", "read_file", "read_mail", "reply_mail", "respond_event", "search_files", "search_mail", "send_mail", "upload_file"].sort(),
    );
    expect(server(g.fetchFn, ["mail.read"]).names).toEqual(["list_mail", "read_mail", "search_mail"]);
    expect(server(g.fetchFn, ["calendar.read", "files.write"]).names).toEqual(["find_free_time", "list_events", "upload_file"]);
    expect(server(g.fetchFn, []).names).toEqual([]);
  });

  it("mail reads hit the right paths and give compact results", async () => {
    const g = graph({
      "GET /me/messages": json({ value: [message] }),
      "GET /me/mailFolders/sentitems/messages": json({ value: [message] }),
      "GET /me/mailFolders/inbox/messages": json({ value: [] }),
      "GET /me/messages/m%2F1": json({ ...message, ccRecipients: [], body: { contentType: "text", content: "y".repeat(25_000) } }),
    });
    const s = server(g.fetchFn);
    const found = out(await s.call("search_mail", { query: 'invoice "march"', top: 5 })) as Record<string, unknown>[];
    expect(found).toEqual([{ id: "m1", subject: "Invoice", from: "Bea <bea@example.test>", to: ["Ann <ann@example.test>"], date: "2026-11-01T08:00:00Z", preview: "x".repeat(300) }]);
    expect(g.seen[0]!.url.searchParams.get("$search")).toBe('"invoice march"');
    expect(g.seen[0]!.url.searchParams.get("$top")).toBe("5");
    expect(g.seen[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);

    await s.call("list_mail", { folder: "sent" });
    expect(g.seen[1]!.url.searchParams.get("$top")).toBe("10");
    await s.call("list_mail", {});
    expect(g.seen[2]!.url.pathname).toBe("/v1.0/me/mailFolders/inbox/messages");

    const read = out(await s.call("read_mail", { id: "m/1" })) as { body: string; preview?: string };
    expect(g.seen[3]!.headers.Prefer).toBe('outlook.body-content-type="text"');
    expect(read.body).toHaveLength(20_000);
    expect(read.preview).toBeUndefined();
  });

  it("refuses . and .. as ids, which would climb the Graph path", async () => {
    const g = graph();
    const s = server(g.fetchFn);
    for (const id of [".", ".."]) {
      for (const [name, args] of [["read_mail", { id }], ["reply_mail", { id, body: "b" }], ["respond_event", { id, response: "accept" }], ["read_file", { id }], ["read_chat", { id }]] as const) {
        await expect(s.call(name, args).then((r) => r.isError ?? false, () => true)).resolves.toBe(true);
      }
    }
    expect(g.seen).toHaveLength(0);
  });

  it("send and reply post to Graph as the person", async () => {
    const g = graph();
    const s = server(g.fetchFn);
    expect((await s.call("send_mail", { to: ["bea@example.test"], cc: ["cy@example.test"], subject: "Hi", body: "Hello" })).isError).toBeUndefined();
    expect(g.seen[0]).toMatchObject({ method: "POST", url: new URL("https://graph.microsoft.com/v1.0/me/sendMail") });
    expect(JSON.parse(g.seen[0]!.body!)).toEqual({
      message: { subject: "Hi", body: { contentType: "Text", content: "Hello" }, toRecipients: [{ emailAddress: { address: "bea@example.test" } }], ccRecipients: [{ emailAddress: { address: "cy@example.test" } }] },
      saveToSentItems: true,
    });
    await s.call("reply_mail", { id: "m1", body: "Thanks" });
    await s.call("reply_mail", { id: "m1", body: "Thanks all", all: true });
    expect(g.seen.slice(1).map((r) => [r.method, r.url.pathname, JSON.parse(r.body!)])).toEqual([
      ["POST", "/v1.0/me/messages/m1/reply", { comment: "Thanks" }],
      ["POST", "/v1.0/me/messages/m1/replyAll", { comment: "Thanks all" }],
    ]);
  });

  it("calendar tools read the view, find free time, book and respond", async () => {
    const ev = {
      id: "e1", subject: "Standup", start: { dateTime: "2026-11-02T09:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-02T09:15:00.0000000", timeZone: "UTC" },
      location: { displayName: "" }, organizer: { emailAddress: { name: "Bea", address: "bea@example.test" } }, isOnlineMeeting: true, onlineMeeting: { joinUrl: "https://teams.example.test/j" },
    };
    const g = graph({
      "GET /me/calendarView": json({ value: [ev] }),
      "POST /me/findMeetingTimes": json({ meetingTimeSuggestions: [{ confidence: 100, meetingTimeSlot: { start: { dateTime: "2026-11-02T10:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-02T10:30:00.0000000", timeZone: "UTC" } } }], emptySuggestionsReason: "" }),
      "POST /me/events": json(ev, 201),
    });
    const s = server(g.fetchFn);
    expect(out(await s.call("list_events", { from: "2026-11-02T00:00:00Z", to: "2026-11-03T00:00:00Z" }))).toEqual([
      { id: "e1", subject: "Standup", start: "2026-11-02T09:00:00.0000000Z", end: "2026-11-02T09:15:00.0000000Z", organizer: "Bea <bea@example.test>", online: true, joinUrl: "https://teams.example.test/j" },
    ]);
    expect(g.seen[0]!.url.searchParams.get("startDateTime")).toBe("2026-11-02T00:00:00.000Z");
    expect(g.seen[0]!.url.searchParams.get("endDateTime")).toBe("2026-11-03T00:00:00.000Z");
    expect(g.seen[0]!.headers.Prefer).toBe('outlook.timezone="UTC"');
    expect((await s.call("list_events", { from: "2026-11-01T00:00:00Z", to: "2026-12-03T00:00:00Z" })).isError).toBe(true);
    expect((await s.call("list_events", { from: "2026-11-03T00:00:00Z", to: "2026-11-02T00:00:00Z" })).isError).toBe(true);
    expect((await s.call("list_events", { from: "soon", to: "2026-11-02T00:00:00Z" })).isError).toBe(true);
    expect(g.seen).toHaveLength(1);

    expect(out(await s.call("find_free_time", { attendees: ["bea@example.test"], from: "2026-11-02T08:00:00Z", to: "2026-11-02T17:00:00Z", minutes: 30 }))).toEqual({
      suggestions: [{ start: "2026-11-02T10:00:00.0000000Z", end: "2026-11-02T10:30:00.0000000Z", confidence: 100 }],
    });
    expect(JSON.parse(g.seen[1]!.body!)).toMatchObject({
      attendees: [{ type: "required", emailAddress: { address: "bea@example.test" } }],
      timeConstraint: { timeSlots: [{ start: { dateTime: "2026-11-02T08:00:00.000", timeZone: "UTC" }, end: { dateTime: "2026-11-02T17:00:00.000", timeZone: "UTC" } }] },
      meetingDuration: "PT30M",
    });

    expect(out(await s.call("create_event", { subject: "Standup", start: "2026-11-02T09:00:00Z", end: "2026-11-02T09:15:00Z", attendees: ["bea@example.test"], online: true, body: "Agenda" }))).toMatchObject({ id: "e1", joinUrl: "https://teams.example.test/j" });
    expect(JSON.parse(g.seen[2]!.body!)).toEqual({
      subject: "Standup", start: { dateTime: "2026-11-02T09:00:00.000", timeZone: "UTC" }, end: { dateTime: "2026-11-02T09:15:00.000", timeZone: "UTC" },
      attendees: [{ type: "required", emailAddress: { address: "bea@example.test" } }], isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness", body: { contentType: "Text", content: "Agenda" },
    });

    await s.call("respond_event", { id: "e1", response: "tentative", comment: "Maybe" });
    await s.call("respond_event", { id: "e1", response: "decline" });
    expect(g.seen.slice(3).map((r) => [r.method, r.url.pathname, JSON.parse(r.body!)])).toEqual([
      ["POST", "/v1.0/me/events/e1/tentativelyAccept", { comment: "Maybe", sendResponse: true }],
      ["POST", "/v1.0/me/events/e1/decline", { sendResponse: true }],
    ]);
  });

  it("files: search, read text through the download URL without the token, and upload without overwriting", async () => {
    const doc = { id: "f1", name: "notes.md", size: 12, webUrl: "https://files.example.test/notes", lastModifiedDateTime: "2026-10-30T10:00:00Z", file: { mimeType: "text/markdown" }, "@microsoft.graph.downloadUrl": "https://download.example.test/f1" };
    const g = graph({
      "GET /me/drive/root/search(q='bob''s')": json({ value: [doc, { id: "d1", name: "Plans", folder: { childCount: 2 } }] }),
      "GET /me/drive/items/f1": json(doc),
      "GET /me/drive/items/f2": json({ ...doc, id: "f2", name: "deck.pptx", file: { mimeType: "application/vnd.ms-powerpoint" } }),
      "GET https://download.example.test/f1": () => new Response("z".repeat(30_000), { status: 206 }),
      "PUT /me/drive/root:/Reports/2026/summary.txt:/content": json({ id: "f3", name: "summary 1.txt", size: 5, webUrl: "https://files.example.test/s" }, 201),
    });
    const s = server(g.fetchFn);
    expect(out(await s.call("search_files", { query: "bob's" }))).toEqual([
      { id: "f1", name: "notes.md", size: 12, modified: "2026-10-30T10:00:00Z", webUrl: "https://files.example.test/notes" },
      { id: "d1", name: "Plans", folder: true },
    ]);
    const read = out(await s.call("read_file", { id: "f1" })) as { text: string };
    expect(read.text).toHaveLength(20_000);
    const download = g.seen.find((r) => r.url.hostname === "download.example.test")!;
    expect(JSON.stringify(download.headers)).not.toContain(TOKEN);
    expect(out(await s.call("read_file", { id: "f2" }))).toMatchObject({ name: "deck.pptx", note: "not readable as text" });
    expect(g.seen.filter((r) => r.url.hostname === "download.example.test")).toHaveLength(1);

    expect(out(await s.call("upload_file", { folder: "/Reports/2026/", name: "summary.txt", content: "hello" }))).toMatchObject({ id: "f3", name: "summary 1.txt" });
    const put = g.seen.at(-1)!;
    expect(put.method).toBe("PUT");
    expect(put.url.searchParams.get("@microsoft.graph.conflictBehavior")).toBe("rename");
    expect(put.body).toBe("hello");
    const before = g.seen.length;
    expect((await s.call("upload_file", { folder: "a", name: "x/y.txt", content: "x" })).isError).toBe(true);
    expect((await s.call("upload_file", { folder: "../a", name: "y.txt", content: "x" })).isError).toBe(true);
    expect((await s.call("upload_file", { folder: "a\\b", name: "y.txt", content: "x" })).isError).toBe(true);
    expect((await s.call("upload_file", { folder: "c:/a", name: "y.txt", content: "x" })).isError).toBe(true);
    expect((await s.call("upload_file", { folder: "a", name: "y:z.txt", content: "x" })).isError).toBe(true);
    expect((await s.call("upload_file", { folder: "a", name: "big.txt", content: "x".repeat(4 * 1024 * 1024 + 1) })).isError).toBe(true);
    expect(g.seen).toHaveLength(before);
  });

  it("a download host that ignores Range is read only to about 80 KB, and its 401 is no reason to sign in again", async () => {
    const doc = { id: "f1", name: "big.log", size: 1e9, file: { mimeType: "text/plain" }, "@microsoft.graph.downloadUrl": "https://download.example.test/f1" };
    let pulled = 0;
    const endless = () =>
      new Response(new ReadableStream({ pull: (c) => void (pulled++, c.enqueue(new TextEncoder().encode("a".repeat(16_384)))) }), { status: 200 });
    const g = graph({ "GET /me/drive/items/f1": json(doc), "GET https://download.example.test/f1": endless });
    const s = server(g.fetchFn);
    expect(((out(await s.call("read_file", { id: "f1" })) as { text: string }).text)).toHaveLength(20_000);
    expect(pulled).toBeLessThan(10);

    const denied = graph({ "GET /me/drive/items/f1": json(doc), "GET https://download.example.test/f1": () => new Response("no", { status: 401 }) });
    const d = server(denied.fetchFn);
    const r = await d.call("read_file", { id: "f1" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).not.toMatch(/sign in/);
    expect(d.signInLost).not.toHaveBeenCalled();
  });

  it("chats: lists recent chats and reads a chat's messages as short text", async () => {
    const g = graph({
      "GET /me/chats": json({ value: [{ id: "19:c1", topic: null, chatType: "oneOnOne", lastMessagePreview: { createdDateTime: "2026-11-01T07:00:00Z", from: { user: { displayName: "Bea" } }, body: { content: "<p>See&nbsp;you</p>" } } }] }),
      "GET /me/chats/19%3Ac1/messages": json({ value: [{ id: "1", createdDateTime: "2026-11-01T07:00:00Z", from: { user: { displayName: "Bea" } }, body: { content: `<div>${"w".repeat(400)}</div>` } }] }),
    });
    const s = server(g.fetchFn);
    expect(out(await s.call("list_chats", { top: 3 }))).toEqual([{ id: "19:c1", type: "oneOnOne", last: { from: "Bea", date: "2026-11-01T07:00:00Z", preview: "See you" } }]);
    expect(g.seen[0]!.url.searchParams.get("$top")).toBe("3");
    expect(g.seen[0]!.url.searchParams.get("$expand")).toBe("lastMessagePreview");
    expect(out(await s.call("read_chat", { id: "19:c1", top: 50 }))).toEqual([{ id: "1", from: "Bea", date: "2026-11-01T07:00:00Z", text: "w".repeat(300) }]);
    expect(g.seen[1]!.url.searchParams.get("$top")).toBe("50");
  });

  it("a 401 or no token tells the person to sign in again, once, and nothing carries the token", async () => {
    const logged: unknown[] = [];
    const spies = (["log", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a) => void logged.push(...a)));
    const body = JSON.stringify({ error: { code: "InvalidAuthenticationToken", message: `Bearer ${TOKEN} expired` } });
    const g = graph({ "GET /me/messages": () => new Response(body, { status: 401 }), "POST /me/sendMail": () => new Response(body, { status: 500 }) });
    const first = server(g.fetchFn);
    const results = [
      await first.call("search_mail", { query: "x" }),
      await server(g.fetchFn, GRAPH_CAPABILITIES, async () => undefined).call("search_mail", { query: "x" }),
      await server(g.fetchFn).call("send_mail", { to: ["a@example.test"], subject: "s", body: "b" }),
      await server((async () => { throw new TypeError(`fetch failed ${TOKEN}`); }) as typeof fetch).call("list_chats"),
    ];
    spies.forEach((s) => s.mockRestore());
    expect(g.seen.filter((r) => r.url.pathname === "/v1.0/me/messages")).toHaveLength(1);
    expect(results.map((r) => r.isError)).toEqual([true, true, true, true]);
    expect(first.signInLost).toHaveBeenCalledTimes(1); // the turn signs the person out, so the next message brings the card
    expect(results[0]!.content[0]!.text).toMatch(/sign in again/);
    expect(results[1]!.content[0]!.text).toBe(results[0]!.content[0]!.text);
    expect(results[2]!.content[0]!.text).toContain("500");
    expect(JSON.stringify([results, logged])).not.toContain(TOKEN);
    expect(JSON.stringify(logged)).not.toContain("expired");
  });
});
