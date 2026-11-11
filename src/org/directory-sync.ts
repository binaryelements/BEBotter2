import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { Config } from "../config/config.js";
import { people, tenants } from "../db/schema.js";

export type DirectoryUser = { id: string; displayName: string; mail: string | null; userPrincipalName: string; accountEnabled: boolean; userType: string; assignedLicenses?: { skuId?: string }[]; city?: string | null; country?: string | null; officeLocation?: string | null };
export type FetchUsers = () => Promise<DirectoryUser[]>;

const MAX_PAGES = 50;
const isGraph = (url: string) => {
  try {
    return new URL(url).origin === "https://graph.microsoft.com";
  } catch {
    return false;
  }
};
const clean = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Production wiring: Microsoft Graph with the bot's client credentials (needs the User.Read.All application permission). */
export function graphFetchUsers(config: Pick<Config, "teams">, fetchFn: typeof fetch = fetch): FetchUsers {
  const { tenantId, clientId, clientSecret } = config.teams;
  // Only the status is reported: bodies may echo tokens or secrets.
  const ok = (res: Response) => {
    if (!res.ok) throw new Error(`Directory sync failed: ${res.status}`);
    return res;
  };
  return async () => {
    const tokenRes = ok(
      await fetchFn(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
        method: "POST",
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" }),
      }),
    );
    const { access_token } = (await tokenRes.json()) as { access_token?: unknown };
    if (typeof access_token !== "string") throw new Error("Directory sync failed: no token");

    const users: DirectoryUser[] = [];
    let next: string | undefined = "https://graph.microsoft.com/v1.0/users?$select=id,displayName,mail,userPrincipalName,accountEnabled,userType,assignedLicenses,city,country,officeLocation&$top=999";
    for (let i = 0; next; i++) {
      if (i === MAX_PAGES) {
        console.warn(`people sync: stopped after ${MAX_PAGES} pages`);
        break;
      }
      // The token goes to Microsoft Graph only, whatever a page links to.
      if (!isGraph(next)) throw new Error("Directory sync failed: bad nextLink");
      const page = (await ok(await fetchFn(next, { headers: { authorization: `Bearer ${access_token}` } })).json()) as { value?: DirectoryUser[]; "@odata.nextLink"?: string };
      users.push(...(page.value ?? []));
      next = page["@odata.nextLink"];
    }
    return users;
  };
}

type SyncCounts = { added: number; updated: number; skipped: number };
const running = new Map<string, Promise<SyncCounts>>();

/** Adds and renames tenant members from the directory; roles, personal bots and memberships stay, and nobody is deleted. A call while one runs for the tenant shares its result. */
export function syncPeople(db: Db, tenantId: string, fetchUsers: FetchUsers): Promise<SyncCounts> {
  let run = running.get(tenantId);
  if (!run) {
    run = doSync(db, tenantId, fetchUsers).finally(() => running.delete(tenantId));
    running.set(tenantId, run);
  }
  return run;
}

const mostCommon = (values: (string | null)[]): string | undefined => {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
};

async function doSync(db: Db, tenantId: string, fetchUsers: FetchUsers): Promise<SyncCounts> {
  const all = await fetchUsers();
  // who the directory still knows at all, whatever their account type: someone absent from here has left
  const present = new Set(all.map((u) => clean(u.id)).filter(Boolean));
  const members = all.flatMap((u) => {
    const id = clean(u.id);
    const name = clean(u.displayName) || clean(u.userPrincipalName);
    const email = (clean(u.mail) || clean(u.userPrincipalName)).toLowerCase();
    // where they are, as the directory has it: city and country, else the office
    const location = [clean(u.city ?? ""), clean(u.country ?? "")].filter(Boolean).join(", ") || clean(u.officeLocation ?? "") || null;
    // a directory page without assignedLicenses is treated as licensed, so a restricted $select cannot hide everyone
    const licensed = u.assignedLicenses === undefined || u.assignedLicenses.length > 0;
    return u.accountEnabled && u.userType === "Member" && id && name && email ? [{ id, name, email, location, country: clean(u.country ?? "") || null, licensed }] : [];
  });
  let added = 0, updated = 0, skipped = all.length - members.length;
  await db.transaction(async (tx) => {
    await tx.insert(tenants).values({ id: tenantId, name: "" }).onConflictDoNothing();
    const existing = new Map(
      (await tx.select({ aadObjectId: people.aadObjectId, name: people.name, email: people.email, location: people.location, licensed: people.licensed }).from(people).where(eq(people.tenantId, tenantId))).map((p) => [p.aadObjectId, p]),
    );
    for (const { id, name, email, location, licensed } of members) {
      const row = existing.get(id);
      if (row && row.name === name && row.email === email && row.location === location && row.licensed === licensed) continue;
      // a new unlicensed member is not added; an existing one is kept (history, roles) but marked unlicensed
      if (!row && !licensed) {
        skipped++;
        continue;
      }
      // An upsert, so a row another process inserted meanwhile is updated rather than failing the sync.
      await tx
        .insert(people)
        .values({ id: crypto.randomUUID(), tenantId, aadObjectId: id, name, email, location, licensed })
        .onConflictDoUpdate({ target: [people.tenantId, people.aadObjectId], set: { name, email, location, licensed } });
      if (row) updated++;
      else added++;
      existing.set(id, { aadObjectId: id, name, email, location, licensed });
    }
    // anyone the directory no longer lists — a row first seen in a Teams message, a departed account — is not
    // someone an admin can manage here, so it leaves the People page and keeps its history
    const listed = [...present];
    await tx
      .update(people)
      .set({ licensed: false })
      .where(listed.length ? and(eq(people.tenantId, tenantId), notInArray(people.aadObjectId, listed)) : eq(people.tenantId, tenantId));
    // the company's default place, until an admin sets one: where most of its people are
    const [t] = await tx.select({ location: tenants.location, country: tenants.country }).from(tenants).where(eq(tenants.id, tenantId));
    if (t && !t.location && !t.country) {
      const common = mostCommon(members.map((m) => m.country));
      const city = common && mostCommon(members.filter((m) => m.country === common && m.location?.endsWith(`, ${common}`)).map((m) => m.location!.slice(0, -common.length - 2)));
      if (common) await tx.update(tenants).set({ country: common, ...(city ? { location: city } : {}) }).where(eq(tenants.id, tenantId));
    }
  });
  return { added, updated, skipped };
}

/** Syncs now and then every intervalMs; returns a stop function. Failures are logged, never thrown. */
export function startPeopleSync(db: Db, tenantId: string, fetchUsers: FetchUsers, intervalMs: number, log: (line: string) => void = console.log): () => void {
  const run = async () => {
    try {
      const { added, updated, skipped } = await syncPeople(db, tenantId, fetchUsers);
      log(`people sync: added=${added} updated=${updated} skipped=${skipped}`);
    } catch (err) {
      console.error(`people sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs).unref();
  return () => clearInterval(timer);
}
