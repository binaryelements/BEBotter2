import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { botDefinitions, mailboxes } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { upsertTenant } from "../org/org.js";
import { decrypt } from "../secrets/cipher.js";
import { MailError } from "./agentmail.js";
import { ensureAllMailboxes, ensureMailbox, MailboxError, removeMailbox, requestMailbox, restoreMailbox } from "./mailboxes.js";
import type { MailDeps } from "./mailboxes.js";

const secretsKey = Buffer.alloc(32, 7);

async function setup(opts: { taken?: string[]; failKeyOnce?: boolean } = {}) {
  const db = await testDb();
  await upsertTenant(db, { id: "t1" });
  const calls: string[] = [];
  const taken = new Set(opts.taken ?? []);
  let failKey = opts.failKeyOnce ?? false;
  let n = 0;
  const admin = {
    inboxTaken: async (l: string) => (calls.push(`taken ${l}`), taken.has(l)),
    createInbox: async (l: string, d: string, a: string) => (calls.push(`create ${l} | ${d} | ${a}`), taken.add(l), { id: `inbox-${++n}`, address: `${l}@mail.test` }),
    setInboxActive: async (id: string, on: boolean) => void calls.push(`active ${id} ${on}`),
    setDisplayName: async (id: string, name: string) => void calls.push(`name ${id} ${name}`),
    issueKey: async (a: string) => {
      calls.push(`key ${a}`);
      if (failKey) { failKey = false; throw new MailError("down"); }
      return { id: `key-${++n}`, key: "am_secret" };
    },
    revokeKey: async (id: string) => void calls.push(`revoke ${id}`),
    addWebhook: async (a: string, url: string, inbox: string) => (calls.push(`hook ${url} ${inbox}`), { id: `hook-${++n}`, secret: "amwh_secret" }),
    removeWebhook: async (id: string) => void calls.push(`unhook ${id}`),
  };
  const deps: MailDeps = { db, secretsKey, admin, publicUrl: "https://bot.test" };
  const def = async (name: string, displayName: string | null = null) => {
    const id = crypto.randomUUID();
    await db.insert(botDefinitions).values({ id, tenantId: "t1", name, displayName, label: `${name} label`, persona: "", model: "m", webSearch: false, computer: false, mcpServers: [] });
    return id;
  };
  return { db, deps, calls, def, taken };
}

// opt-in create: request, then read the row back
async function make(deps: MailDeps, id: string, local = `bot-${id.slice(0, 6)}`) {
  await requestMailbox(deps, id, local);
  return (await deps.db.select().from(mailboxes).where(eq(mailboxes.definitionId, id)))[0]!;
}

