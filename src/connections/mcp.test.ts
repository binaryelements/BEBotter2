import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { connectionsMcpServer } from "./mcp.js";
import { fakeSsh } from "./ssh.js";
import { getConnection } from "./store.js";

type Result = { isError?: boolean; content: { text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

describe("connections mcp", () => {
  let db: Db;
  const key = randomBytes(32);
  let personId: string;
  let confirmer: string | undefined;
  let call: (name: string, args?: Record<string, unknown>) => Promise<Result>;
  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const definitionId = (await upsertDefinition(db, key, "t1", { name: "ops", label: "Ops", persona: "p" })).id;
    personId = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "a1", name: "Ann" })).id;
    const server = connectionsMcpServer({ db, ssh: fakeSsh({ output: "up 3 days" }), secretsKey: key }, { tenantId: "t1", definitionId, personId, confirmedBy: () => confirmer });
    const tools = (server.instance as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
    call = (name, args = {}) => tools[name].handler(args);
  });

  it("no tool result contains the private key", async () => {
    const results = [
      await call("request", { kind: "ssh", name: "pve1", target: "pve1.example.test", mode: "read-only", username: "bot" }),
      await call("request", { kind: "ssh", name: "pve2", target: "pve2.example.test", mode: "change", username: "bot" }),
      await call("request", { kind: "http", name: "api", target: "https://api.example.test/", mode: "read-only", auth: { in: "header", name: "Authorization" } }),
      await call("list"),
      await call("verify", { name: "pve1" }),
      await call("verify", { name: "pve2" }),
      await call("verify", { name: "api" }),
      await call("ssh_read", { name: "pve1", command: "uptime" }),
      await call("ssh_change", { name: "pve1", command: "reboot" }),
      await call("approve", { name: "pve2" }),
    ];
    expect(results[0].content[0].text).toContain("Public key: ssh-ed25519 AAAAfake ops@pve1");
    expect(results[7].content[0].text).toBe("up 3 days");
    expect(results[8].isError).toBe(true);
    for (const r of results) {
      const text = r.content.map((c) => c.text).join("\n");
      expect(text).not.toContain("BEGIN OPENSSH");
      expect(text).not.toContain("fake\n-----END");
      expect(text).not.toContain((await getConnection(db, "t1", "pve1"))!.secretCipher!);
    }
  });

  it("approve activates with the confirming person recorded", async () => {
    await call("request", { kind: "ssh", name: "pve3", target: "pve3.example.test", mode: "change", username: "bot" });
    await call("verify", { name: "pve3" });
    confirmer = undefined;
    expect((await call("approve", { name: "pve3" })).isError).toBe(true);
    confirmer = personId;
    const r = await call("approve", { name: "pve3" });
    expect(r.isError).toBeUndefined();
    expect(await getConnection(db, "t1", "pve3")).toMatchObject({ status: "active", approvedByPersonId: personId });
    expect((await call("ssh_change", { name: "pve3", command: "reboot" })).content[0].text).toBe("up 3 days");
  });
});
