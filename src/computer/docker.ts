import Docker from "dockerode";
import { PassThrough } from "node:stream";

export interface ExecResult { stdout: string; stderr: string; exitCode: number; timedOut: boolean }

export interface DockerClient {
  createContainer(opts: { image: string; name: string }): Promise<string>;
  isRunning(id: string): Promise<boolean>;
  start(id: string): Promise<void>;
  exec(id: string, cmd: string[], timeoutMs: number): Promise<ExecResult>;
}

export function dockerodeClient(socketPath: string): DockerClient {
  const docker = new Docker({ socketPath });
  return {
    async createContainer({ image, name }) {
      const c = await docker.createContainer({
        Image: image,
        name,
        User: "bot",
        HostConfig: { Memory: 1024 ** 3, NanoCpus: 1e9, PidsLimit: 256, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] },
      });
      await c.start();
      return c.id;
    },
    async isRunning(id) {
      return (await docker.getContainer(id).inspect()).State.Running;
    },
    async start(id) {
      await docker.getContainer(id).start();
    },
    async exec(id, cmd, timeoutMs) {
      const exec = await docker.getContainer(id).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
      const stream = await exec.start({ hijack: true, stdin: false });
      const out = new PassThrough();
      const err = new PassThrough();
      const chunks = { out: [] as Buffer[], err: [] as Buffer[] };
      out.on("data", (b: Buffer) => chunks.out.push(b));
      err.on("data", (b: Buffer) => chunks.err.push(b));
      docker.modem.demuxStream(stream, out, err);
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        new Promise<boolean>((r) => stream.once("end", () => r(false))),
        new Promise<boolean>((r) => { timer = setTimeout(() => r(true), timeoutMs); }),
      ]);
      clearTimeout(timer);
      const { ExitCode } = await exec.inspect();
      return {
        stdout: Buffer.concat(chunks.out).toString("utf8"),
        stderr: Buffer.concat(chunks.err).toString("utf8"),
        exitCode: ExitCode ?? -1,
        timedOut,
      };
    },
  };
}

export function fakeDockerClient(): DockerClient & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async createContainer(opts) { calls.push(["createContainer", opts.image, opts.name]); return `c-${calls.length}`; },
    async isRunning(id) { calls.push(["isRunning", id]); return true; },
    async start(id) { calls.push(["start", id]); },
    async exec(id, cmd) {
      calls.push(["exec", id, ...cmd]);
      return { stdout: cmd.join(" "), stderr: "", exitCode: 0, timedOut: false };
    },
  };
}
