import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { computers } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { upsertDefinition } from "../bots/definitions.js";
import { upsertTenant } from "../org/org.js";
import { ensureComputer, runOnComputer } from "./computer.js";
import { fakeDockerClient } from "./docker.js";

async function setup() {
  const db = await testDb();
  await upsertTenant(db, { id: "t1" });
  const def = await upsertDefinition(db, Buffer.alloc(32, 3), "t1", { name: "a", label: "A", persona: "p" });
  return { db, def };
}

describe("computer", () => {
  it("creates once and reuses the container", async () => {
    const { db, def } = await setup();
    const docker = fakeDockerClient();
    const a = await ensureComputer(db, docker, "img", def.id);
    const b = await ensureComputer(db, docker, "img", def.id);
    expect(b).toBe(a);
    expect(docker.calls.filter((c) => c[0] === "createContainer")).toHaveLength(1);
  });

  it("starts a stopped container", async () => {
    const { db, def } = await setup();
    const docker = fakeDockerClient();
    const id = await ensureComputer(db, docker, "img", def.id);
    docker.isRunning = async (cid) => (docker.calls.push(["isRunning", cid]), false);
    expect(await ensureComputer(db, docker, "img", def.id)).toBe(id);
    expect(docker.calls).toContainEqual(["start", id]);
  });

  it("recreates a container that is gone (404)", async () => {
    const { db, def } = await setup();
    const docker = fakeDockerClient();
    const old = await ensureComputer(db, docker, "img", def.id);
    docker.isRunning = async () => { throw { statusCode: 404 }; };
    const next = await ensureComputer(db, docker, "img", def.id);
    expect(next).not.toBe(old);
    expect(docker.calls.filter((c) => c[0] === "createContainer")).toHaveLength(2);
    const [row] = await db.select().from(computers).where(eq(computers.definitionId, def.id));
    expect(row?.containerId).toBe(next);
  });

  it("rethrows other errors from isRunning", async () => {
    const { db, def } = await setup();
    const docker = fakeDockerClient();
    await ensureComputer(db, docker, "img", def.id);
    docker.isRunning = async () => { throw Object.assign(new Error("boom"), { statusCode: 500 }); };
    await expect(ensureComputer(db, docker, "img", def.id)).rejects.toThrow("boom");
  });

  it("formats stderr and exit code", async () => {
    const docker = fakeDockerClient();
    docker.exec = async () => ({ stdout: "out", stderr: "err", exitCode: 2, timedOut: false });
    expect(await runOnComputer(docker, "c", "x")).toBe("out\n[stderr]\nerr\n[exit 2]");
  });

  it("cuts long output", async () => {
    const docker = fakeDockerClient();
    docker.exec = async () => ({ stdout: "x".repeat(30000), stderr: "", exitCode: 0, timedOut: false });
    const out = await runOnComputer(docker, "c", "x");
    expect(out).toBe("x".repeat(20000) + "\n[output truncated]");
  });
});
