import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { Config } from "../config/config.js";
import { people, tenants } from "../db/schema.js";

export type DirectoryUser = { id: string; displayName: string; mail: string | null; userPrincipalName: string; accountEnabled: boolean; userType: string };
export type FetchUsers = () => Promise<DirectoryUser[]>;

const MAX_PAGES = 50;

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
    let next: string | undefined = "https://graph.microsoft.com/v1.0/users?$select=id,displayName,mail,userPrincipalName,accountEnabled,userType&$top=999";
    for (let i = 0; next && i < MAX_PAGES; i++) {
      const page = (await ok(await fetchFn(next, { headers: { authorization: `Bearer ${access_token}` } })).json()) as { value?: DirectoryUser[]; "@odata.nextLink"?: string };
      users.push(...(page.value ?? []));
      next = page["@odata.nextLink"];
    }
    return users;
  };
}

/** Adds and renames tenant members from the directory; roles, personal bots and memberships stay, and nobody is deleted. */
export async function syncPeople(db: Db, tenantId: string, fetchUsers: FetchUsers): Promise<{ added: number; updated: number; skipped: number }> {
  const all = await fetchUsers();
  const members = all.filter((u) => u.accountEnabled && u.userType === "Member");
  let added = 0, updated = 0;
  await db.transaction(async (tx) => {
    await tx.insert(tenants).values({ id: tenantId, name: "" }).onConflictDoNothing();
    const existing = new Map(
      (await tx.select({ id: people.id, aadObjectId: people.aadObjectId, name: people.name, email: people.email }).from(people).where(eq(people.tenantId, tenantId))).map((p) => [p.aadObjectId, p]),
    );
    for (const u of members) {
      const name = u.displayName || u.userPrincipalName;
      const email = (u.mail ?? u.userPrincipalName).toLowerCase();
      const row = existing.get(u.id);
      if (!row) {
        await tx.insert(people).values({ id: crypto.randomUUID(), tenantId, aadObjectId: u.id, name, email });
        existing.set(u.id, { id: "", aadObjectId: u.id, name, email });
        added++;
      } else if (row.name !== name || row.email !== email) {
        await tx.update(people).set({ name, email }).where(eq(people.id, row.id));
        Object.assign(row, { name, email });
        updated++;
      }
    }
  });
  return { added, updated, skipped: all.length - members.length };
}

/** Syncs now and then every intervalMs; returns a stop function. Failures are logged, never thrown. */
export function startPeopleSync(db: Db, tenantId: string, fetchUsers: FetchUsers, intervalMs: number, log: (line: string) => void = console.log): () => void {
  const run = async () => {
    try {
      const { added, updated, skipped } = await syncPeople(db, tenantId, fetchUsers);
      log(`people sync: added=${added} updated=${updated} skipped=${skipped}`);
    } catch (err) {
      console.error("people sync failed", err);
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs).unref();
  return () => clearInterval(timer);
}
