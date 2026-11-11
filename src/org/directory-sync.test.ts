import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../db/test-db.js";
import { people } from "../db/schema.js";
import { createDepartment, listDepartments, listPeople, setMembership, setPersonalBot, setRole } from "./directory.js";
import { graphFetchUsers, syncPeople } from "./directory-sync.js";
import type { DirectoryUser } from "./directory-sync.js";
import { getTenantSettings, setTenantSettings, upsertPerson, upsertTenant } from "./org.js";

const T = "tenant-1";
const user = (id: string, over: Partial<DirectoryUser> = {}): DirectoryUser => ({
  id, displayName: id.toUpperCase(), mail: `${id}@Example.test`, userPrincipalName: `${id}@example.test`, accountEnabled: true, userType: "Member", ...over,
});

describe("syncPeople", () => {
  it("adds and updates members, skips guests and disabled accounts, keeps roles and memberships, never deletes", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: T });
    const ann = await upsertPerson(db, { tenantId: T, aadObjectId: "ann", name: "Old Ann" });
    const gone = await upsertPerson(db, { tenantId: T, aadObjectId: "gone", name: "Gone" });
    await setRole(db, T, ann.id, "admin");
    await setPersonalBot(db, T, ann.id, true);
    const sales = (await createDepartment(db, T, "Sales")).id;
    await setMembership(db, T, sales, ann.id, "head");

    const users = [
      user("ann"),
      user("bob", { mail: null, displayName: "" }),
      user("guest", { userType: "Guest" }),
      user("off", { accountEnabled: false }),
    ];
    expect(await syncPeople(db, T, async () => users)).toEqual({ added: 1, updated: 1, skipped: 2 });

    const listed = await listPeople(db, T);
    const a = listed.find((p) => p.id === ann.id)!;
    expect(a).toMatchObject({ name: "ANN", email: "ann@example.test", role: "admin", personalBot: true });
    expect(a.memberships).toMatchObject([{ departmentId: sales, isHead: true }]);
    expect(listed.find((p) => p.name === "bob@example.test")?.email).toBe("bob@example.test");
    // kept, with its history, but off the page: the directory no longer knows this account
    const [goneRow] = await db.select({ licensed: people.licensed }).from(people).where(eq(people.id, gone.id));
    expect(goneRow).toEqual({ licensed: false });
    expect(listed.some((p) => p.id === gone.id)).toBe(false);
    expect(listed.map((p) => p.name)).not.toContain("GUEST");
    expect(listed.map((p) => p.name)).not.toContain("OFF");
    expect((await listDepartments(db, T))[0].members).toHaveLength(1);

    expect(await syncPeople(db, T, async () => users)).toEqual({ added: 0, updated: 0, skipped: 2 });
  });

  it("marks unlicensed members and does not add a new unlicensed one", async () => {    const db = await testDb();
    await upsertTenant(db, { id: T });
    const users = [user("ann", { assignedLicenses: [{ skuId: "sku-1" }] }), user("nol", { assignedLicenses: [] })];
    expect(await syncPeople(db, T, async () => users)).toEqual({ added: 1, updated: 0, skipped: 1 });
    expect((await listPeople(db, T)).map((p) => [p.name, p.licensed])).toEqual([["ANN", true]]);
    const old = await upsertPerson(db, { tenantId: T, aadObjectId: "old", name: "Old" });
    expect(await syncPeople(db, T, async () => [user("old", { assignedLicenses: [] })])).toEqual({ added: 0, updated: 1, skipped: 0 });
    const [oldRow] = await db.select({ licensed: people.licensed }).from(people).where(eq(people.id, old.id));
    expect(oldRow!.licensed).toBe(false);
  });

  it("drops a person only ever seen in Teams off the list when the directory does not list them", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: T });
    const ghost = await upsertPerson(db, { tenantId: T, aadObjectId: "ghost", name: "" });
    expect((await listPeople(db, T)).map((p) => [p.name, p.licensed])).toEqual([["", true]]);
    await syncPeople(db, T, async () => [user("ann", { assignedLicenses: [{ skuId: "sku-1" }] })]);
    const rows = await db.select({ id: people.id, licensed: people.licensed }).from(people);
    expect(rows.find((r) => r.id === ghost.id)?.licensed).toBe(false);
  });

  it("keeps each person's place from the directory and makes the commonest one the company default", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: T });
    const users = [
      user("ann", { city: "Melbourne", country: "Australia" }),
      user("bob", { city: "Sydney", country: "Australia" }),
      user("cat", { city: " Melbourne ", country: "Australia" }),
      user("dan", { city: null, country: null, officeLocation: "Level 3" }),
      user("eve", { country: "Singapore" }),
    ];
    await syncPeople(db, T, async () => users);
    const places = async () => Object.fromEntries((await db.select({ name: people.name, location: people.location }).from(people)).map((p) => [p.name, p.location]));
    expect(await places()).toEqual({ ANN: "Melbourne, Australia", BOB: "Sydney, Australia", CAT: "Melbourne, Australia", DAN: "Level 3", EVE: "Singapore" });
    expect(await getTenantSettings(db, T)).toMatchObject({ location: "Melbourne", country: "Australia" });
    // an admin's own setting is kept
    await setTenantSettings(db, T, { ...(await getTenantSettings(db, T)), location: "Geelong", country: "Australia" });
    await syncPeople(db, T, async () => [user("ann", { city: "Perth", country: "Australia" })]);
    expect(await getTenantSettings(db, T)).toMatchObject({ location: "Geelong" });
    expect((await places()).ANN).toBe("Perth, Australia");
  });

  it("falls back on empty values, skips users without a name, email or id, and never blanks a stored email", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: T });
    const kept = await upsertPerson(db, { tenantId: T, aadObjectId: "kept", name: "Kept" });
    await syncPeople(db, T, async () => [user("kept", { mail: "kept@example.test" })]);
    const users = [
      user("ann", { mail: "", displayName: "  " }),
      user("kept", { mail: null, userPrincipalName: "" }),
      user("none", { mail: null, userPrincipalName: "", displayName: "" }),
      user("", { displayName: "No id" }),
      { ...user("x"), id: undefined } as unknown as DirectoryUser,
    ];
    expect(await syncPeople(db, T, async () => users)).toEqual({ added: 1, updated: 0, skipped: 4 });
    const listed = await listPeople(db, T);
    expect(listed.find((p) => p.name === "ann@example.test")?.email).toBe("ann@example.test");
    expect(listed).toHaveLength(1);
    // a directory entry with no address keeps the one already stored, but is not a person the page can list
    const [keptRow] = await db.select({ email: people.email, licensed: people.licensed }).from(people).where(eq(people.id, kept.id));
    expect(keptRow).toEqual({ email: "kept@example.test", licensed: false });
  });

  it("a second sync while one runs shares its result and writes nothing twice", async () => {
    const db = await testDb();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const slow = async () => { calls++; await gate; return [user("ann")]; };
    const a = syncPeople(db, T, slow), b = syncPeople(db, T, slow);
    release();
    expect(await a).toEqual({ added: 1, updated: 0, skipped: 0 });
    expect(await b).toEqual(await a);
    expect(calls).toBe(1);
    expect(await syncPeople(db, T, slow)).toEqual({ added: 0, updated: 0, skipped: 0 });
  });

  it("creates the tenant row when it is missing", async () => {
    const db = await testDb();
    expect(await syncPeople(db, T, async () => [user("ann")])).toEqual({ added: 1, updated: 0, skipped: 0 });
  });
});

