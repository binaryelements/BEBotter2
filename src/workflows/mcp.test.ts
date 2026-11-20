import { beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { assignToChat, upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import { workflowRuns } from "../db/schema.js";
import { upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { createWorkflow } from "./store.js";
import { workflowMcpServer } from "./mcp.js";

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;
const report = (s: ReturnType<typeof workflowMcpServer>) => (s.instance as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools.report_result.handler;

describe("workflow mcp", () => {
  let db: Db;
  const run = async () => (await db.select().from(workflowRuns).where(eq(workflowRuns.id, "r1")))[0];
  const server = (nodeId = "a") => workflowMcpServer({ db }, { runId: "r1", nodeId, results: ["done", "stop"], saves: ["order_no"] });
  beforeEach(async () => {
    db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const defId = (await upsertDefinition(db, randomBytes(32), "t1", { name: "ops", label: "Ops", persona: "p" })).id;
    await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "groupChat" });
    await assignToChat(db, "c1", defId);
    const personId = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "a1", name: "Ann" })).id;
    const wf = await createWorkflow(db, "t1", { definitionId: defId, name: "wf", chatId: "c1", runAsPersonId: personId });
    await db.insert(workflowRuns).values({ id: "r1", tenantId: "t1", workflowId: wf.id, nodeId: "a", status: "running", title: "x", keys: { threadIds: [], emails: ["bob@acme.com"], domain: null }, fields: {} });
  });

  it("stores a valid result on the run", async () => {
    const r = await report(server())({ result: "done", reason: "ok", fields: { order_no: "42" } });
    expect(r).toMatchObject({ content: [{ text: "Recorded. End the step now." }] });
    expect(await run()).toMatchObject({ reportedResult: { result: "done", reason: "ok", fields: { order_no: "42" } }, fields: { order_no: "42" } });
  });

  it("accepts needs_person and refuses an unknown result, naming the allowed ones", async () => {
    expect((await report(server())({ result: "needs_person", reason: "?" })).isError).toBeUndefined();
    const r = await report(server())({ result: "nope", reason: "?" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("done, stop, needs_person");
  });

  it("refuses a field the step does not save", async () => {
    const r = await report(server())({ result: "done", reason: "ok", fields: { secret: "x" } });
    expect(r.isError).toBe(true);
    expect((await run()).reportedResult).toBeNull();
  });

  it("adds email (lowercased) and thread_id to the keys, without duplicates", async () => {
    await report(server())({ result: "done", reason: "ok", fields: { email: " Bob@Acme.com ", thread_id: "th1" } });
    await report(server())({ result: "done", reason: "ok", fields: { email: "Ann@Acme.com", thread_id: "th1" } });
    expect((await run()).keys).toEqual({ threadIds: ["th1"], emails: ["bob@acme.com", "ann@acme.com"], domain: null });
  });

  it("refuses when the run has moved on from the node or is no longer running", async () => {
    const r = await report(server("other"))({ result: "done", reason: "ok" });
    expect(r).toMatchObject({ isError: true, content: [{ text: "This step has moved on" }] });
    await db.update(workflowRuns).set({ status: "waiting" }).where(eq(workflowRuns.id, "r1"));
    expect((await report(server())({ result: "done", reason: "ok" })).isError).toBe(true);
    expect((await run()).reportedResult).toBeNull();
  });
});
