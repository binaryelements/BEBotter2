import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { upsertDefinition } from "../bots/definitions.js";
import { definitionConnections } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { setRole } from "../org/directory.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { ensureProxmoxConnections } from "./proxmox.js";
import { fakeSsh } from "./ssh.js";
import { listConnections } from "./store.js";

describe("proxmox connections", () => {
  it("creates the four NextDC SSH connections once, linked to IT Support", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const admin = await upsertPerson(db, { tenantId: "t1", aadObjectId: "u1", name: "Ann" });
    await setRole(db, "t1", admin.id, "admin");
    const bot = await upsertDefinition(db, Buffer.alloc(32, 1), "t1", { name: "it-support", label: "IT Support", persona: "p" });
    const ssh = fakeSsh();
    await ensureProxmoxConnections(db, Buffer.alloc(32, 2), "t1", ssh);
    const conns = await listConnections(db, "t1");
    expect(conns.map((c) => c.name).sort()).toEqual(["imm2", "imm3", "imm7", "imm8"]);
    expect(conns.map((c) => c.target).sort()).toEqual(["100.67.87.38", "100.79.208.112", "100.91.127.23", "100.93.121.45"]);
    for (const c of conns) {
      expect(c).toMatchObject({ kind: "ssh", mode: "change", status: "pending" });
      expect(c.config).toMatchObject({ port: 22, username: "root" });
      expect(c.publicKey).toContain("ssh-ed25519");
      expect((await db.select().from(definitionConnections).where(eq(definitionConnections.connectionId, c.id))).map((l) => l.definitionId)).toEqual([bot.id]);
    }
    await ensureProxmoxConnections(db, Buffer.alloc(32, 2), "t1", ssh);
    expect(await listConnections(db, "t1")).toHaveLength(4);
  });
});
