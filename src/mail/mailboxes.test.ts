import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { botDefinitions, mailboxes } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { upsertTenant } from "../org/org.js";
import { decrypt } from "../secrets/cipher.js";
import { MailError } from "./agentmail.js";
import { ensureAllMailboxes, ensureMailbox, removeMailbox, restoreMailbox } from "./mailboxes.js";
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

describe("mailboxes", () => {
  it("creates the inbox, an encrypted key and a webhook", async () => {
    const { deps, calls, def } = await setup();
    const id = await def("Support Bot", "Ada Lovelace");
    const m = (await ensureMailbox(deps, id))!;
    expect(m.address).toBe("ada-lovelace@mail.test");
    expect(m.status).toBe("active");
    expect(m.keyCipher).not.toContain("am_secret");
    expect(decrypt(secretsKey, m.keyCipher!)).toBe("am_secret");
    expect(decrypt(secretsKey, m.webhookSecretCipher!)).toBe("amwh_secret");
    expect(calls[1]).toBe(`create ada-lovelace | Ada Lovelace (Support Bot label) | bb2-${id.slice(0, 12)}`);
    expect(calls).toContain("hook https://bot.test/mail/inbound inbox-1");
  });

  it("suffixes a clashing address and leaves the other bot alone", async () => {
    const { deps, def } = await setup();
    const a = await def("one", "Ada");
    const b = await def("two", "Ada");
    const first = (await ensureMailbox(deps, a))!;
    const second = (await ensureMailbox(deps, b))!;
    expect(first.address).toBe("ada@mail.test");
    expect(second.address).toBe("ada-two@mail.test");
    expect((await ensureMailbox(deps, a))!.inboxId).toBe(first.inboxId);
  });

  it("moves on when the server answers 409 for a candidate", async () => {
    const { deps, def, calls } = await setup();
    const real = deps.admin.createInbox;
    let once = true;
    deps.admin.createInbox = async (...a) => { if (once) { once = false; throw new MailError("exists", 409); } return real(...a); };
    const m = (await ensureMailbox(deps, await def("bot", "Ada")))!;
    expect(m.address).toBe("ada-bot@mail.test");
    expect(calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
  });

  it("resumes after a failure without a second inbox or key", async () => {
    const { deps, calls, def, db } = await setup({ failKeyOnce: true });
    const id = await def("bot");
    await expect(ensureMailbox(deps, id)).rejects.toThrow(MailError);
    expect((await db.select().from(mailboxes))[0]!.inboxId).toBe("inbox-1");
    const m = (await ensureMailbox(deps, id))!;
    expect(m.keyCipher && m.webhookId).toBeTruthy();
    expect(calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
  });

  it("removes and restores", async () => {
    const { deps, calls, def, db } = await setup();
    const id = await def("bot");
    const m = (await ensureMailbox(deps, id))!;
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
    const m = (await ensureMailbox(deps, id))!;
    await db.update(botDefinitions).set({ displayName: "Grace" }).where(eq(botDefinitions.id, id));
    const after = (await ensureMailbox(deps, id))!;
    expect(after.address).toBe(m.address);
    expect(calls).toContain(`name ${m.inboxId} Grace (bot label)`);
  });

  it("backfill skips bots that already have a mailbox", async () => {
    const { deps, calls, def } = await setup();
    const a = await def("a");
    await ensureMailbox(deps, a);
    await def("b");
    calls.length = 0;
    await ensureAllMailboxes(deps);
    expect(calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
  });
});
