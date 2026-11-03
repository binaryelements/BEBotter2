import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "../db/test-db.js";
import type { Db } from "../db/client.js";
import { definitionsForChat, ensurePersonalDefinition, upsertDefinition } from "../bots/definitions.js";
import { chats } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { createDepartment, setMembership, setRole } from "../org/directory.js";
import { recordChatOwner, upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { beginAction } from "../audit/audit.js";
import { adminRouter } from "./router.js";
import { serve, sessionCookie } from "./test-server.js";

const secretsKey = Buffer.alloc(32, 5);
const T = "tenant-1";
const config = { teams: { clientId: "c", tenantId: T, clientSecret: "s" }, publicUrl: "https://bot.example.test", adminEmails: [], secretsKey };

describe("assignments screen", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  const id: Record<string, string> = {};
  let a: string;
  let b: string;
  const teamsId = "19:abc;messageid=1@thread.tacv2";

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: T });
    await upsertTenant(db, { id: "other" });
    for (const name of ["Ann", "Hal"]) id[name] = (await upsertPerson(db, { tenantId: T, aadObjectId: `aad-${name}`, name })).id;
    await setRole(db, T, id.Ann, "admin");
    await setMembership(db, T, (await createDepartment(db, T, "Sales")).id, id.Hal, "head");
    a = (await upsertDefinition(db, secretsKey, T, { name: "a", label: "Alpha", persona: "" })).id;
    b = (await upsertDefinition(db, secretsKey, T, { name: "b", label: "Beta", persona: "" })).id;
    await upsertChat(db, { id: "chat-1", tenantId: T, conversationType: "personal" });
    await upsertChat(db, { id: teamsId, tenantId: T, conversationType: "channel" });
    await upsertChat(db, { id: "foreign", tenantId: "other", conversationType: "personal" });
    const app = express();
    app.use("/admin", adminRouter({ db, config, exchangeCode: async () => ({ id_token: "x" }), verifyIdToken: async () => ({ oid: "", tid: "", name: "", email: "" }), botName: "Bot", defaultModel: "m", fetchUsers: async () => [] }));
    ({ url, close } = await serve(app));
  });
  afterAll(() => close());

  const get = (path: string, who: string) => fetch(url + path, { redirect: "manual", headers: { cookie: sessionCookie(secretsKey, T, id[who]) } });
  const post = (path: string, who: string, body: [string, string][]) =>
    fetch(url + path, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie(secretsKey, T, id[who]) },
      body: new URLSearchParams([["csrf", "csrf-1"], ...body]).toString(),
    });
  const assigned = async (chat: string) => (await definitionsForChat(db, chat)).map((d) => d.id);
  const path = (chat: string) => `/admin/assignments/${encodeURIComponent(chat)}`;

  it("shows the chat's Teams name until an admin labels it, the owner of a personal chat, and who has spoken in a group chat", async () => {
    await upsertChat(db, { id: "g1", tenantId: T, conversationType: "groupChat", name: "Project Falcon" });
    await upsertChat(db, { id: "g1", tenantId: T, conversationType: "groupChat" }); // a later message without the name keeps it
    expect((await db.select().from(chats).where(eq(chats.id, "g1")))[0].label).toBe("Project Falcon");
    await recordChatOwner(db, "chat-1", id.Ann);
    for (const who of ["Ann", "Hal"]) await beginAction(db, { tenantId: T, chatId: "g1", definitionId: a, personId: id[who], kind: "message", summary: "hi" });
    const page = await (await get("/admin/assignments", "Ann")).text();
    expect(page).toContain('value="Project Falcon"');
    expect(page).toMatch(/<td>groupChat<\/td><td>Ann, Hal<\/td>/);
    expect(page).toMatch(/<td>personal<\/td><td>Ann<\/td>/);
    expect(page).toContain(">listening</button>");
    expect((await post(path("g1") + "/listening", "Ann", [["listening", "off"]])).status).toBe(303);
    expect((await db.select().from(chats).where(eq(chats.id, "g1")))[0].listening).toBe(false);
    expect(await (await get("/admin/assignments", "Ann")).text()).toContain(">not listening</button>");
    expect((await post(path("g1") + "/listening", "Hal", [["listening", "on"]])).status).toBe(403);
    await post(path("g1") + "/label", "Ann", [["label", "Falcon team"]]);
    await upsertChat(db, { id: "g1", tenantId: T, conversationType: "groupChat", name: "Project Falcon" });
    expect((await db.select().from(chats).where(eq(chats.id, "g1")))[0].label).toBe("Falcon team");
  });

  it("upsertChat stamps lastSeenAt", async () => {
    const [row] = await db.select().from(chats).where(eq(chats.id, "chat-1"));
    expect(row.lastSeenAt).toBeInstanceOf(Date);
  });

  it("assigns, reassigns (old link gone) and unassigns", async () => {
    expect((await post(path("chat-1"), "Ann", [["definitionId", a]])).status).toBe(303);
    expect(await assigned("chat-1")).toEqual([a]);
    await post(path("chat-1"), "Ann", [["definitionId", b]]);
    expect(await assigned("chat-1")).toEqual([b]);
    const html = await (await get("/admin/assignments", "Ann")).text();
    expect(html).toMatch(new RegExp(`value="${b}" selected`));
    await post(path("chat-1"), "Ann", [["definitionId", ""]]);
    expect(await assigned("chat-1")).toEqual([]);
  });

  it("refuses Personal on a group chat with a 400 and changes nothing", async () => {
    const personal = await ensurePersonalDefinition(db, T, "m");
    expect((await post(path(teamsId), "Ann", [["definitionId", personal.id]])).status).toBe(400);
    expect(await assigned(teamsId)).toEqual([]);
    // offered only on one-to-one chats
    const rows = (await (await get("/admin/assignments", "Ann")).text()).split("<tr>");
    expect(rows.find((r) => r.includes(path("chat-1")))).toContain(`value="${personal.id}"`);
    expect(rows.find((r) => r.includes(path(teamsId)))).not.toContain(`value="${personal.id}"`);
  });

  it("refuses another tenant's chat and bot", async () => {
    expect((await post(path("foreign"), "Ann", [["definitionId", a]])).status).toBe(400);
    expect(await assigned("foreign")).toEqual([]);
    expect((await post(path("foreign") + "/label", "Ann", [["label", "x"]])).status).toBe(400);
    expect((await post(path("chat-1"), "Ann", [["definitionId", "nope"]])).status).toBe(400);
    expect(await assigned("chat-1")).toEqual([]);
    expect(await (await get("/admin/assignments", "Ann")).text()).not.toContain("foreign");
  });

  it("a head gets 403", async () => {
    expect((await get("/admin/assignments", "Hal")).status).toBe(403);
    expect((await post(path("chat-1"), "Hal", [["definitionId", a]])).status).toBe(403);
    expect((await post(path("chat-1") + "/label", "Hal", [["label", "x"]])).status).toBe(403);
    expect(await assigned("chat-1")).toEqual([]);
  });

  it("labels round-trip, are escaped, trimmed, and bounded", async () => {
    await post(path("chat-1") + "/label", "Ann", [["label", "  <b>Sales</b> & co  "]]);
    const html = await (await get("/admin/assignments", "Ann")).text();
    expect(html).toContain("&lt;b&gt;Sales&lt;/b&gt; &amp; co");
    expect(html).not.toContain("<b>Sales");
    expect((await post(path("chat-1") + "/label", "Ann", [["label", "x".repeat(81)]])).status).toBe(400);
    await post(path("chat-1") + "/label", "Ann", [["label", "  "]]);
    expect((await db.select().from(chats).where(eq(chats.id, "chat-1")))[0].label).toBeNull();
  });

  it("a Teams chat id with : and ; round-trips through the form URL", async () => {
    const html = await (await get("/admin/assignments", "Ann")).text();
    expect(html).toContain(`action="${path(teamsId)}"`);
    expect(path(teamsId)).toContain("%3B");
    expect((await post(path(teamsId), "Ann", [["definitionId", a]])).status).toBe(303);
    expect(await assigned(teamsId)).toEqual([a]);
  });
});
