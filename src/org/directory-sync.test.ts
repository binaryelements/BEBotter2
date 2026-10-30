import { describe, expect, it } from "vitest";
import { testDb } from "../db/test-db.js";
import { createDepartment, listDepartments, listPeople, setMembership, setPersonalBot, setRole } from "./directory.js";
import { graphFetchUsers, syncPeople } from "./directory-sync.js";
import type { DirectoryUser } from "./directory-sync.js";
import { upsertPerson, upsertTenant } from "./org.js";

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

    const people = await listPeople(db, T);
    const a = people.find((p) => p.id === ann.id)!;
    expect(a).toMatchObject({ name: "ANN", email: "ann@example.test", role: "admin", personalBot: true });
    expect(a.memberships).toMatchObject([{ departmentId: sales, isHead: true }]);
    expect(people.find((p) => p.name === "bob@example.test")?.email).toBe("bob@example.test");
    expect(people.some((p) => p.id === gone.id)).toBe(true);
    expect(people.map((p) => p.name)).not.toContain("GUEST");
    expect(people.map((p) => p.name)).not.toContain("OFF");
    expect((await listDepartments(db, T))[0].members).toHaveLength(1);

    expect(await syncPeople(db, T, async () => users)).toEqual({ added: 0, updated: 0, skipped: 2 });
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
    expect(calls[1].url).toBe("https://graph.microsoft.com/v1.0/users?$select=id,displayName,mail,userPrincipalName,accountEnabled,userType&$top=999");
    expect(new Headers(calls[1].init?.headers).get("authorization")).toBe("Bearer tok");
    expect(calls[2].url).toBe("https://graph.microsoft.com/v1.0/users?page2");
  });

  it("throws the fixed message on a non-2xx answer", async () => {
    const tokenFails = (async () => json({ error: "secret-1" }, 401)) as typeof fetch;
    await expect(graphFetchUsers(config, tokenFails)()).rejects.toThrow(/^Directory sync failed: 401$/);
    const graphFails = (async (url: string) => (url.includes("/oauth2/") ? json({ access_token: "tok" }) : json({ error: "tok" }, 403))) as typeof fetch;
    await expect(graphFetchUsers(config, graphFails)()).rejects.toThrow(/^Directory sync failed: 403$/);
  });
});
