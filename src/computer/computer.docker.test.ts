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
  });
});
