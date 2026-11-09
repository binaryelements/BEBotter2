import { describe, expect, it, vi } from "vitest";
import { GRAPH_CAPABILITIES } from "../db/schema.js";
import type { GraphCapability } from "../db/schema.js";
import { m365McpServer } from "./mcp.js";

const TOKEN = "eyJ0b2stZ3JhcGgtc2VjcmV0";
type Result = { isError?: boolean; content: { text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
type Seen = { method: string; url: URL; headers: Record<string, string>; body?: string; bytes?: Uint8Array };

/** Graph faked at fetch: answers by "METHOD path", recording every request. */
function graph(answers: Record<string, () => Response> = {}) {
  const seen: Seen[] = [];
  const fetchFn = (async (u: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(u));
    const method = init.method ?? "GET";
    seen.push({ method, url, headers: (init.headers ?? {}) as Record<string, string>, ...(typeof init.body === "string" ? { body: init.body } : init.body instanceof Uint8Array ? { bytes: init.body } : {}) });
    const answer = answers[`${method} ${url.hostname === "graph.microsoft.com" ? url.pathname.replace("/v1.0", "") : url.href}`];
    return answer ? answer() : new Response(null, { status: 202 });
  }) as typeof fetch;
  return { fetchFn, seen };
}
const json = (v: unknown, status = 200) => () => new Response(JSON.stringify(v), { status });

function server(fetchFn: typeof fetch, capabilities: readonly GraphCapability[] = GRAPH_CAPABILITIES, token: () => Promise<string | undefined> = async () => TOKEN, readDocument?: (pdf: string) => Promise<string>, docx?: (markdown: string, title?: string) => Buffer) {
  const signInLost = vi.fn();
  const files: Record<string, { name: string; mediaType: string; bytes: Uint8Array }> = { f1: { name: "switch.jpg", mediaType: "image/jpeg", bytes: Buffer.from("jpg") }, big: { name: "big.bin", mediaType: "application/octet-stream", bytes: Buffer.alloc(3 * 1024 * 1024 + 1) } };
  const s = m365McpServer({ fetchFn, sleep: async () => {}, ...(readDocument ? { readDocument } : {}), ...(docx ? { docx } : {}) }, { graphToken: token, signInLost, attachment: async (id) => files[id] }, capabilities);
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
      ["create_document", "create_event", "find_free_time", "list_chats", "list_events", "list_mail", "read_attachment", "read_chat", "read_file", "read_mail", "reply_mail", "respond_event", "search_files", "search_mail", "send_mail", "upload_file"].sort(),
    );
    expect(server(g.fetchFn, ["mail.read"]).names).toEqual(["list_mail", "read_attachment", "read_mail", "search_mail"]);
    expect(server(g.fetchFn, ["calendar.read", "files.write"]).names).toEqual(["create_document", "find_free_time", "list_events", "upload_file"]);
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

  it("read_mail lists attachments; read_attachment reads text, PDFs through the reader, and images as images", async () => {
    const file = (name: string, contentType: string, content: string) => json({ "@odata.type": "#microsoft.graph.fileAttachment", id: "a1", name, contentType, size: content.length, contentBytes: Buffer.from(content).toString("base64") });
    const g = graph({
      "GET /me/messages/m1": json({ ...message, hasAttachments: true, body: { content: "see attached" } }),
      "GET /me/messages/m1/attachments": json({ value: [{ id: "a1", name: "inv.pdf", contentType: "application/pdf", size: 9, isInline: false }] }),
      "GET /me/messages/m1/attachments/pdf": file("inv.pdf", "application/pdf", "%PDF-1.4 x"),
      "GET /me/messages/m1/attachments/txt": file("notes.csv", "text/csv", "a,b\n1,2"),
      "GET /me/messages/m1/attachments/pptx": file("Deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "PK deck"),
      "GET /me/messages/m1/attachments/png": file("logo.png", "image/png", "PNGDATA"),
      "GET /me/messages/m1/attachments/zip": file("x.zip", "application/zip", "PK"),
      "GET /me/messages/m1/attachments/mail": json({ "@odata.type": "#microsoft.graph.itemAttachment", id: "a2", name: "Fwd", size: 10 }),
    });
    const readDocument = vi.fn(async () => "Invoice 777: internet 99.00");
    const s = server(g.fetchFn, ["mail.read"], undefined, readDocument);
    const read = out(await s.call("read_mail", { id: "m1" })) as { attachments: unknown };
    expect(read.attachments).toEqual([{ id: "a1", name: "inv.pdf", type: "application/pdf", size: 9 }]);
    expect(g.seen[1]!.url.searchParams.get("$select")).toBe("id,name,contentType,size,isInline");

    expect(out(await s.call("read_attachment", { id: "m1", attachmentId: "pdf" }))).toMatchObject({ name: "inv.pdf", text: "Invoice 777: internet 99.00" });
    expect(readDocument).toHaveBeenCalledWith(Buffer.from("%PDF-1.4 x").toString("base64"), "inv.pdf");
    expect(out(await s.call("read_attachment", { id: "m1", attachmentId: "pptx" }))).toMatchObject({ name: "Deck.pptx", text: "Invoice 777: internet 99.00" });
    expect(readDocument).toHaveBeenLastCalledWith(Buffer.from("PK deck").toString("base64"), "Deck.pptx");
    expect(out(await s.call("read_attachment", { id: "m1", attachmentId: "txt" }))).toMatchObject({ text: "a,b\n1,2" });
    expect((await s.call("read_attachment", { id: "m1", attachmentId: "png" })).content).toEqual([{ type: "image", data: Buffer.from("PNGDATA").toString("base64"), mimeType: "image/png" }]);
    expect(out(await s.call("read_attachment", { id: "m1", attachmentId: "zip" }))).toMatchObject({ note: "not readable as text" });
    expect(out(await s.call("read_attachment", { id: "m1", attachmentId: "mail" }))).toMatchObject({ note: "an attached email or link, not a file" });
    expect(await s.call("read_attachment", { id: "..", attachmentId: "pdf" })).toMatchObject({ isError: true });
  });

  it("read_attachment keeps a long document whole, and says so when one is too long to keep", async () => {
    const pdf = json({ "@odata.type": "#microsoft.graph.fileAttachment", id: "a1", name: "guide.pdf", contentType: "application/pdf", size: 3, contentBytes: Buffer.from("PDF").toString("base64") });
    const g = graph({ "GET /me/messages/m1/attachments/a1": pdf });
    const whole = "x".repeat(60_000);
    expect(out(await server(g.fetchFn, ["mail.read"], undefined, async () => whole).call("read_attachment", { id: "m1", attachmentId: "a1" }))).toMatchObject({ text: whole });
    const cut = out(await server(g.fetchFn, ["mail.read"], undefined, async () => "x".repeat(90_000)).call("read_attachment", { id: "m1", attachmentId: "a1" })) as { text: string; note: string };
    expect(cut.text).toHaveLength(80_000);
    expect(cut.note).toBe("cut short: first 80000 of 90000 characters");
  });

  it("a PDF attachment without a reader gives its details only, and a reader's failure says nothing of the document", async () => {
    const pdf = json({ "@odata.type": "#microsoft.graph.fileAttachment", id: "a1", name: "inv.pdf", contentType: "application/pdf", size: 3, contentBytes: Buffer.from("PDF").toString("base64") });
    const g = graph({ "GET /me/messages/m1/attachments/a1": pdf });
    expect(out(await server(g.fetchFn, ["mail.read"]).call("read_attachment", { id: "m1", attachmentId: "a1" }))).toMatchObject({ note: "not readable as text" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await server(g.fetchFn, ["mail.read"], undefined, async () => { throw new Error("secret invoice text"); }).call("read_attachment", { id: "m1", attachmentId: "a1" });
      expect(r).toMatchObject({ isError: true, content: [{ text: "Microsoft 365 error" }] });
      expect(JSON.stringify(spy.mock.calls)).not.toContain("secret invoice text");
    } finally {
      spy.mockRestore();
    }
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

  it("send and reply post to Graph as the person, with files from the chat along; an unknown or oversize file is refused before anything is sent", async () => {
    const g = graph();
    const s = server(g.fetchFn);
    expect((await s.call("send_mail", { to: ["bea@example.test"], subject: "Pic", body: "See attached", attachmentIds: ["f1"] })).isError).toBeUndefined();
    expect(JSON.parse(g.seen[0]!.body!).message.attachments).toEqual([{ "@odata.type": "#microsoft.graph.fileAttachment", name: "switch.jpg", contentType: "image/jpeg", contentBytes: Buffer.from("jpg").toString("base64") }]);
    expect((await s.call("reply_mail", { id: "m1", body: "here", attachmentIds: ["f1"] })).isError).toBeUndefined();
    expect(JSON.parse(g.seen[1]!.body!)).toMatchObject({ comment: "here", message: { attachments: [{ name: "switch.jpg" }] } });
    for (const ids of [["nope"], ["big"]]) expect((await s.call("send_mail", { to: ["bea@example.test"], subject: "x", body: "y", attachmentIds: ids })).isError).toBe(true);
    expect(g.seen).toHaveLength(2);
    g.seen.length = 0;
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

  it("creates a Word document from Markdown and uploads it as .docx", async () => {
    const g = graph({
      "PUT /me/drive/root:/Reports/Report.docx:/content": json({ id: "f4", name: "Report.docx", size: 9, webUrl: "https://files.example.test/r" }, 201),
    });
    const docx = vi.fn((markdown: string, _title?: string) => (markdown === "big" ? Buffer.alloc(4 * 1024 * 1024 + 1) : Buffer.from("PK docx")));
    const s = server(g.fetchFn, ["files.write"], undefined, undefined, docx);
    expect(out(await s.call("create_document", { folder: "/Reports/", name: "Report", title: "Quarterly report", content: "# Report\n\n- one\n- two" }))).toMatchObject({ id: "f4", name: "Report.docx" });
    expect(docx).toHaveBeenCalledWith("# Report\n\n- one\n- two", "Quarterly report");
    const put = g.seen.at(-1)!;
    expect(put.method).toBe("PUT");
    expect(put.headers["Content-Type"]).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(put.bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(put.bytes!).toString("utf8")).toBe("PK docx");
    expect(put.url.searchParams.get("@microsoft.graph.conflictBehavior")).toBe("rename");
    expect((await s.call("create_document", { folder: "a", name: "x/y.docx", content: "x" })).isError).toBe(true);
    expect((await s.call("create_document", { folder: "a", name: "big.docx", content: "big" })).isError).toBe(true);
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
