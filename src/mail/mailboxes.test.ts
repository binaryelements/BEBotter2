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
  // the fake server: inboxes by local part, live keys and webhooks per agent
  const inboxes = new Map((opts.taken ?? []).map((l) => [l, { id: `x-${l}`, address: `${l}@mail.test`, ownerAgent: "someone-else" as string | null }]));
  const keys = new Map<string, string>(); // id -> agent
  const hooks = new Map<string, string>();
  let failKey = opts.failKeyOnce ?? false;
  let n = 0;
  const admin = {
    inboxTaken: async (l: string) => (calls.push(`taken ${l}`), inboxes.has(l)),
    findInbox: async (l: string) => inboxes.get(l),
    createInbox: async (l: string, d: string, a: string) => {
      calls.push(`create ${l} | ${d} | ${a}`);
      if (inboxes.has(l)) throw new MailError("exists", 409);
      const made = { id: `inbox-${++n}`, address: `${l}@mail.test`, ownerAgent: a };
      inboxes.set(l, made);
      return made;
    },
    setInboxActive: async (id: string, on: boolean) => void calls.push(`active ${id} ${on}`),
    setDisplayName: async (id: string, name: string) => void calls.push(`name ${id} ${name}`),
    listKeys: async (a: string) => [...keys].filter(([, ag]) => ag === a).map(([id]) => id),
    listWebhooks: async (a: string) => [...hooks].filter(([, ag]) => ag === a).map(([id]) => id),
    issueKey: async (a: string) => {
      calls.push(`key ${a}`);
      if (failKey) { failKey = false; throw new MailError("down"); }
      const id = `key-${++n}`;
      keys.set(id, a);
      return { id, key: "am_secret" };
    },
    revokeKey: async (id: string) => (calls.push(`revoke ${id}`), void keys.delete(id)),
    addWebhook: async (a: string, url: string, inbox: string) => {
      calls.push(`hook ${url} ${inbox}`);
      const id = `hook-${++n}`;
      hooks.set(id, a);
      return { id, secret: "amwh_secret" };
    },
    removeWebhook: async (id: string) => (calls.push(`unhook ${id}`), void hooks.delete(id)),
  };
  const deps: MailDeps = { db, secretsKey, admin: admin as unknown as MailDeps["admin"], publicUrl: "https://bot.test" };
  const def = async (name: string, displayName: string | null = null) => {
    const id = crypto.randomUUID();
    await db.insert(botDefinitions).values({ id, tenantId: "t1", name, displayName, label: `${name} label`, persona: "", model: "m", webSearch: false, computer: false, mcpServers: [] });
    return id;
  };
  return { db, deps, calls, def, inboxes, keys, hooks };
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
    deps.admin.inboxTaken = async () => false; // raced: free when checked, taken when created
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

  it("a failed remove cannot be revived by a save or restart, and a retry finishes it", async () => {
    const { deps, calls, def, db } = await setup();
    const id = await def("bot");
    const m = await make(deps, id, "ada");
    const real = deps.admin.removeWebhook;
    deps.admin.removeWebhook = async () => { throw new MailError("down"); };
    await expect(removeMailbox(deps, id)).rejects.toThrow(MailError);
    expect((await db.select().from(mailboxes))[0]!.status).toBe("removing");
    calls.length = 0;
    expect(await ensureMailbox(deps, id)).toMatchObject({ status: "removing" });
    await ensureAllMailboxes(deps);
    expect(calls).toEqual([]);
    deps.admin.removeWebhook = real;
    await removeMailbox(deps, id);
    expect((await db.select().from(mailboxes))[0]).toMatchObject({ status: "removed", keyId: null, webhookId: null, inboxId: m.inboxId });
  });

  it("adopts the inbox after a lost createInbox response", async () => {
    const { deps, calls, def, inboxes } = await setup();
    const id = await def("bot");
    const real = deps.admin.createInbox;
    let lose = true;
    deps.admin.createInbox = async (...a) => { const r = await real(...a); if (lose) { lose = false; throw new MailError("lost"); } return r; };
    expect(await requestMailbox(deps, id, "ada")).toBeUndefined(); // response lost, inbox exists
    expect(await requestMailbox(deps, id, "ada")).toBe("ada@mail.test"); // 409, owned by this bot's agent: adopted
    expect(calls.filter((c) => c.startsWith("create"))).toHaveLength(2);
    expect([...inboxes.keys()]).toEqual(["ada"]);
  });

  it("does not adopt an inbox owned by another agent", async () => {
    const { deps, def, db, inboxes } = await setup();
    const id = await def("bot");
    deps.admin.inboxTaken = async () => false;
    inboxes.set("ada", { id: "x", address: "ada@mail.test", ownerAgent: "someone-else" });
    await expect(requestMailbox(deps, id, "ada")).rejects.toMatchObject({ reason: "taken" });
    expect(await db.select().from(mailboxes)).toHaveLength(0);
  });

  it("revokes a stray key and webhook from a lost response before issuing new ones", async () => {
    const { deps, def, keys, hooks } = await setup({ failKeyOnce: true });
    const id = await def("bot");
    const agent = `bb2-${id.slice(0, 12)}`;
    keys.set("stray-key", agent);
    hooks.set("stray-hook", agent);
    keys.set("other-bots-key", "bb2-other");
    await requestMailbox(deps, id, "ada"); // key issue fails once
    await requestMailbox(deps, id, "ada");
    expect([...keys.keys()].sort()).toEqual([(await deps.db.select().from(mailboxes))[0]!.keyId, "other-bots-key"].sort());
    expect([...hooks.keys()]).toEqual([(await deps.db.select().from(mailboxes))[0]!.webhookId]);
  });

  it("turns an insert race on the same address into taken", async () => {
    const { deps, def } = await setup();
    const a = await def("one");
    const b = await def("two");
    const results = await Promise.allSettled([requestMailbox(deps, a, "ada"), requestMailbox(deps, b, "ada")]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ reason: "taken" });
  });

  it("tells a removed mailbox to be restored instead", async () => {
    const { deps, def } = await setup();
    const id = await def("bot");
    await make(deps, id, "ada");
    await removeMailbox(deps, id);
    await expect(requestMailbox(deps, id, "ada")).rejects.toMatchObject({ reason: "removed" });
  });

  it("refuses an address BE AgentMail's own rule rejects, before any call", async () => {
    const { deps, calls, def } = await setup();
    const id = await def("bot");
    for (const bad of [".iris", "-x", "_ops"]) await expect(requestMailbox(deps, id, bad)).rejects.toMatchObject({ reason: "invalid" });
    expect(calls).toEqual([]);
  });

  it("a 422 from createInbox is refused with its reason and leaves no row", async () => {
    const { deps, def, db } = await setup();
    deps.admin.createInbox = async () => { throw new MailError("bad", 422, "local_part reserved"); };
    const err = await requestMailbox(deps, await def("bot"), "admin").catch((e) => e);
    expect(err).toMatchObject({ reason: "refused" });
    expect(err.message).toContain("local_part reserved");
    expect(await db.select().from(mailboxes)).toHaveLength(0);
  });

  it("remove revokes every live key and webhook of the agent and treats 404 as gone", async () => {
    const { deps, def, db, keys, hooks } = await setup();
    const id = await def("bot");
    await make(deps, id, "ada");
    const agent = `bb2-${id.slice(0, 12)}`;
    keys.set("stray-key", agent);
    hooks.set("stray-hook", agent);
    keys.set("other", "bb2-other");
    const real = deps.admin.revokeKey;
    deps.admin.revokeKey = async (k) => { if (k === "stray-key") throw new MailError("gone", 404); return real(k); };
    await removeMailbox(deps, id);
    expect([...keys.keys()]).toEqual(["stray-key", "other"]); // the 404 one was already gone; the recorded one is revoked
    expect(hooks.size).toBe(0);
    expect((await db.select().from(mailboxes))[0]).toMatchObject({ status: "removed", keyId: null, webhookId: null });
  });

  it("startup finishes a removal that was left half done", async () => {
    const { deps, def, db, keys } = await setup();
    const id = await def("bot");
    await make(deps, id, "ada");
    await db.update(mailboxes).set({ status: "removing" }).where(eq(mailboxes.definitionId, id));
    await ensureAllMailboxes(deps);
    expect(keys.size).toBe(0);
    expect((await db.select().from(mailboxes))[0]!.status).toBe("removed");
  });
});
