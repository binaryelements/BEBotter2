import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertDefinition } from "../bots/definitions.js";
import { createSecretLink } from "../connections/secret-links.js";
import { fakeSsh } from "../connections/ssh.js";
import { getConnection, requestConnection } from "../connections/store.js";
import type { Db } from "../db/client.js";
import { connections } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { decrypt } from "../secrets/cipher.js";
import { adminRouter } from "./router.js";
import { serve, sessionCookie } from "./test-server.js";

const secretsKey = Buffer.alloc(32, 5);
const config = {
  teams: { clientId: "client-1", tenantId: "tenant-1", clientSecret: "s" },
  publicUrl: "https://bot.example.test",
  adminEmails: [],
  secretsKey,
};

describe("secret link page", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  let uma: string, bob: string, connectionId: string;

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: "tenant-1" });
    // the sign-in callback upserts Uma by her object id, so she is the same person as here
    uma = (await upsertPerson(db, { tenantId: "tenant-1", aadObjectId: "o-uma", name: "Uma" })).id;
    bob = (await upsertPerson(db, { tenantId: "tenant-1", aadObjectId: "o-bob", name: "Bob" })).id;
    const definitionId = (await upsertDefinition(db, secretsKey, "tenant-1", { name: "ops", label: "Ops", persona: "p" })).id;
    const { connection } = await requestConnection({ db, ssh: fakeSsh(), secretsKey }, "tenant-1", {
      kind: "http", name: "helpdesk", target: "https://api.example.test/v1", mode: "read-only",
      config: { auth: { in: "header", name: "Authorization", prefix: "Bearer " } }, definitionId, personId: uma,
    });
    connectionId = connection.id;
    const app = express();
    app.use(
      "/admin",
      adminRouter({
        db, config, botName: "Bot", defaultModel: "m", fetchUsers: async () => [],
        exchangeCode: async (code) => ({ id_token: code }),
        verifyIdToken: async () => ({ oid: "o-uma", tid: "tenant-1", name: "Uma", email: "uma@example.test" }),
      }),
    );
    ({ url, close } = await serve(app));
  });
  afterAll(() => close());

  const path = async () => new URL(await createSecretLink(db, "tenant-1", connectionId, uma, config.publicUrl)).pathname;
  const get = (p: string, cookie?: string) => fetch(url + p, { redirect: "manual", headers: cookie ? { cookie } : {} });
  const post = (p: string, body: Record<string, string>, cookie?: string) =>
    fetch(url + p, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams(body).toString(),
    });
  const as = (id: string) => sessionCookie(secretsKey, "tenant-1", id);

  it("a plain user (not admin or head) can open and use their own link", async () => {
    const p = await path();
    expect((await get("/admin/people", as(uma))).status).toBe(403);
    const page = await get(p, as(uma));
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const text = await page.text();
    expect(text).toContain("helpdesk");
    expect(text).toContain("https://api.example.test/v1");
    expect(text).toContain('type="password"');
    expect(text).toContain('name="csrf" value="csrf-1"');

    expect((await post(p, { secret: "tok-1" }, as(uma))).status).toBe(403); // no csrf
    expect((await post(p, { csrf: "csrf-1", secret: "tok-1" }, as(bob))).status).toBe(400);
    const saved = await post(p, { csrf: "csrf-1", secret: "tok-1" }, as(uma));
    expect(saved.status).toBe(200);
    expect(await saved.text()).toContain("Saved. Tell the bot it&#39;s done.");
    expect(decrypt(secretsKey, (await getConnection(db, "tenant-1", "helpdesk"))!.secretCipher!)).toBe("tok-1");
    const again = await get(p, as(uma));
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("This link has expired or was already used.");
  });

  it("the page never echoes the secret", async () => {
    await db.update(connections).set({ secretCipher: null });
    const p = await path();
    for (const secret of ["sk-live-<b>abc</b>", "bad\nsecret-xyz"]) {
      const res = await post(p, { csrf: "csrf-1", secret }, as(uma));
      const text = await res.text();
      expect(text).not.toContain("abc");
      expect(text).not.toContain("secret-xyz");
    }
    // the second post failed validation; the first saved, so the link is spent
    const other = await post(p, { csrf: "csrf-1", secret: "secret-xyz" }, as(bob));
    expect(await other.text()).not.toContain("secret-xyz");
  });

  it("without a session the page redirects to sign-in and back", async () => {
    await db.update(connections).set({ secretCipher: null });
    const p = await path();
    const first = await get(p);
    expect(first.status).toBe(303);
    const login = await get(first.headers.get("location")!);
    expect(login.status).toBe(302);
    const loginCookie = login.headers.getSetCookie().find((c) => c.startsWith("bb_login="))!.split(";")[0];
    const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
    const back = await get(`/admin/auth/callback?code=c1&state=${encodeURIComponent(state)}`, loginCookie);
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe(p);
    const session = back.headers.getSetCookie().find((c) => c.startsWith("bb_session="))!.split(";")[0];
    expect((await get(p, session)).status).toBe(200);
    expect((await post(p, { secret: "x" })).status).toBe(403);
  });

  it("sign-in returns only to paths under /admin/", async () => {
    for (const returnTo of ["https://evil.example.test/admin/x", "//evil.example.test", "/admin/../x", "/elsewhere", "/admin/a?b=c"]) {
      const login = await get(`/admin/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
      const loginCookie = login.headers.getSetCookie().find((c) => c.startsWith("bb_login="))!.split(";")[0];
      const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
      const back = await get(`/admin/auth/callback?code=c&state=${encodeURIComponent(state)}`, loginCookie);
      // Uma is a plain user, so without a secret-link return she gets no session at all
      expect(back.status).toBe(403);
      expect(back.headers.getSetCookie().some((c) => c.startsWith("bb_session="))).toBe(false);
    }
  });
});
