import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import type { Engine, EngineRunInput } from "../engine/engine.js";
import { listNotes, readNote } from "../knowledge/store.js";
import { createDepartment, setMembership, setRole } from "../org/directory.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { parseReview, runbookPath } from "./runbooks.js";
import { adminRouter } from "./router.js";
import { serve, sessionCookie } from "./test-server.js";

const secretsKey = Buffer.alloc(32, 5);
const T = "tenant-1";
const config = { teams: { clientId: "c", tenantId: T, clientSecret: "s" }, publicUrl: "https://bot.example.test", adminEmails: [], secretsKey };
const MODEL = "deepseek/deepseek-flash";

const reviewJson = JSON.stringify({
  understood: true,
  summary: "Diagnoses BE Voice by checking the SBC, the SIP trunk and the PBX.",
  systems: ["BE Voice", "SBC", "SIP trunk", "PBX"],
  connections: [{ name: "conn-sbc", why: "read the SBC status" }],
  checks: [{ step: "1", system: "SBC", connection: "conn-sbc", command: "systemctl status sbc", healthy: "active (running)", ifNot: "escalate to the SBC owner" }],
  missing: ["No carrier trunk id"],
  ambiguous: ["Does not say what to do when only one user is affected"],
  safety: ["Restarting the SBC is a write and must be confirmed"],
  testCases: [{ symptom: "I can't access BE Voice", expected: "Check the SBC, then the trunk" }],
});

const fakeEngine = (reply: string, seen?: { input?: EngineRunInput }): Engine => ({
  run: async (input) => {
    if (seen) seen.input = input;
    return { text: reply, messages: [], usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.001 }, steps: 1, stopReason: "text" };
  },
});

