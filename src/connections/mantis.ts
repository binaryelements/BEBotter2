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
  if (await getConnection(db, tenantId, "mantis")) return;
  const defs = (await listDefinitions(db, tenantId)).filter((d) => d.identity !== "person");
  const target = defs.find((d) => /(^|[- ])(it|support)([- ]|$)/i.test(`${d.name} ${d.label} ${d.displayName ?? ""}`)) ?? defs[0];
  if (!target) return;
  const [admin] = await db.select({ id: people.id }).from(people).where(and(eq(people.tenantId, tenantId), eq(people.role, "admin"))).limit(1);
  if (!admin) return;
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
  console.log(`mantis connection for tenant ${tenantId}: linked to ${target.displayName ?? target.label}`);
}