describe("mailboxes", () => {
  it("creates the inbox, an encrypted key and a webhook", async () => {
    const { deps, calls, def } = await setup();
    const id = await def("Support Bot", "Ada Lovelace");
    const m = await make(deps, id, "Ada-Lovelace");
    expect(m.address).toBe("ada-lovelace@mail.test");
    expect(m.status).toBe("active");
    expect(m.keyCipher).not.toContain("am_secret");
    expect(decrypt(secretsKey, m.keyCipher!)).toBe("am_secret");
    expect(decrypt(secretsKey, m.webhookSecretCipher!)).toBe("amwh_secret");
    expect(calls[1]).toBe(`create ada-lovelace | Ada Lovelace (Support Bot label) | bb2-${id.slice(0, 12)}`);
    expect(calls).toContain("hook https://bot.test/mail/inbound inbox-1");
  });

  it("refuses a taken address and creates nothing", async () => {
    const { deps, calls, def, db } = await setup({ taken: ["sales"] });
    const a = await def("one");
    const b = await def("two");
    await make(deps, a, "ada");
    await expect(requestMailbox(deps, b, "ada")).rejects.toMatchObject({ reason: "taken" }); // ours
    await expect(requestMailbox(deps, b, "sales")).rejects.toMatchObject({ reason: "taken" }); // theirs
    expect(calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
    expect(await db.select().from(mailboxes)).toHaveLength(1);
  });

  it("treats a 409 on create as taken and leaves no row", async () => {
    const { deps, def, db } = await setup();
    deps.admin.createInbox = async () => { throw new MailError("exists", 409); };
    await expect(requestMailbox(deps, await def("bot"), "ada")).rejects.toBeInstanceOf(MailboxError);
    expect(await db.select().from(mailboxes)).toHaveLength(0);
  });

  it("rejects an invalid address", async () => {
    const { deps, calls, def } = await setup();
    const id = await def("bot");
    for (const bad of ["", "a b", "x@y", "ünï", "a".repeat(37)]) await expect(requestMailbox(deps, id, bad)).rejects.toMatchObject({ reason: "invalid" });
    expect(calls).toEqual([]);
  });

  it("resumes after a failure without a second inbox or key", async () => {
    const { deps, calls, def, db } = await setup({ failKeyOnce: true });
    const id = await def("bot");
    expect(await requestMailbox(deps, id, "ada")).toBeUndefined();
    const pending = (await db.select().from(mailboxes))[0]!;
    expect(pending).toMatchObject({ inboxId: "inbox-1", status: "pending" });
    expect(await requestMailbox(deps, id, "other")).toBe("ada@mail.test"); // retry keeps the first address
    const m = (await db.select().from(mailboxes))[0]!;
    expect(m.keyCipher && m.webhookId).toBeTruthy();
    expect(m.status).toBe("active");
    expect(calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
  });

  it("removes and restores", async () => {
    const { deps, calls, def, db } = await setup();
    const id = await def("bot");
    const m = await make(deps, id);
    calls.length = 0;
    await removeMailbox(deps, id);
    expect(calls).toEqual([`revoke ${m.keyId}`, `unhook ${m.webhookId}`, `active ${m.inboxId} false`]);
    let row = (await db.select().from(mailboxes).where(eq(mailboxes.definitionId, id)))[0]!;
    expect(row).toMatchObject({ status: "removed", keyCipher: null, webhookSecretCipher: null, address: m.address });
    expect((await ensureMailbox(deps, id))!.status).toBe("removed");
    calls.length = 0;
    await restoreMailbox(deps, id);
    expect(calls[0]).toBe(`active ${m.inboxId} true`);
    expect(calls.some((c) => c.startsWith("key "))).toBe(true);
    row = (await db.select().from(mailboxes).where(eq(mailboxes.definitionId, id)))[0]!;
    expect(row.status).toBe("active");
    expect(row.keyCipher && row.webhookSecretCipher).toBeTruthy();
  });

  it("a rename updates only the display name", async () => {
    const { deps, calls, def, db } = await setup();
    const id = await def("bot", "Ada");
    const m = await make(deps, id, "ada");
    await db.update(botDefinitions).set({ displayName: "Grace" }).where(eq(botDefinitions.id, id));
    const after = (await ensureMailbox(deps, id))!;
    expect(after.address).toBe(m.address);
    expect(calls).toContain(`name ${m.inboxId} Grace (bot label)`);
  });

  it("returns the address on request", async () => {
    const { deps, def } = await setup();
    expect(await requestMailbox(deps, await def("bot"), "ada")).toBe("ada@mail.test");
  });

  it("creates nothing unless asked, on save or at startup", async () => {
    const { deps, calls, def, db } = await setup();
    const id = await def("bot");
    expect(await ensureMailbox(deps, id)).toBeUndefined();
    await ensureAllMailboxes(deps);
    expect(calls).toEqual([]);
    expect(await db.select().from(mailboxes)).toHaveLength(0);
  });

  it("startup finishes only incomplete requested mailboxes", async () => {
    const { deps, calls, def } = await setup({ failKeyOnce: true });
    const a = await def("a");
    await requestMailbox(deps, a, "a1"); // key fails, stays pending
    const b = await def("b");
    await make(deps, b);
    await def("c");
    calls.length = 0;
    await ensureAllMailboxes(deps);
    expect(calls.filter((c) => c.startsWith("create"))).toHaveLength(0);
    expect(calls.filter((c) => c.startsWith("key"))).toHaveLength(1);
  });
});