describe("runbooks screen", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  const id: Record<string, string> = {};
  let botId: string;
  const seen: { input?: EngineRunInput } = {};

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: T });
    for (const name of ["Ann", "Hal"]) id[name] = (await upsertPerson(db, { tenantId: T, aadObjectId: `aad-${name}`, name })).id;
    await setRole(db, T, id.Ann, "admin");
    await setMembership(db, T, (await createDepartment(db, T, "Sales")).id, id.Hal, "head");
    botId = (await upsertDefinition(db, secretsKey, T, { name: "it-support", label: "IT Support", persona: "Diagnose.", model: MODEL, mcpServers: [] })).id;
    const app = express();
    app.use(
      "/admin",
      adminRouter({
        db,
        config,
        exchangeCode: async () => ({ id_token: "x" }),
        verifyIdToken: async () => ({ oid: "", tid: "", name: "", email: "" }),
        botName: "Bot",
        defaultModel: MODEL,
        models: [MODEL],
        engine: fakeEngine(reviewJson, seen),
        runTurn: async () => ({ text: "ok", costUsd: 0, changed: false, timings: { receivedAt: new Date().toISOString(), tools: 0 }, auditId: "a" }),
        fetchUsers: async () => [],
      }),
    );
    ({ url, close } = await serve(app));
  });
  afterAll(() => close());

  const get = (path: string, who: string) => fetch(url + path, { redirect: "manual", headers: { cookie: sessionCookie(secretsKey, T, id[who]) } });
  const post = (path: string, who: string, data: Record<string, string>) =>
    fetch(url + path, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie(secretsKey, T, id[who]) },
      body: new URLSearchParams({ ...data, csrf: "csrf-1" }).toString(),
    });

  it("an admin uploads a markdown runbook, and it belongs to the bot they picked", async () => {
    const res = await post("/admin/runbooks/upload", "Ann", { bot: botId, path: "", file: "BE Voice.md", body: "# BE Voice\n\nCheck the SBC." });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/runbooks/review?path=troubleshooting%2Fbe-voice.md");
    const note = await readNote(db, secretsKey, T, "troubleshooting/be-voice.md");
    expect(note?.body).toContain("Check the SBC.");
    expect(note?.definitionId).toBe(botId);
    expect((await listNotes(db, secretsKey, T)).map((n) => n.path)).toContain("troubleshooting/be-voice.md");
    expect(await (await get("/admin/runbooks", "Ann")).text()).toContain("troubleshooting/be-voice.md");
    // no bot, or someone else's bot, and nothing is saved
    expect((await post("/admin/runbooks/upload", "Ann", { path: "troubleshooting/x.md", body: "x" })).status).toBeGreaterThanOrEqual(400);
    expect(await readNote(db, secretsKey, T, "troubleshooting/x.md")).toBeUndefined();
  });

  it("a head can read the list but cannot upload or review", async () => {
    expect(await (await get("/admin/runbooks", "Hal")).text()).toContain("troubleshooting/be-voice.md");
    expect((await post("/admin/runbooks/upload", "Hal", { path: "troubleshooting/x.md", body: "x" })).status).toBe(403);
    expect((await post("/admin/runbooks/review", "Hal", { path: "troubleshooting/be-voice.md" })).status).toBe(403);
  });

  it("the review shows what the model understood, what is missing, and a test link", async () => {
    const res = await post("/admin/runbooks/review", "Ann", { path: "troubleshooting/be-voice.md", model: MODEL });
    expect(res.status).toBe(200);
    const t = await res.text();
    expect(t).toContain("understood");
    expect(t).toContain("BE Voice");
    expect(t).toContain("conn-sbc");
    expect(t).toContain("systemctl status sbc");
    expect(t).toContain("No carrier trunk id");
    expect(t).toContain("I can&#39;t access BE Voice");
    expect(t).toContain(`/admin/runbooks/test`);
    // the model got the runbook and no tools
    expect(seen.input?.tools).toEqual([]);
    expect(seen.input?.maxSteps).toBe(1);
    expect(seen.input?.history[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(seen.input?.history[0])).toContain("Check the SBC.");
  });

  it("a reply that is not JSON is shown raw, not as a review", async () => {
    const app = express();
    app.use(
      "/admin",
      adminRouter({
        db,
        config,
        exchangeCode: async () => ({ id_token: "x" }),
        verifyIdToken: async () => ({ oid: "", tid: "", name: "", email: "" }),
        botName: "Bot",
        defaultModel: MODEL,
        models: [MODEL],
        engine: fakeEngine("I could not read this runbook."),
        fetchUsers: async () => [],
      }),
    );
    const other = await serve(app);
    try {
      const res = await fetch(`${other.url}/admin/runbooks/review`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie(secretsKey, T, id.Ann) },
        body: new URLSearchParams({ csrf: "csrf-1", path: "troubleshooting/be-voice.md", model: MODEL }).toString(),
      });
      const t = await res.text();
      expect(t).toContain("did not return a usable review");
      expect(t).toContain("I could not read this runbook.");
    } finally {
      await other.close();
    }
  });

  it("the test link opens the bot's try page with the prompt filled in", async () => {
    const res = await get(`/admin/runbooks/test?bot=${botId}&prompt=${encodeURIComponent("I can't access BE Voice")}`, "Ann");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/admin/bots/${botId}/try?prompt=I+can%27t+access+BE+Voice`);
    const page = await (await get(`/admin/bots/${botId}/try?prompt=${encodeURIComponent("I can't access BE Voice")}`, "Ann")).text();
    expect(page).toContain("I can&#39;t access BE Voice</textarea>");
  });

  it("an unknown bot is a 404", async () => {
    expect((await get("/admin/runbooks/test?bot=nope&prompt=x", "Ann")).status).toBe(404);
  });
});

describe("runbook helpers", () => {
  it("derives a safe path from a file name or a given path", () => {
    expect(runbookPath("", "BE Voice.md")).toBe("troubleshooting/be-voice.md");
    expect(runbookPath("be-voice", "")).toBe("troubleshooting/be-voice.md");
    expect(runbookPath("troubleshooting/be-voice.md", "")).toBe("troubleshooting/be-voice.md");
    expect(runbookPath("troubleshooting/network/dns.txt", "")).toBe("troubleshooting/network/dns.md");
    expect(() => runbookPath("", "")).toThrow();
  });

  it("parses JSON in a fence and tolerates a sentence before it", () => {
    expect(parseReview("```json\n" + reviewJson + "\n```")?.understood).toBe(true);
    expect(parseReview("Here is the review:\n" + reviewJson)?.systems).toContain("SBC");
    expect(parseReview("not json")).toBeUndefined();
  });
});
