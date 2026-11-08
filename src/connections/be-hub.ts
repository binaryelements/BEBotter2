import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { people } from "../db/schema.js";
import { listDefinitions } from "../bots/definitions.js";
import { createConnection, getConnection } from "./store.js";
import { systemSsh } from "./ssh.js";

/** Hub tools that are safe to run without a card. Everything else asks. */
const READ_ONLY = [
  "whoami",
  "list_machines",
  "get_machine",
  "machine_history",
  "fleet_summary",
  "list_alerts",
  "list_events",
  "list_patches",
  "list_proposals",
  "list_runs",
  "get_run",
  "list_scripts",
  "list_tickets",
  "get_ticket",
  "search_kb",
  "ticket_options",
  "pending_digest",
  "security_overview",
  "list_security_findings",
  "security_machine",
  "list_reports",
  "run_report",
];

/**
 * Create the BE Hub MCP connection once, linked to the IT Support bot, from the configured API key.
 * The key is stored encrypted in the connection, never in the bot's prompt. Write tools still ask.
 */
export async function ensureBeHubConnection(db: Db, secretsKey: Buffer, tenantId: string, beHub: { url: string; apiKey: string }): Promise<void> {
  if (await getConnection(db, tenantId, "be-hub")) return;
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
      name: "be-hub",
      target: beHub.url,
      mode: "change",
      config: { headerName: "Authorization", readOnlyTools: READ_ONLY },
      secret: `Bearer ${beHub.apiKey}`,
      description: "BE Hub fleet: machines, alerts, patches, scripts, security and tickets. Read tools run freely; run_script, decide_proposal, security fixes and other writes need a confirmation card.",
      definitionIds: [target.id],
      personId: admin.id,
    },
  );
  console.log(`be-hub connection for tenant ${tenantId}: linked to ${target.displayName ?? target.label}`);
}
