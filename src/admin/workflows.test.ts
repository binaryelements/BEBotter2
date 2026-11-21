import express from "express";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assignToChat, upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { botDefinitions, workflowRuns, workflows } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { createDepartment, setMembership, setRole } from "../org/directory.js";
import { upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import type { WorkflowGraph } from "../workflows/graph.js";
import { createWorkflow } from "../workflows/store.js";
import { adminRouter } from "./router.js";
import { serve, sessionCookie } from "./test-server.js";

const secretsKey = Buffer.alloc(32, 7);
const T = "tenant-wf";
const config = { teams: { clientId: "c", tenantId: T, clientSecret: "s" }, publicUrl: "https://bot.example.test", adminEmails: [], secretsKey };

const b = { x: 0, y: 0 };
// t -> a -> (w1 ->) e
const graph = (withWait: boolean): WorkflowGraph => ({
  nodes: [
    { ...b, id: "t", label: "Start", type: "trigger", trigger: "email" },
    { ...b, id: "a", label: "Read", type: "ai", instruction: "do", success: "ok", results: [{ name: "done", meaning: "done" }] },
    ...(withWait ? [{ ...b, id: "w1", label: "Wait a bit", type: "wait" as const, minutes: 60, businessHours: false }] : []),
    { ...b, id: "e", label: "Fin", type: "end", outcome: "fin" },
  ],
  edges: [
    { from: "t", exit: "next", to: "a" },
    { from: "a", exit: "done", to: withWait ? "w1" : "e" },
    ...(withWait ? [{ from: "w1", exit: "time_up", to: "e" }] : []),
  ],
  holidays: [],
});

describe("workflows screens", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  const id: Record<string, string> = {};
  let bot: string;
  let personal: string;

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: T });
    for (const name of ["Ann", "Hal"]) id[name] = (await upsertPerson(db, { tenantId: T, aadObjectId: `aad-${name}`, name })).id;
    await setRole(db, T, id.Ann, "admin");
    const sales = (await createDepartment(db, T, "Sales")).id;
    await setMembership(db, T, sales, id.Hal, "head");
    bot = (await upsertDefinition(db, randomBytes(32), T, { name: "ops", label: "Ops", persona: "p" })).id;
    personal = (await upsertDefinition(db, randomBytes(32), T, { name: "mine", label: "Mine", persona: "p" })).id;
    await db.update(botDefinitions).set({ identity: "person" }).where(eq(botDefinitions.id, personal));
    await upsertChat(db, { id: "chat-1", tenantId: T, conversationType: "groupChat" });
    await assignToChat(db, "chat-1", bot);
    const app = express();
    app.use("/admin", adminRouter({ db, config, exchangeCode: async () => ({ id_token: "x" }), verifyIdToken: async () => ({ oid: "", tid: "", name: "", email: "" }), botName: "Bot", defaultModel: "m", fetchUsers: async () => [] }));
    ({ url, close } = await serve(app));
  });
  afterAll(() => close());

  const get = (path: string, who = "Ann") => fetch(url + path, { redirect: "manual", headers: { cookie: sessionCookie(secretsKey, T, id[who]) } });
  const form = (path: string, body: [string, string][], who = "Ann") =>
    fetch(url + path, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie(secretsKey, T, id[who]) },
      body: new URLSearchParams([["csrf", "csrf-1"], ...body]).toString(),
    });
  const json = (path: string, body: Record<string, unknown>, who = "Ann") =>
    fetch(url + path, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", cookie: sessionCookie(secretsKey, T, id[who]) },
      body: JSON.stringify({ csrf: "csrf-1", ...body }),
    });
  const newWorkflow = async (name: string) => (await createWorkflow(db, T, { definitionId: bot, name, chatId: "chat-1", runAsPersonId: id.Ann })).id;
  const initOf = async (wid: string, who = "Ann") => {
    const page = await (await get(`/admin/bots/${bot}/workflows/${wid}`, who)).text();
    return JSON.parse(/<script type="application\/json" id="wf-init">([\s\S]*?)<\/script>/.exec(page)![1]);
  };

  it("workflows tab lists and creates", async () => {
    const tab = await (await get(`/admin/bots/${bot}?tab=workflows`)).text();
    expect(tab).toContain("new workflow");
    const res = await form(`/admin/bots/${bot}/workflows`, [["name", "Follow up"], ["chatId", "chat-1"]]);
    expect(res.status).toBe(303);
    const [w] = await db.select().from(workflows).where(eq(workflows.name, "Follow up"));
    expect(w).toMatchObject({ definitionId: bot, chatId: "chat-1", runAsPersonId: id.Ann });
    expect(res.headers.get("location")).toBe(`/admin/bots/${bot}/workflows/${w.id}`);
    const after = await (await get(`/admin/bots/${bot}?tab=workflows`)).text();
    expect(after).toContain("Follow up");
    expect(after).toContain("draft only");
    expect(after).toContain(`href="/admin/bots/${bot}/workflows/${w.id}"`);
  });

  it("person bots have no workflows", async () => {
    const page = await (await get(`/admin/bots/${personal}`)).text();
    expect(page).not.toContain("tab=workflows");
    // a row made behind the store's back is still refused everywhere
    const wid = crypto.randomUUID();
    await db.insert(workflows).values({ id: wid, tenantId: T, definitionId: personal, name: "x", chatId: "chat-1", runAsPersonId: id.Ann, draft: { nodes: [], edges: [], holidays: [] } });
    expect((await get(`/admin/bots/${personal}/workflows/${wid}`)).status).toBe(404);
    expect((await json(`/admin/workflows/${wid}/draft`, { graph: graph(false) })).status).toBe(404);
    expect((await get(`/admin/workflows/${wid}/versions`)).status).toBe(404);
    expect((await form(`/admin/bots/${personal}/workflows`, [["name", "x"], ["chatId", "chat-1"]])).status).toBe(404);
  });

  it("canvas page escapes init json", async () => {
    const wid = await newWorkflow("</script><b>x");
    const page = await (await get(`/admin/bots/${bot}/workflows/${wid}`)).text();
    expect(page).toContain("\\u003c/script");
    expect(page).not.toContain("</script><b>");
    const init = await initOf(wid);
    expect(init).toMatchObject({ workflowId: wid, name: "</script><b>x", published: false, readOnly: false, csrf: "csrf-1", draft: { nodes: [] } });
    expect(init.people).toContainEqual({ id: id.Hal, name: "Hal" });
    expect(page).toMatch(/src="\/admin\/assets\/workflows\/canvas\.js\?v=\w+"/);
  });

  it("save refuses a stale base", async () => {
    const wid = await newWorkflow("stale");
    const { base } = await initOf(wid);
    const first = await json(`/admin/workflows/${wid}/draft`, { graph: graph(false), base });
    expect(first.status).toBe(200);
    const next = (await first.json()).base;
    expect(next).not.toBe(base);
    expect((await initOf(wid)).base).toBe(next);
    const stale = await json(`/admin/workflows/${wid}/draft`, { graph: graph(true), base });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "changed by someone else; reload" });
    const bad = await json(`/admin/workflows/${wid}/draft`, { graph: { nodes: "no" }, base: next });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Invalid workflow/);
  });

  it("publish asks where stranded runs go", async () => {
    const wid = await newWorkflow("stranded");
    let { base } = await initOf(wid);
    ({ base } = await (await json(`/admin/workflows/${wid}/draft`, { graph: graph(true), base })).json());
    const v1 = await json(`/admin/workflows/${wid}/publish`, { moves: {} });
    expect(await v1.json()).toEqual({ version: 1 });
    await db.insert(workflowRuns).values({ id: crypto.randomUUID(), tenantId: T, workflowId: wid, nodeId: "w1", status: "waiting", keys: { threadIds: [], emails: [], domain: null }, fields: {}, title: "r" });
    await json(`/admin/workflows/${wid}/draft`, { graph: graph(false), base });
    const asked = await json(`/admin/workflows/${wid}/publish`, { moves: {} });
    expect(asked.status).toBe(409);
    expect((await asked.json()).stranded).toEqual([{ nodeId: "w1", label: "Wait a bit", runs: 1 }]);
    const done = await json(`/admin/workflows/${wid}/publish`, { moves: { w1: "e" } });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ version: 2 });
    const versions = await (await get(`/admin/workflows/${wid}/versions`)).json();
    expect(versions.map((v: { version: number; live: boolean }) => [v.version, v.live])).toEqual([[2, true], [1, false]]);
    // restore copies v1 into the draft; discard puts the live v2 back
    expect((await json(`/admin/workflows/${wid}/restore`, { version: 1 })).status).toBe(200);
    expect((await initOf(wid)).draft.nodes.map((n: { id: string }) => n.id)).toContain("w1");
    expect((await json(`/admin/workflows/${wid}/discard`, {})).status).toBe(200);
    expect((await initOf(wid)).draft.nodes.map((n: { id: string }) => n.id)).not.toContain("w1");
    // a refusal is worded by the server
    await json(`/admin/workflows/${wid}/draft`, { graph: { nodes: [], edges: [], holidays: [] } });
    const refused = await json(`/admin/workflows/${wid}/publish`, { moves: {} });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain("Needs exactly one trigger");
  });

  it("heads can view but not save", async () => {
    const wid = await newWorkflow("view only");
    expect((await get(`/admin/bots/${bot}/workflows/${wid}`, "Hal")).status).toBe(200);
    expect((await initOf(wid, "Hal")).readOnly).toBe(true);
    expect((await get(`/admin/workflows/${wid}/versions`, "Hal")).status).toBe(200);
    for (const path of ["draft", "publish", "discard", "restore"]) expect((await json(`/admin/workflows/${wid}/${path}`, { graph: graph(false), moves: {}, version: 1 }, "Hal")).status).toBe(403);
    expect((await form(`/admin/bots/${bot}/workflows`, [["name", "x"], ["chatId", "chat-1"]], "Hal")).status).toBe(403);
  });

  it("publishing an email workflow turns act mode off", async () => {
    // the earlier test published an email workflow already; this bot gets its own
    const other = (await upsertDefinition(db, randomBytes(32), T, { name: "mailer", label: "Mailer", persona: "p" })).id;
    await assignToChat(db, "chat-1", other);
    await db.update(botDefinitions).set({ mailMode: "act" }).where(eq(botDefinitions.id, other));
    const wid = (await createWorkflow(db, T, { definitionId: other, name: "mail", chatId: "chat-1", runAsPersonId: id.Ann })).id;
    await json(`/admin/workflows/${wid}/draft`, { graph: graph(false) });
    expect((await json(`/admin/workflows/${wid}/publish`, { moves: {} })).status).toBe(200);
    const [d] = await db.select({ mailMode: botDefinitions.mailMode }).from(botDefinitions).where(eq(botDefinitions.id, other));
    expect(d.mailMode).toBe("notify");
  });
});
