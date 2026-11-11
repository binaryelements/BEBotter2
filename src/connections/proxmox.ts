import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { people } from "../db/schema.js";
import { listDefinitions } from "../bots/definitions.js";
import { createConnection, getConnection } from "./store.js";
import { systemSsh } from "./ssh.js";
import type { SshRunner } from "./ssh.js";

/** The NextDC Proxmox hypervisors, addressed over Tailscale (the same network as the OVH hosts). */
const HOSTS = [
  { name: "imm2", target: "100.79.208.112" },
  { name: "imm3", target: "100.93.121.45" },
  { name: "imm7", target: "100.67.87.38" },
  { name: "imm8", target: "100.91.127.23" },
] as const;

/** Create the NextDC Proxmox SSH connections once, linked to the IT Support bot. They stay pending until their public key is installed and tested. */
export async function ensureProxmoxConnections(db: Db, secretsKey: Buffer, tenantId: string, ssh: SshRunner = systemSsh()): Promise<void> {
  const defs = (await listDefinitions(db, tenantId)).filter((d) => d.identity !== "person");
  const target = defs.find((d) => /(^|[- ])(it|support)([- ]|$)/i.test(`${d.name} ${d.label} ${d.displayName ?? ""}`)) ?? defs[0];
  if (!target) return;
  const [admin] = await db.select({ id: people.id }).from(people).where(and(eq(people.tenantId, tenantId), eq(people.role, "admin"))).limit(1);
  if (!admin) return;
  for (const h of HOSTS) {
    if (await getConnection(db, tenantId, h.name)) continue;
    const row = await createConnection(
      { db, secretsKey, ssh },
      tenantId,
      {
        kind: "ssh",
        name: h.name,
        target: h.target,
        mode: "change",
        config: { port: 22, username: "root" },
        description: "Proxmox server at NextDC",
        definitionIds: [target.id],
        personId: admin.id,
      },
    );
    // a public key is safe to log; the private half stays encrypted in the connection
    console.log(`proxmox connection ${h.name} (${h.target}): ${row.status}${row.publicKey ? `; install public key: ${row.publicKey}` : ""}`);
  }
}
