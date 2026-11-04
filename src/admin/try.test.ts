import express from "express";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginAction, completeAction } from "../audit/audit.js";
import { setAllowedDepartments, upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { sessions } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { Confirmations } from "../engine/confirm.js";
import type { RunTurnInput } from "../engine/runner.js";
import { createDepartment, setMembership, setRole } from "../org/directory.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { adminRouter } from "./router.js";
import { serve, sessionCookie } from "./test-server.js";
import { tryChatId } from "./try.js";

const secretsKey = Buffer.alloc(32, 5);
const T = "tenant-1";
const config = { teams: { clientId: "c", tenantId: T, clientSecret: "s" }, publicUrl: "https://bot.example.test", adminEmails: [], secretsKey };

describe("try it", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  const id: Record<string, string> = {};
  let bot: string;
  const turns: RunTurnInput[] = [];
  const confirmations = new Confirmations();

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: T });
    for (const name of ["Ann", "Hal", "Eve"]) id[name] = (await upsertPerson(db, { tenantId: T, aadObjectId: `aad-${name}`, name })).id;
    await setRole(db, T, id.Ann, "admin");
    const sales = await createDepartment(db, T, "Sales");
    await setMembership(db, T, sales.id, id.Hal, "head");
    bot = (await upsertDefinition(db, secretsKey, T, { name: "a", label: "Alpha", displayName: "Mickey", persona: "" })).id;
    await setAllowedDepartments(db, T, bot, [sales.id]);
    // a stand-in engine: streams a little, uses a tool, asks for a confirmation that nobody answers, writes its audit row
    const runTurn = async (t: RunTurnInput) => {
      turns.push(t);
      t.progress?.({ kind: "delta", text: "Hi " });
      t.progress?.({ kind: "tool", toolName: "mcp__x__y" });
      const { actionId, outcome } = confirmations.create({ auditId: "a1", mayConfirm: async () => true, ttlMs: 5 });
      await t.askConfirmation({ actionId, label: "Alpha", name: "Mickey", toolName: "mcp__connections__ssh_change", input: { name: "pve1", command: "uptime" } });
      await outcome;
      t.progress?.({ kind: "delta", text: "there" });
      const auditId = await beginAction(db, { tenantId: t.tenantId, chatId: t.chatId, definitionId: t.definition.id, personId: t.person.id, kind: "message", summary: "Hi there" });
      await completeAction(db, auditId, { status: "done" });
      return { text: "Hi there", costUsd: 0.0123, sessionId: "s", changed: false, timings: { receivedAt: "", tools: 1 }, auditId };
    };
    const app = express();
    app.use("/admin", adminRouter({ db, config, exchangeCode: async () => ({ id_token: "x" }), verifyIdToken: async () => ({ oid: "", tid: "", name: "", email: "" }), botName: "Bot", defaultModel: "m", fetchUsers: async () => [], runTurn, confirmations }));
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

  it("admins only; the page offers every person with their role and says who the bot won't talk to", async () => {
    expect((await get(`/admin/bots/${bot}/try`, "Hal")).status).toBe(403);
    const t = await (await get(`/admin/bots/${bot}/try`, "Ann")).text();
    expect(t).toContain(`<option value="${id.Ann}" selected>Ann · admin</option>`);
    expect(t).toContain(`<option value="${id.Hal}" >Hal · head of Sales</option>`);
    expect(t).toContain(`<option value="${id.Eve}" >Eve · user</option>`);
    expect(await (await get(`/admin/bots/${bot}/try?as=${id.Eve}`, "Ann")).text()).toContain("Eve can't talk to Mickey");
    expect(await (await get(`/admin/bots/${bot}/try?as=${id.Hal}`, "Ann")).text()).toContain('name="text"');
    expect((await get(`/admin/bots/${bot}/try?as=nope`, "Ann")).status).toBe(400);
  });

  it("runs the turn as the chosen person in the test chat and streams the reply, tools and the confirmation into the page", async () => {
    const r = await post(`/admin/bots/${bot}/try`, "Ann", [["as", id.Hal], ["text", "hello <there>"]]);
    expect(r.status).toBe(200);
    const t = await r.text();
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ tenantId: T, chatId: tryChatId(bot, id.Hal), text: "hello <there>" });
    expect(turns[0].person.id).toBe(id.Hal);
    expect(t).toContain('<p class="you">hello &lt;there&gt;</p>');
    expect(t).toContain('<span class="step">· x y</span>');
    expect(t).toContain("Mickey wants to ssh change pve1.</b> <span class=\"be-muted\">name: pve1 · command: uptime</span>");
    expect(t).toContain('</script>there<p class="be-muted meta">'); // streamed in pieces, and the final text is not repeated after them
    expect(t).not.toContain("Hi there");
    expect(t).toContain("$0.0123 · 1 tools");
    const again = await (await get(`/admin/bots/${bot}/try?as=${id.Hal}`, "Ann")).text();
    expect(again).toContain("earlier replies to Hal");
    expect(again).toContain("Hi there");
  });

  it("refuses a person the bot won't talk to, and an empty message", async () => {
    expect((await post(`/admin/bots/${bot}/try`, "Ann", [["as", id.Eve], ["text", "hi"]])).status).toBe(303);
    expect((await post(`/admin/bots/${bot}/try`, "Ann", [["as", id.Hal], ["text", "  "]])).status).toBe(303);
    expect(turns).toHaveLength(1);
  });

  it("answers a pending confirmation as the person, and forgets the chat on request", async () => {
    const { actionId, outcome } = confirmations.create({ auditId: "a2", mayConfirm: async (p) => p === id.Hal });
    const r = await post(`/admin/bots/${bot}/try/confirm`, "Ann", [["as", id.Hal], ["actionId", actionId], ["answer", "yes"]]);
    expect(await r.text()).toBe("confirmed");
    expect(await outcome).toEqual({ result: "confirmed", personId: id.Hal });
    expect(await (await post(`/admin/bots/${bot}/try/confirm`, "Ann", [["as", id.Hal], ["actionId", actionId], ["answer", "yes"]])).text()).toBe("unknown");

    await db.insert(sessions).values({ chatId: tryChatId(bot, id.Hal), definitionId: bot, sdkSessionId: "sdk-1" });
    expect((await post(`/admin/bots/${bot}/try/reset`, "Ann", [["as", id.Hal]])).status).toBe(303);
    expect(await db.select().from(sessions).where(eq(sessions.chatId, tryChatId(bot, id.Hal)))).toHaveLength(0);
  });
});
