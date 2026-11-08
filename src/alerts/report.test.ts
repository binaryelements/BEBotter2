import { describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { upsertDefinition } from "../bots/definitions.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { buildDailyReport } from "./report.js";

describe("daily report", () => {
  it("summarises the last 24 hours", async () => {
    const db: Db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const person = await upsertPerson(db, { tenantId: "t1", aadObjectId: "u1", name: "Ann" });
    const bot = await upsertDefinition(db, Buffer.alloc(32, 1), "t1", { name: "mickey", label: "IT Support", displayName: "Mickey", persona: "p" });
    const now = new Date();
    await db.insert(auditEvents).values([
      { id: "e1", tenantId: "t1", definitionId: bot.id, personId: person.id, kind: "message", summary: "hi", status: "done", startedAt: now, costUsd: "0.01" },
      { id: "e2", tenantId: "t1", definitionId: bot.id, personId: person.id, kind: "tool", toolName: "mcp__x__y", summary: "Mail server unreachable", status: "failed", startedAt: now },
    ]);
    const r = await buildDailyReport(db, "t1", "UTC", "https://bot.example.test");
    expect(r.subject).toContain("Daily report");
    expect(r.body).toContain("Replies: 1");
    expect(r.body).toContain("Actions: 1 (0 done, 0 declined, 1 failed, 0 waiting)");
    expect(r.body).toContain("Mickey · IT Support: 1 reply");
    expect(r.body).toContain("Ann: 1");
    expect(r.body).toContain("Mail server unreachable");
    expect(r.body).toContain("https://bot.example.test/admin");
  });
});
