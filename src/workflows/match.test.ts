import { beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { assignToChat, upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import { workflowRuns } from "../db/schema.js";
import { upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { matchEmail } from "./match.js";
import type { RunKeys } from "./types.js";
import { createWorkflow } from "./store.js";

describe("matchEmail", () => {
  let db: Db;
  let wfId: string;
  let n = 0;
  const addRun = async (status: string, keys: Partial<RunKeys>) => {
    const id = crypto.randomUUID();
    // distinct updatedAt so "most recently updated" is well defined
    await db.insert(workflowRuns).values({ id, tenantId: "t1", workflowId: wfId, nodeId: "a", status, keys: { threadIds: [], emails: [], domain: null, ...keys }, fields: {}, title: "r", updatedAt: new Date(Date.UTC(2026, 0, 1, 0, n++)) });
    return id;
  };

  beforeEach(async () => {
    db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const defId = (await upsertDefinition(db, randomBytes(32), "t1", { name: "ops", label: "Ops", persona: "p" })).id;
    await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "groupChat" });
    await assignToChat(db, "c1", defId);
    const ann = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "a1", name: "Ann" })).id;
    wfId = (await createWorkflow(db, "t1", { definitionId: defId, name: "wf", chatId: "c1", runAsPersonId: ann })).id;
  });

  it("a thread match wakes", async () => {
    const id = await addRun("waiting", { threadIds: ["th1"], emails: ["x@acme.com"] });
    await addRun("waiting", { emails: ["bob@acme.com"] });
    expect(await matchEmail(db, wfId, { threadId: "th1", from: "bob@acme.com" })).toEqual({ kind: "wake", runId: id });
  });

  it("a sender match wakes", async () => {
    const id = await addRun("running", { emails: ["bob@acme.com"], domain: "acme.com" });
    expect(await matchEmail(db, wfId, { threadId: "other", from: "bob@acme.com" })).toEqual({ kind: "wake", runId: id });
  });

  it("an uppercase sender matches", async () => {
    const id = await addRun("waiting", { emails: ["bob@acme.com"] });
    expect(await matchEmail(db, wfId, { threadId: null, from: "Bob@ACME.com" })).toEqual({ kind: "wake", runId: id });
  });

  it("the same company domain asks", async () => {
    const id = await addRun("waiting", { emails: ["bob@acme.com"], domain: "acme.com" });
    expect(await matchEmail(db, wfId, { threadId: null, from: "sue@Acme.com" })).toEqual({ kind: "ask", runId: id, why: "domain" });
  });

  it("a gmail.com domain never asks", async () => {
    await addRun("waiting", { emails: ["bob@gmail.com"], domain: "gmail.com" });
    expect(await matchEmail(db, wfId, { threadId: null, from: "sue@gmail.com" })).toEqual({ kind: "new" });
  });

  it("an ended run asks ended, by thread or sender only", async () => {
    const id = await addRun("done", { threadIds: ["th1"], emails: ["bob@acme.com"], domain: "acme.com" });
    expect(await matchEmail(db, wfId, { threadId: "th1", from: "new@other.com" })).toEqual({ kind: "ask", runId: id, why: "ended" });
    expect(await matchEmail(db, wfId, { threadId: null, from: "bob@acme.com" })).toEqual({ kind: "ask", runId: id, why: "ended" });
    expect(await matchEmail(db, wfId, { threadId: null, from: "sue@acme.com" })).toEqual({ kind: "new" });
  });

  it("an open run wins over an ended one", async () => {
    await addRun("failed", { emails: ["bob@acme.com"] });
    const open = await addRun("needs_person", { emails: ["sue@acme.com"], domain: "acme.com" });
    await addRun("done", { emails: ["bob@acme.com"] });
    expect(await matchEmail(db, wfId, { threadId: null, from: "bob@acme.com" })).toEqual({ kind: "ask", runId: open, why: "domain" });
  });

  it("nothing matches: new", async () => {
    await addRun("waiting", { threadIds: ["th1"], emails: ["bob@acme.com"], domain: "acme.com" });
    expect(await matchEmail(db, wfId, { threadId: "th2", from: "sue@other.com" })).toEqual({ kind: "new" });
  });

  it("several open matches: the most recently updated", async () => {
    await addRun("waiting", { emails: ["bob@acme.com"] });
    const newest = await addRun("waiting", { emails: ["bob@acme.com"] });
    await db.insert(workflowRuns).values({ id: "older", tenantId: "t1", workflowId: wfId, nodeId: "a", status: "waiting", keys: { threadIds: [], emails: ["bob@acme.com"], domain: null }, fields: {}, title: "r", updatedAt: new Date(Date.UTC(2025, 0, 1)) });
    expect(await matchEmail(db, wfId, { threadId: null, from: "bob@acme.com" })).toEqual({ kind: "wake", runId: newest });
  });
});
