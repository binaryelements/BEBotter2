import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { people } from "../db/schema.js";
import { listDefinitions } from "../bots/definitions.js";
import { createConnection, getConnection } from "./store.js";
import { systemSsh } from "./ssh.js";

/** Mantis fleet tools that only read: line_show. Every other tool changes a line or a number and asks. */
const READ_ONLY = ["line_show"];

/**
 * Create the Mantis fleet MCP connection once, linked to the IT Support bot, from the configured
 * Basic auth header. The header is stored encrypted in the connection, never in a bot's prompt.
 */
export async function ensureMantisConnection(db: Db, secretsKey: Buffer, tenantId: string, mantis: { url: string; secret: string }): Promise<void> {
  const mcp = await getConnection(db, tenantId, "mantis");
  const api = await getConnection(db, tenantId, "mantis-api");
  if (mcp && api) return;
  const defs = (await listDefinitions(db, tenantId)).filter((d) => d.identity !== "person");
  const target = defs.find((d) => /(^|[- ])(it|support)([- ]|$)/i.test(`${d.name} ${d.label} ${d.displayName ?? ""}`)) ?? defs[0];
  if (!target) return;
  const [admin] = await db.select({ id: people.id }).from(people).where(and(eq(people.tenantId, tenantId), eq(people.role, "admin"))).limit(1);
  if (!admin) return;
  const base = mantis.url.replace(/\/mcp\/?$/, "");
  if (!mcp)
    await createConnection(
      { db, secretsKey, ssh: systemSsh() },
      tenantId,
      {
        kind: "mcp",
        name: "mantis",
        target: mantis.url,
        mode: "change",
        config: { headerName: "Authorization", readOnlyTools: READ_ONLY },
        secret: mantis.secret,
        description: "Mantis fleet: the Melbourne and Sydney SIP proxies, their lines, numbers, forwards and preferences. line_show reads; line and number changes ask for a confirmation card.",
        definitionIds: [target.id],
        personId: admin.id,
      },
    );
  if (!api)
    await createConnection(
      { db, secretsKey, ssh: systemSsh() },
      tenantId,
      {
        kind: "http",
        name: "mantis-api",
        target: base,
        mode: "change",
        config: { auth: { in: "header", name: "Authorization" } },
        secret: mantis.secret,
        description:
          "Mantis fleet HTTP API. GET /api/summary, /api/registrations, /api/calls, /api/events, /api/bans, /api/geofilter, /api/pins, /api/ring, /api/sync, /api/lines, /api/report, /api/labels, /api/series and /api/history. POST /api/action changes a node's service state or a pin; POST /api/lines changes lines; POST /api/sync syncs users; POST /api/geofilter changes the country filter. Reads are safe; a POST changes the SIP fleet. /api/action, /api/sync and /api/geofilter take form-encoded bodies; /api/lines takes JSON.",
        definitionIds: [target.id],
        personId: admin.id,
      },
    );
  console.log(`mantis connections for tenant ${tenantId}: linked to ${target.displayName ?? target.label}`);
}