describe("graphFetchUsers", () => {
  const config = { teams: { clientId: "client-1", tenantId: "tid-1", clientSecret: "secret-1" } };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("gets a client-credentials token and follows nextLink", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/oauth2/")) return json({ access_token: "tok" });
      if (url.includes("page2")) return json({ value: [user("b")] });
      return json({ value: [user("a")], "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?page2" });
    }) as typeof fetch;

    const users = await graphFetchUsers(config, fetchFn)();
    expect(users.map((u) => u.id)).toEqual(["a", "b"]);
    expect(calls[0].url).toBe("https://login.microsoftonline.com/tid-1/oauth2/v2.0/token");
    const form = new URLSearchParams(String(calls[0].init?.body));
    expect(Object.fromEntries(form)).toEqual({ client_id: "client-1", client_secret: "secret-1", grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" });
    expect(calls[1].url).toBe("https://graph.microsoft.com/v1.0/users?$select=id,displayName,mail,userPrincipalName,accountEnabled,userType,assignedLicenses,city,country,officeLocation&$top=999");
    expect(new Headers(calls[1].init?.headers).get("authorization")).toBe("Bearer tok");
    expect(calls[2].url).toBe("https://graph.microsoft.com/v1.0/users?page2");
  });

  it("refuses a nextLink outside Microsoft Graph without sending the token there", async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      if (url.includes("/oauth2/")) return json({ access_token: "tok" });
      return json({ value: [user("a")], "@odata.nextLink": "https://evil.example/v1.0/users?x" });
    }) as typeof fetch;
    await expect(graphFetchUsers(config, fetchFn)()).rejects.toThrow(/^Directory sync failed: bad nextLink$/);
    expect(urls.every((u) => u.startsWith("https://login.microsoftonline.com/") || u.startsWith("https://graph.microsoft.com/"))).toBe(true);
    expect(urls).toHaveLength(2);
    const garbage = (async (url: string) => (url.includes("/oauth2/") ? json({ access_token: "tok" }) : json({ value: [], "@odata.nextLink": "not a url" }))) as typeof fetch;
    await expect(graphFetchUsers(config, garbage)()).rejects.toThrow(/^Directory sync failed: bad nextLink$/);
  });

  it("throws the fixed message on a non-2xx answer", async () => {
    const tokenFails = (async () => json({ error: "secret-1" }, 401)) as typeof fetch;
    await expect(graphFetchUsers(config, tokenFails)()).rejects.toThrow(/^Directory sync failed: 401$/);
    const graphFails = (async (url: string) => (url.includes("/oauth2/") ? json({ access_token: "tok" }) : json({ error: "tok" }, 403))) as typeof fetch;
    await expect(graphFetchUsers(config, graphFails)()).rejects.toThrow(/^Directory sync failed: 403$/);
  });
});
