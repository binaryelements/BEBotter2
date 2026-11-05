import { describe, expect, it, vi } from "vitest";
import { testDb } from "../db/test-db.js";
import { upsertChat, upsertTenant } from "../org/org.js";
import { attachmentsMcpServer, incomingAttachments, pruneAttachments, recentAttachments, storeAttachments, withAttachments } from "./attachments.js";

type Handler = (args: Record<string, string>) => Promise<{ isError?: boolean; content: { type: string; text?: string; data?: string; mimeType?: string }[] }>;
const png = Buffer.from("89504e470d0a1a0a", "hex");

describe("chat attachments", () => {
  it("takes images and files off a Teams message, images with the bot's token, and skips cards and the html copy", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => new Response(url.toString().includes("teams-img") ? png : "hello", { status: (init?.headers as Record<string, string>)?.Authorization === "Bearer bot" || !url.toString().includes("teams-img") ? 200 : 401 }));
    const items = incomingAttachments({ attachments: [
      { contentType: "text/html", content: "<p>hi</p>" },
      { contentType: "image/png", contentUrl: "https://smba.example/teams-img/1" },
      { contentType: "application/vnd.microsoft.teams.file.download.info", name: "notes.txt", content: { downloadUrl: "https://files.example/notes", fileType: "txt" } },
      { contentType: "application/vnd.microsoft.card.adaptive", content: {} },
    ] }, fetchFn as unknown as typeof fetch, async () => "bot");
    expect(items.map((i) => [i.name, i.mediaType])).toEqual([["image.png", "image/png"], ["notes.txt", "text/plain"]]);
    expect(await items[0]!.download()).toEqual(png);
    expect((await items[1]!.download()).toString()).toBe("hello");
  });

  it("keeps what was posted, lists the last ten minutes newest first, opens an image as itself and a text file as text, and prunes", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "personal" });
    await upsertChat(db, { id: "c2", tenantId: "t1", conversationType: "personal" });
    const t0 = new Date("2026-11-05T10:00:00Z");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const [old] = await storeAttachments(db, { tenantId: "t1", chatId: "c1", senderName: "Ann", at: new Date(t0.getTime() - 11 * 60_000) }, [{ name: "old.txt", mediaType: "text/plain", download: async () => Buffer.from("old") }]);
    const posted = await storeAttachments(db, { tenantId: "t1", chatId: "c1", senderName: "Ann", at: new Date(t0.getTime() - 3 * 60_000) }, [
      { name: "shaver.png", mediaType: "image/png", download: async () => png },
      { name: "broken.pdf", mediaType: "application/pdf", download: async () => { throw new Error("403"); } },
    ]);
    const [now] = await storeAttachments(db, { tenantId: "t1", chatId: "c1", senderName: "Bob", at: t0 }, [{ name: "notes.txt", mediaType: "text/plain", download: async () => Buffer.from("the serial is 123") }]);
    err.mockRestore();
    expect(posted.map((p) => p.name)).toEqual(["shaver.png"]);
    const recent = await recentAttachments(db, "c1", t0);
    expect(recent.map((r) => r.name)).toEqual(["notes.txt", "shaver.png"]);
    expect(withAttachments(recent, "what is this?", t0)).toBe(
      `[Files and images posted in this chat, newest first; open one with read_attachment and its id when it matters:\n- notes.txt (text/plain, id ${now!.id}) from Bob, with this message\n- shaver.png (image/png, id ${posted[0]!.id}) from Ann, 3 min ago]\n\nwhat is this?`,
    );
    expect(withAttachments([], "hi")).toBe("hi");

    const tools = (attachmentsMcpServer({ db }, { chatId: "c1" }).instance as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
    const call = (id: string) => tools.read_attachment!.handler({ id });
    expect((await call(posted[0]!.id)).content).toEqual([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
    expect(JSON.parse((await call(now!.id)).content[0]!.text!)).toEqual({ name: "notes.txt", type: "text/plain", from: "Bob", text: "the serial is 123" });
    expect((await call("nope")).isError).toBe(true);
    const other = (attachmentsMcpServer({ db }, { chatId: "c2" }).instance as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
    expect((await other.read_attachment!.handler({ id: now!.id })).isError).toBe(true); // another chat's file is not this chat's

    expect(await pruneAttachments(db, "t1", 30, new Date("2026-12-10T00:00:00Z"))).toBe(3);
    expect(old).toBeDefined();
  });
});
