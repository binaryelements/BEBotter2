import express from "express";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginAction, completeAction } from "../audit/audit.js";
import { setAllowedDepartments, upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { createDepartment, setMembership, setRole } from "../org/directory.js";
import { upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { adminRouter } from "./router.js";
import { serve, sessionCookie } from "./test-server.js";

const secretsKey = Buffer.alloc(32, 5);
const T = "tenant-1";
const config = { teams: { clientId: "c", tenantId: T, clientSecret: "s" }, publicUrl: "https://bot.example.test", adminEmails: [], secretsKey };

describe("activity screen", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  const id: Record<string, string> = {};
  let bot: string;
  let beta: string;
  let salesId: string;

  const add = async (who: string, summary: string, opts: { status?: "done" | "failed"; tool?: string; confirmedBy?: string; at?: Date; chat?: string; def?: string } = {}) => {
    const a = await beginAction(db, { tenantId: T, chatId: opts.chat ?? "chat-1", definitionId: opts.def ?? bot, personId: id[who], kind: opts.tool ? "tool" : "message", toolName: opts.tool, summary });
    await completeAction(db, a, { status: opts.status ?? "done", authority: opts.confirmedBy ? { type: "confirmation", personId: id[opts.confirmedBy] } : undefined });
    if (opts.at) await db.update(auditEvents).set({ startedAt: opts.at }).where(eq(auditEvents.id, a));
  };

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: T });
    for (const name of ["Ann", "Hal", "Sam", "Eve", "Oz"]) id[name] = (await upsertPerson(db, { tenantId: T, aadObjectId: `aad-${name}`, name })).id;
    await setRole(db, T, id.Ann, "admin");
    const sales = await createDepartment(db, T, "Sales");
    const ops = await createDepartment(db, T, "Ops");
    await setMembership(db, T, sales.id, id.Hal, "head");
    await setMembership(db, T, sales.id, id.Sam, "member");
    await setMembership(db, T, ops.id, id.Eve, "member");
    await setMembership(db, T, ops.id, id.Oz, "member");
    salesId = sales.id;
    bot = (await upsertDefinition(db, secretsKey, T, { name: "a", label: "Alpha", persona: "" })).id;
    beta = (await upsertDefinition(db, secretsKey, T, { name: "b", label: "Beta", persona: "" })).id;
    await setAllowedDepartments(db, T, bot, [sales.id]);
    await upsertChat(db, { id: "chat-1", tenantId: T, conversationType: "personal" });
    await upsertChat(db, { id: "chat-2", tenantId: T, conversationType: "personal" });
    await add("Sam", "=SUM(1,2)", { tool: "mcp__x__y", confirmedBy: "Hal" });
    await add("Sam", 'said "hi", there\nline two');
    await add("Oz", "oz-alpha");
    await add("Oz", "oz-beta", { def: beta });
    for (const [s, w] of [["-1", "Eve"], ["+1", "Eve"], ["@x", "Eve"], ["\tx", "Eve"]]) await add(w, s, { status: "failed", chat: "chat-2" });
    const app = express();
    app.use("/admin", adminRouter({ db, config, exchangeCode: async () => ({ id_token: "x" }), verifyIdToken: async () => ({ oid: "", tid: "", name: "", email: "" }), botName: "Bot", defaultModel: "m", fetchUsers: async () => [] }));
    ({ url, close } = await serve(app));
  });
  afterAll(() => close());

  const get = (path: string, who: string) => fetch(url + path, { redirect: "manual", headers: { cookie: sessionCookie(secretsKey, T, id[who]) } });

  it("admin sees every row; table shows tool, message and confirmer", async () => {
    const t = await (await get("/admin/activity", "Ann")).text();
    expect(t).toContain("Eve");
    expect(t).toContain("Alpha");
    expect(t).toContain("<td>x y</td>"); // the tool as words, with its server
    expect(t).toContain('<option value="">any bot</option>');
    expect(t).toContain('<option value="chat-2" >chat-2</option>');
    expect(t).toContain("message");
    expect(t).toContain("confirmed by Hal");
    expect(t).not.toContain(">older<");
  });

  it("shows timings for message rows that have them", async () => {
    const r = new Date("2026-01-01T00:00:00Z").getTime();
    const iso = (s: number) => new Date(r + s * 1000).toISOString();
    const a = await beginAction(db, { tenantId: T, chatId: "chat-1", definitionId: bot, personId: id.Sam, kind: "message", summary: "timed-row" });
    await completeAction(db, a, { status: "done", timings: { receivedAt: iso(0), engineReadyAt: iso(3), firstOutputAt: iso(16), firstToolAt: iso(17), resultAt: iso(22), sentAt: iso(23), tools: 2 } });
    const t = await (await get("/admin/activity", "Ann")).text();
    expect(t).toContain('aria-label="total 23.0 s: engine ready 3.0 s, model and tools 19.0 s, delivery 1.0 s"');
    expect(t).toContain("<li class=\"t2\">model and tools 19.0 s</li>");
    for (const w of ["13.0", "82.6", "4.3"]) expect(t).toContain(`style="width:${w}%"`); // 3 + 19 + 1 of 23 s
  });

  it("filters combine", async () => {
    const t = await (await get(`/admin/activity?person=${id.Eve}&status=failed&chat=chat-2&bot=${bot}`, "Ann")).text();
    expect(t).toContain("<td>Eve</td>");
    expect(t).not.toContain("<td>Sam</td>"); // Sam stays in the person dropdown, not the rows
    const none = await (await get(`/admin/activity?person=${id.Eve}&status=done`, "Ann")).text();
    expect(none).not.toContain("Eve</td>");
    const arr = await get(`/admin/activity?status=done&status=failed`, "Ann");
    expect(arr.status).toBe(200);
  });

  it("a head sees only their departments, in the page and the csv, and gets 403 for outsiders", async () => {
    const t = await (await get("/admin/activity", "Hal")).text();
    expect(t).toContain("Sam");
    expect(t).not.toContain("Eve");
    const csv = await (await get("/admin/activity.csv", "Hal")).text();
    expect(csv).toContain("Sam");
    expect(csv).not.toContain("Eve");
    expect((await get(`/admin/activity?person=${id.Eve}`, "Hal")).status).toBe(403);
    expect((await get(`/admin/activity.csv?person=${id.Eve}`, "Hal")).status).toBe(403);
    expect((await get(`/admin/activity?person=${id.Sam}`, "Hal")).status).toBe(200);
  });

  it("a head who adds an outsider sees their rows only for bots linked to the head's departments", async () => {
    const res = await fetch(`${url}/admin/departments/${salesId}/members`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie(secretsKey, T, id.Hal) },
      body: new URLSearchParams({ personId: id.Oz, state: "member", csrf: "csrf-1" }).toString(),
    });
    expect(res.status).toBe(303);
    for (const path of ["/admin/activity", "/admin/activity.csv", `/admin/activity?person=${id.Oz}`, `/admin/activity.csv?person=${id.Oz}&bot=${beta}`]) {
      const t = await (await get(path, "Hal")).text();
      expect(t).not.toContain("oz-beta");
      if (!path.includes(beta)) expect(t).toContain("oz-alpha");
    }
    expect(await (await get("/admin/activity", "Ann")).text()).toContain("oz-beta");
  });

  it("csv has headers, RFC 4180 quoting and neutralises formula starters", async () => {
    const r = await get("/admin/activity.csv", "Ann");
    expect(r.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="activity.csv"');
    expect(r.headers.get("cache-control")).toBe("no-store");
    const csv = await r.text();
    expect(csv.startsWith("time,person,bot,chat,tool,status,summary,confirmed_by\r\n")).toBe(true);
    expect(csv).toContain('"\'=SUM(1,2)","Hal"');
    expect(csv).toContain('"said ""hi"", there\nline two"');
    for (const s of ["-1", "+1", "@x", "\tx"]) expect(csv).toContain(`"'${s}"`);
  });

  it("Older pages on to the next rows and ignores a bad before", async () => {
    for (let i = 0; i < 100; i++) await add("Eve", `bulk ${i}`, { at: new Date(Date.UTC(2020, 0, 1, 0, i)), chat: "chat-2" });
    const first = await (await get("/admin/activity", "Ann")).text();
    const link = first.match(/href="([^"]+)">older/)?.[1].replaceAll("&amp;", "&");
    expect(link).toContain("before=");
    const next = await (await get(link!, "Ann")).text();
    expect(next).toContain("bulk");
    expect(next).not.toContain(">older<");
    expect(first).not.toContain("2020-01-01T00:00");
    expect((await get("/admin/activity?before=nonsense", "Ann")).status).toBe(200);
  });

  it("paging never skips rows that share a timestamp", async () => {
    const tie = new Date(Date.UTC(2021, 0, 1));
    for (let i = 0; i < 105; i++) await add("Eve", `tie-${i}`, { at: i >= 94 ? tie : new Date(Date.UTC(2021, 0, 2, 0, i)), chat: "chat-2" });
    const seen: string[] = [];
    let path: string | undefined = `/admin/activity?chat=chat-2&bot=${bot}&person=${id.Eve}&status=done`;
    while (path) {
      const t = await (await get(path, "Ann")).text();
      seen.push(...[...t.matchAll(/tie-\d+/g)].map((m) => m[0]));
      path = t.match(/href="([^"]+)">older/)?.[1].replaceAll("&amp;", "&");
    }
    expect(seen.sort()).toEqual([...Array(105).keys()].map((i) => `tie-${i}`).sort());
  });
});
