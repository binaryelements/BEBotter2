import express from "express";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assignToChat, setAllowedDepartments, upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { botDefinitions, workflowRunEvents, workflowRuns, workflows } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { createDepartment, setMembership, setRole } from "../org/directory.js";
import { upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import type { WorkflowGraph } from "../workflows/graph.js";
import { createWorkflow, draftHash, publish, saveDraft } from "../workflows/store.js";
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
  let sales: string;

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: T });
    for (const name of ["Ann", "Hal", "Eve"]) id[name] = (await upsertPerson(db, { tenantId: T, aadObjectId: `aad-${name}`, name })).id;
    await setRole(db, T, id.Ann, "admin");
    sales = (await createDepartment(db, T, "Sales")).id;
    await setMembership(db, T, sales, id.Hal, "head");
    await setMembership(db, T, (await createDepartment(db, T, "Engineering")).id, id.Eve, "head");
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
    // a save without a base would skip the stale check
    const bare = await json(`/admin/workflows/${wid}/draft`, { graph: graph(false) });
    expect(bare.status).toBe(400);
    expect(await bare.json()).toEqual({ error: "missing base; reload" });
  });

  it("a failed JSON post answers JSON, never a redirect that reads as success", async () => {
    const wid = await newWorkflow("too big");
    const res = await fetch(url + `/admin/workflows/${wid}/draft`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", cookie: sessionCookie(secretsKey, T, id.Ann), referer: `${url}/admin/bots/${bot}/workflows/${wid}` },
      body: JSON.stringify({ csrf: "csrf-1", graph: { nodes: [], edges: [], holidays: ["x".repeat(1_100_000)] } }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Bad request." });
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
    await json(`/admin/workflows/${wid}/draft`, { graph: { nodes: [], edges: [], holidays: [] }, base: (await initOf(wid)).base });
    const refused = await json(`/admin/workflows/${wid}/publish`, { moves: {} });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain("Needs exactly one trigger");
  });

  it("heads can view but not save", async () => {
    const wid = await newWorkflow("view only");
    // like the bot page: a head sees the bots of their own departments only
    expect((await get(`/admin/bots/${bot}/workflows/${wid}`, "Hal")).status).toBe(404);
    await setAllowedDepartments(db, T, bot, [sales]);
    expect((await get(`/admin/bots/${bot}/workflows/${wid}`, "Hal")).status).toBe(200);
    expect((await initOf(wid, "Hal")).readOnly).toBe(true);
    expect((await get(`/admin/workflows/${wid}/versions`, "Hal")).status).toBe(200);
    for (const path of ["draft", "publish", "discard", "restore"]) expect((await json(`/admin/workflows/${wid}/${path}`, { graph: graph(false), moves: {}, version: 1 }, "Hal")).status).toBe(403);
    expect((await form(`/admin/bots/${bot}/workflows`, [["name", "x"], ["chatId", "chat-1"]], "Hal")).status).toBe(403);
  });

  it("a stale base on discard, restore and publish gives 409 and leaves the draft", async () => {
    const wid = await newWorkflow("stale all");
    let { base } = await initOf(wid);
    const manual = graph(true); // a manual trigger, so no other workflow's email trigger gets in the way
    manual.nodes = manual.nodes.map((n) => (n.id === "t" ? { ...n, trigger: "manual" as const } : n));
    ({ base } = await (await json(`/admin/workflows/${wid}/draft`, { graph: manual, base })).json());
    expect(await (await json(`/admin/workflows/${wid}/publish`, { moves: {}, base })).json()).toEqual({ version: 1 });
    const edited = (await (await json(`/admin/workflows/${wid}/draft`, { graph: graph(false), base })).json()).base; // someone else saved
    for (const [path, body] of [["discard", {}], ["restore", { version: 1 }], ["publish", { moves: {} }]] as const) {
      const res = await json(`/admin/workflows/${wid}/${path}`, { ...body, base });
      expect(res.status).toBe(409);
      expect((await initOf(wid)).base).toBe(edited);
    }
    // with the current base they go through and discard returns the new base
    const ok = await json(`/admin/workflows/${wid}/discard`, { base: edited });
    expect(ok.status).toBe(200);
    expect((await ok.json()).base).toBe((await initOf(wid)).base);
  });

  it("another company's admin gets 404 on canvas, JSON routes and run pages", async () => {
    const wid = await newWorkflow("tenant a");
    const rid = crypto.randomUUID();
    await db.insert(workflowRuns).values({ id: rid, tenantId: T, workflowId: wid, nodeId: "a", status: "waiting", keys: { threadIds: [], emails: [], domain: null }, fields: {}, title: "x" });
    await upsertTenant(db, { id: "tenant-b" });
    const bob = (await upsertPerson(db, { tenantId: "tenant-b", aadObjectId: "aad-bob", name: "Bob" })).id;
    await setRole(db, "tenant-b", bob, "admin");
    const asB = (path: string, init: RequestInit = {}) => fetch(url + path, { redirect: "manual", ...init, headers: { "content-type": "application/json", cookie: sessionCookie(secretsKey, "tenant-b", bob) } });
    expect((await asB(`/admin/bots/${bot}/workflows/${wid}`)).status).toBe(404);
    expect((await asB(`/admin/workflows/${wid}/versions`)).status).toBe(404);
    expect((await asB(`/admin/workflows/${wid}/discard`, { method: "POST", body: JSON.stringify({ csrf: "csrf-1" }) })).status).toBe(404);
    expect((await asB(`/admin/workflow-runs/${rid}`)).status).toBe(404);
  });

  it("a head of an unlinked department sees nothing", async () => {
    const wid = await newWorkflow("not yours");
    expect((await get(`/admin/bots/${bot}/workflows/${wid}`, "Eve")).status).toBe(404);
    expect((await get(`/admin/workflows/${wid}/versions`, "Eve")).status).toBe(404);
    expect((await json(`/admin/workflows/${wid}/draft`, { graph: graph(false), base: "x" }, "Eve")).status).toBe(404);
  });

  describe("runs", () => {
    const keys = { threadIds: [], emails: [], domain: null };
    // a published workflow t -> a -> w1 -> e whose step "a" is labelled with markup
    const live = async (name: string) => {
      const wid = await newWorkflow(name);
      const g = graph(true);
      g.nodes = g.nodes.map((n) => (n.id === "a" ? { ...n, label: "<i>Read</i>" } : n.id === "t" ? { ...n, trigger: "manual" as const } : n));
      const { base } = await initOf(wid);
      await saveDraft(db, T, wid, g, base);
      await publish(db, T, wid, id.Ann, {});
      return wid;
    };
    const run = async (wid: string, nodeId: string, status: string, title: string) => {
      const rid = crypto.randomUUID();
      await db.insert(workflowRuns).values({ id: rid, tenantId: T, workflowId: wid, nodeId, status, keys, fields: {}, title });
      return rid;
    };
    const flash = (res: Response) => decodeURIComponent(/bb_flash=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "");

    it("status page shows open runs and filters needs_person", async () => {
      const wid = await live("status");
      await run(wid, "w1", "waiting", "Waiting one");
      await run(wid, "a", "needs_person", "Stuck one");
      await run(wid, "e", "done", "Finished one");
      const stuckId = (await db.select().from(workflowRuns).where(eq(workflowRuns.title, "Stuck one")))[0].id;
      await db.insert(workflowRunEvents).values([
        { id: crypto.randomUUID(), runId: stuckId, nodeId: "a", kind: "result", result: "done", reason: "the real reason", at: new Date(Date.UTC(2026, 0, 1)) },
        { id: crypto.randomUUID(), runId: stuckId, nodeId: "a", kind: "move", reason: "paused", at: new Date(Date.UTC(2026, 0, 2)) },
      ]);
      const open = await (await get(`/admin/bots/${bot}/workflows/${wid}/runs`)).text();
      expect(open).toContain("the real reason");
      expect(open).not.toContain("paused");
      expect(open).toContain("Waiting one");
      expect(open).toContain("Stuck one");
      expect(open).not.toContain("Finished one");
      expect(open).toContain("&lt;i&gt;Read&lt;/i&gt;");
      const stuck = await (await get(`/admin/bots/${bot}/workflows/${wid}/runs?show=needs_person`)).text();
      expect(stuck).toContain("Stuck one");
      expect(stuck).not.toContain("Waiting one");
      expect(await (await get(`/admin/bots/${bot}/workflows/${wid}/runs?show=all`)).text()).toContain("Finished one");
      expect((await get(`/admin/bots/${bot}/workflows/${wid}/runs`, "Eve")).status).toBe(404);
    });

    it("run page escapes labels", async () => {
      const wid = await live("escape");
      const rid = await run(wid, "a", "waiting", "<script>x</script>");
      await db.insert(workflowRunEvents).values({ id: crypto.randomUUID(), runId: rid, nodeId: "a", kind: "step", reason: "<b>why</b>" });
      const page = await (await get(`/admin/workflow-runs/${rid}`)).text();
      expect(page).not.toContain("<script>x</script>");
      expect(page).not.toContain("<i>Read</i>");
      expect(page).not.toContain("<b>why</b>");
      expect(page).toContain("&lt;i&gt;Read&lt;/i&gt;");
      expect(page).toContain(`/admin/bots/${bot}/workflows/${wid}?trace=${rid}`);
      expect((await get(`/admin/workflow-runs/${rid}`, "Eve")).status).toBe(404);
      expect((await get(`/admin/workflow-runs/nope`)).status).toBe(404);
    });

    it("pause then move a run from the run page", async () => {
      const wid = await live("move");
      const rid = await run(wid, "w1", "waiting", "Mover");
      const paused = await form(`/admin/workflow-runs/${rid}/pause`, []);
      expect(paused.status).toBe(303);
      expect(paused.headers.get("location")).toBe(`/admin/workflow-runs/${rid}`);
      expect((await db.select().from(workflowRuns).where(eq(workflowRuns.id, rid)))[0].status).toBe("needs_person");
      const page = await (await get(`/admin/workflow-runs/${rid}`)).text();
      expect(page).toContain("move");
      expect(page).not.toContain(">pause<");
      expect((await form(`/admin/workflow-runs/${rid}/move`, [["nodeId", "e"]], "Hal")).status).toBe(403);
      expect((await form(`/admin/workflow-runs/${rid}/move`, [["nodeId", "e"]])).status).toBe(303);
      expect((await db.select().from(workflowRuns).where(eq(workflowRuns.id, rid)))[0]).toMatchObject({ nodeId: "e", status: "done" });
    });

    it("end refuses a running run with a message", async () => {
      const wid = await live("end");
      const rid = await run(wid, "a", "running", "Busy");
      const res = await fetch(url + `/admin/workflow-runs/${rid}/end`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie(secretsKey, T, id.Ann), referer: `${url}/admin/workflow-runs/${rid}` },
        body: "csrf=csrf-1",
      });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`/admin/workflow-runs/${rid}`);
      expect(flash(res)).toContain("Wait for the step to finish");
      expect((await db.select().from(workflowRuns).where(eq(workflowRuns.id, rid)))[0].status).toBe("running");
      const ok = await run(wid, "w1", "waiting", "Ends");
      expect((await form(`/admin/workflow-runs/${ok}/end`, [])).status).toBe(303);
      expect((await db.select().from(workflowRuns).where(eq(workflowRuns.id, ok)))[0].status).toBe("done");
    });

    it("canvas init carries the trace of a run", async () => {
      const wid = await live("traced");
      const rid = await run(wid, "w1", "waiting", "Tr");
      await db.insert(workflowRunEvents).values({ id: crypto.randomUUID(), runId: rid, nodeId: "a", kind: "step" });
      const page = await (await get(`/admin/bots/${bot}/workflows/${wid}?trace=${rid}`)).text();
      const init = JSON.parse(/<script type="application\/json" id="wf-init">([\s\S]*?)<\/script>/.exec(page)![1]);
      expect(init.trace).toMatchObject({ runId: rid, title: "Tr" });
      expect(init.trace.steps.map((x: { nodeId: string }) => x.nodeId)).toEqual(["a"]);
      const other = await live("other");
      expect((await initOf(other)).trace).toBeUndefined();
      expect((await (await get(`/admin/bots/${bot}/workflows/${other}?trace=${rid}`)).text())).not.toContain('"trace"');
    });

    it("a trace view is read-only and draws the published graph, not the draft", async () => {
      const wid = await live("trace ro");
      const draft = graph(true);
      draft.nodes.push({ ...b, id: "only-draft", label: "Draft only", type: "end", outcome: "x" });
      await saveDraft(db, T, wid, draft, (await initOf(wid)).base);
      const rid = await run(wid, "w1", "waiting", "Ro");
      const page = await (await get(`/admin/bots/${bot}/workflows/${wid}?trace=${rid}`)).text();
      expect(page).toContain('"readOnly":true');
      const init = JSON.parse(/<script type="application\/json" id="wf-init">([\s\S]*?)<\/script>/.exec(page)![1]);
      const ids = init.draft.nodes.map((n: { id: string }) => n.id);
      expect(ids).toContain("w1");
      expect(ids).not.toContain("only-draft");
    });

    it("with nothing published the trace view falls back to the draft, still read-only", async () => {
      const wid = await newWorkflow("trace unpublished");
      const rid = await run(wid, "t", "waiting", "Un");
      const page = await (await get(`/admin/bots/${bot}/workflows/${wid}?trace=${rid}`)).text();
      const init = JSON.parse(/<script type="application\/json" id="wf-init">([\s\S]*?)<\/script>/.exec(page)![1]);
      expect(init.readOnly).toBe(true);
      expect(init.trace.runId).toBe(rid);
      expect(init.draft).toEqual((await db.select().from(workflows).where(eq(workflows.id, wid)))[0].draft);
    });
  });

  it("publishing an email workflow turns act mode off", async () => {
    // the earlier test published an email workflow already; this bot gets its own
    const other = (await upsertDefinition(db, randomBytes(32), T, { name: "mailer", label: "Mailer", persona: "p" })).id;
    await assignToChat(db, "chat-1", other);
    await db.update(botDefinitions).set({ mailMode: "act" }).where(eq(botDefinitions.id, other));
    const wid = (await createWorkflow(db, T, { definitionId: other, name: "mail", chatId: "chat-1", runAsPersonId: id.Ann })).id;
    const [{ draft }] = await db.select({ draft: workflows.draft }).from(workflows).where(eq(workflows.id, wid));
    expect((await json(`/admin/workflows/${wid}/draft`, { graph: graph(false), base: draftHash(draft) })).status).toBe(200);
    expect((await json(`/admin/workflows/${wid}/publish`, { moves: {} })).status).toBe(200);
    const [d] = await db.select({ mailMode: botDefinitions.mailMode }).from(botDefinitions).where(eq(botDefinitions.id, other));
    expect(d.mailMode).toBe("notify");
  });
});
