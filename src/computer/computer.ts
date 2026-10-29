import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { computers } from "../db/schema.js";
import type { DockerClient } from "./docker.js";

const MAX_OUTPUT = 20_000;

export async function ensureComputer(db: Db, docker: DockerClient, image: string, definitionId: string): Promise<string> {
  const [row] = await db.select().from(computers).where(eq(computers.definitionId, definitionId));
  if (row) {
    try {
      if (!(await docker.isRunning(row.containerId))) await docker.start(row.containerId);
      return row.containerId;
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 404) throw e; // container is gone: recreate below
    }
  }
  const containerId = await docker.createContainer({ image, name: `bebotter2-${definitionId}` });
  await db.insert(computers).values({ definitionId, containerId }).onConflictDoUpdate({ target: computers.definitionId, set: { containerId } });
  return containerId;
}

export async function runOnComputer(docker: DockerClient, containerId: string, command: string): Promise<string> {
  const r = await docker.exec(containerId, ["bash", "-lc", command], 120_000);
  const parts = [r.stdout];
  if (r.stderr) parts.push(`[stderr]\n${r.stderr}`);
  if (r.exitCode !== 0) parts.push(`[exit ${r.exitCode}]`);
  if (r.timedOut) parts.push("[timed out]");
  const out = parts.join("\n");
  return out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n[output truncated]` : out;
}
