import Docker from "dockerode";
import { afterAll, describe, expect, it } from "vitest";
import { runOnComputer } from "./computer.js";
import { dockerodeClient } from "./docker.js";

const socket = "/var/run/docker.sock";
const name = `bebotter2-test-${process.pid}`;

describe.skipIf(!process.env.BEBOTTER_DOCKER_TESTS)("computer (docker)", () => {
  afterAll(async () => {
    await new Docker({ socketPath: socket }).getContainer(name).remove({ force: true }).catch(() => {});
  });

  it("runs commands as bot in a fresh container", async () => {
    await new Docker({ socketPath: socket }).getImage("bebotter2-computer").inspect();
    const docker = dockerodeClient(socket);
    const id = await docker.createContainer({ image: "bebotter2-computer", name });
    expect(await runOnComputer(docker, id, "echo hi")).toBe("hi\n");
    expect(await runOnComputer(docker, id, "id -un")).toBe("bot\n");
    expect((await runOnComputer(docker, id, "yes | head -c 200000")).endsWith("\n[output truncated]")).toBe(true);
    const t = Date.now();
    const r = await docker.exec(id, ["bash", "-lc", "sleep 5"], 1000);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t).toBeLessThan(3000);
  });
});
