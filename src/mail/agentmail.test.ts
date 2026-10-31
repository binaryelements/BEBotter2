import { describe, expect, it } from "vitest";
import { agentMailAdmin, MailError } from "./agentmail.js";

const ADMIN = "admin-key-secret";
const ISSUED = "issued-key-secret";

function setup(responses: Array<{ status?: number; body?: unknown } | Error>) {
  const calls: Array<{ url: string; method: string; auth: string | null; body: unknown }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method!, auth: (init.headers as Record<string, string>).Authorization ?? null, body: init.body ? JSON.parse(init.body as string) : undefined });
    const r = responses.shift()!;
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, mail: agentMailAdmin({ url: "https://mail.example", adminKey: ADMIN }, fetchFn) };
}

describe("agentMailAdmin", () => {
  it("creates an inbox and parses id and address", async () => {
    const { calls, mail } = setup([{ status: 201, body: { id: "i1", address: "ada@mail.example" } }]);
    expect(await mail.createInbox("ada", "Ada", "bot-1")).toEqual({ id: "i1", address: "ada@mail.example" });
    expect(calls[0]).toEqual({ url: "https://mail.example/inboxes", method: "POST", auth: `Bearer ${ADMIN}`, body: { local_part: "ada", display_name: "Ada", owner_agent: "bot-1" } });
  });

  it("patches active and display name", async () => {
    const { calls, mail } = setup([{ body: {} }, { body: {} }]);
    await mail.setInboxActive("i1", false);
    await mail.setDisplayName("i1", "Ada L");
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["PATCH", "https://mail.example/inboxes/i1", { active: false }],
      ["PATCH", "https://mail.example/inboxes/i1", { display_name: "Ada L" }],
    ]);
  });

  it("issues and revokes keys", async () => {
    const { calls, mail } = setup([{ status: 201, body: { id: "k1", key: ISSUED } }, { body: {} }]);
    expect(await mail.issueKey("bot-1", "bebotter")).toEqual({ id: "k1", key: ISSUED });
    await mail.revokeKey("k1");
    expect(calls[0]).toMatchObject({ url: "https://mail.example/agents/bot-1/keys", method: "POST", body: { label: "bebotter" } });
    expect(calls[1]).toMatchObject({ url: "https://mail.example/agent-keys/k1", method: "DELETE" });
  });

  it("adds and removes webhooks", async () => {
    const { calls, mail } = setup([{ status: 201, body: { id: "w1", signing_secret: "amwh_x" } }, { body: {} }]);
    expect(await mail.addWebhook("bot-1", "https://bot.example/hook", "i1")).toEqual({ id: "w1", secret: "amwh_x" });
    await mail.removeWebhook("w1");
    expect(calls[0]!.body).toEqual({ url: "https://bot.example/hook", inbox: "i1", events: ["message.received"] });
    expect(calls[1]).toMatchObject({ url: "https://mail.example/webhooks/w1", method: "DELETE" });
  });

  it("checks whether a local part is taken, ignoring case", async () => {
    const { mail } = setup([{ body: [{ id: "i1", address: "Ada@mail.example" }] }, { body: [{ id: "i1", address: "ada@mail.example" }] }]);
    expect(await mail.inboxTaken("ada")).toBe(true);
    expect(await mail.inboxTaken("grace")).toBe(false);
  });

  it("surfaces non-2xx as MailError with the status and no key", async () => {
    const { mail } = setup([{ status: 409, body: { detail: `echo ${ADMIN}` } }]);
    const err = await mail.createInbox("ada", "Ada", "bot-1").catch((e) => e);
    expect(err).toBeInstanceOf(MailError);
    expect(err.status).toBe(409);
    expect(err.message).not.toContain(ADMIN);
  });

  it("turns a network failure into MailError and rejects incomplete responses without leaking keys", async () => {
    const { mail } = setup([new Error(`connect failed ${ADMIN}`), { status: 201, body: { id: "k1" } }]);
    const down = await mail.revokeKey("k1").catch((e) => e);
    expect(down).toBeInstanceOf(MailError);
    expect(down.message).not.toContain(ADMIN);
    const bad = await mail.issueKey("bot-1", "x").catch((e) => e);
    expect(bad).toBeInstanceOf(MailError);
    expect(bad.message).not.toContain(ISSUED);
  });

  it("finds an inbox with its owner and lists live keys and webhooks", async () => {
    const { calls, mail } = setup([
      { body: [{ id: "i1", address: "Ada@mail.example", owner_agent: "bot-1" }] },
      { body: [{ id: "k1", revoked_at: null }, { id: "k2", revoked_at: "2026-01-01T00:00:00Z" }] },
      { body: [{ id: "w1" }] },
    ]);
    expect(await mail.findInbox("ada")).toEqual({ id: "i1", address: "Ada@mail.example", ownerAgent: "bot-1" });
    expect(await mail.listKeys("bot-1")).toEqual(["k1"]);
    expect(await mail.listWebhooks("bot-1")).toEqual(["w1"]);
    expect(calls.map((c) => c.url)).toEqual(["https://mail.example/inboxes", "https://mail.example/agents/bot-1/keys", "https://mail.example/agents/bot-1/webhooks"]);
  });

  it("reads the mail domain and manages send-as", async () => {
    const { calls, mail } = setup([{ body: { mail_domain: "eml.example" } }, { body: { ready: true, checks: [] } }, { body: {} }, { body: { status: "ok" } }, { body: {} }]);
    expect(await mail.mailDomain()).toBe("eml.example");
    expect(await mail.mailDomain()).toBe("eml.example"); // cached: no second request
    expect(await mail.checkSendAs("a@co.example")).toEqual({ ok: true, reasons: [] });
    await mail.requestSendAs("i1", "a@co.example");
    expect(await mail.getSendAs("i1")).toEqual({ status: "ok" });
    await mail.removeSendAs("i1");
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["GET", "https://mail.example/status", undefined],
      ["GET", "https://mail.example/send-as-check?address=a%40co.example", undefined],
      ["POST", "https://mail.example/inboxes/i1/send-as", { address: "a@co.example" }],
      ["GET", "https://mail.example/inboxes/i1/send-as", undefined],
      ["DELETE", "https://mail.example/inboxes/i1/send-as", undefined],
    ]);
  });

  it("refuses unless BE AgentMail answers ready: true", async () => {
    const { mail } = setup([{ body: { checks: [] } }, { body: { ready: false, checks: [] } }]);
    expect((await mail.checkSendAs("a@co.example")).ok).toBe(false);
    expect((await mail.checkSendAs("a@co.example")).ok).toBe(false);
  });

  it("a negative check lists its reasons (DMARC is only reported) and a refusal keeps a cleaned detail", async () => {
    const { mail } = setup([
      { body: { ready: false, checks: [{ name: "spf", ok: false, detail: "no record" }, { name: "dmarc", ok: false, detail: "none" }, { name: "dkim", ok: true, detail: "" }] } },
      { status: 422, body: { detail: `domain not signed bam_abc123 ${"x".repeat(300)}` } },
    ]);
    expect(await mail.checkSendAs("a@co.example")).toEqual({ ok: false, reasons: ["spf: no record"] });
    const e = await mail.requestSendAs("i1", "a@co.example").catch((x) => x);
    expect(e).toBeInstanceOf(MailError);
    expect(e.detail.length).toBeLessThanOrEqual(200);
    expect(e.detail).toContain("domain not signed");
    expect(e.detail).not.toContain("bam_");
  });
});
