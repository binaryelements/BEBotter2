import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import { upsertDefinition } from "../bots/definitions.js";
import { getTenantSettings, setTenantSettings, upsertTenant } from "../org/org.js";
import type { agentMailAdmin } from "../mail/agentmail.js";
import { sendAlert, sendTestAlert } from "./alert.js";

type Admin = ReturnType<typeof agentMailAdmin>;

describe("alerts", () => {
  let db: Db;
  let bot: string;
  const sent = vi.fn(async () => {});
  const admin = {
    findInbox: vi.fn(async () => ({ id: "inbox-1", address: "teammate-admin@eml.binaryelements.com", ownerAgent: "be-teammate-admin" })),
    createInbox: vi.fn(),
    sendMessage: sent,
  } as unknown as Admin;

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: "t1" });
    bot = (await upsertDefinition(db, Buffer.alloc(32, 1), "t1", { name: "mickey", label: "IT Support", persona: "p" })).id;
    const s = await getTenantSettings(db, "t1");
    await setTenantSettings(db, "t1", { ...s, alertBotId: bot, alertEmails: "ops@example.com, ann@example.com", alertLowBalance: true, alertFailures: true, alertApprovals: false, alertBalanceThreshold: 5 });
  });

  it("sends an enabled alert from the chosen bot and throttles the same condition", async () => {
    expect(await sendAlert({ db, admin, publicUrl: "https://bot.example.test" }, "t1", "balance", "low-balance", "DeepSeek balance is $3.00", "Top it up.")).toBe(true);
    expect(sent).toHaveBeenCalledWith(expect.objectContaining({
      inboxId: "inbox-1",
      to: ["ops@example.com", "ann@example.com"],
      subject: "[BE Teammate] DeepSeek balance is $3.00",
    }));
    const call = sent.mock.calls[0] as unknown as [{ text: string }];
    expect(call[0].text).toContain("Top it up.");
    expect(call[0].text).toContain("IT Support · BE Teammate");
    expect(await sendAlert({ db, admin, publicUrl: "https://bot.example.test" }, "t1", "balance", "low-balance", "Again", "Body")).toBe(false);
  });

  it("does not send a kind that is switched off, or when there are no recipients", async () => {
    expect(await sendAlert({ db, admin, publicUrl: "https://bot.example.test" }, "t1", "approvals", "x", "Approvals", "Body")).toBe(false);
    const s = await getTenantSettings(db, "t1");
    await setTenantSettings(db, "t1", { ...s, alertEmails: null });
    expect(await sendAlert({ db, admin, publicUrl: "https://bot.example.test" }, "t1", "failures", "x", "Failures", "Body")).toBe(false);
    await setTenantSettings(db, "t1", { ...s, alertEmails: "ops@example.com", alertBotId: null });
  });

  it("sends a test alert without waiting for a condition", async () => {
    expect(await sendTestAlert({ db, admin }, "t1")).toBe(true);
    expect(sent).toHaveBeenCalledWith(expect.objectContaining({ subject: "[BE Teammate] Test alert", to: ["ops@example.com"] }));
  });
});
