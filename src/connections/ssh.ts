import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isIPv6 } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatOutput } from "../computer/computer.js";

const MAX_STREAM_BYTES = 65_536;
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const DNS_NAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const USERNAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const MISMATCH = /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed\./;

export type SshTarget = { host: string; port: number; username: string; privateKey: string; hostKey: string | null };
export type SshResult = { output: string; exitCode: number; hostKey: string | null; hostKeyMismatch: boolean };
export interface SshRunner {
  generateKey(comment: string): Promise<{ privateKey: string; publicKey: string }>;
  exec(target: SshTarget, command: string, timeoutMs?: number): Promise<SshResult>;
}

type ExecFileOpts = { timeout?: number; maxBuffer: number; encoding: "utf8" };
type ExecFileCb = (err: (Error & { code?: number | string; killed?: boolean }) | null, stdout: string, stderr: string) => void;
export type ExecFileImpl = (file: string, args: string[], opts: ExecFileOpts, cb: ExecFileCb) => unknown;

export function validTarget(t: { host: string; port: number; username: string }): string | undefined {
  if (typeof t.host !== "string" || t.host.length > 253 || !(DNS_NAME.test(t.host) || isIPv6(t.host))) return "invalid host";
  if (typeof t.username !== "string" || !USERNAME.test(t.username)) return "invalid username";
  if (!Number.isInteger(t.port) || t.port < 1 || t.port > 65535) return "invalid port";
  return undefined;
}

export function systemSsh(execFileImpl: ExecFileImpl = execFile as unknown as ExecFileImpl): SshRunner {
  const run = (file: string, args: string[], timeout?: number) =>
    new Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>((resolve, reject) => {
      execFileImpl(file, args, { timeout, maxBuffer: MAX_STREAM_BYTES, encoding: "utf8" }, (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, exitCode: 0, timedOut: false });
        // a missing binary (ENOENT) is a real failure; exit codes, timeouts and oversized output are results
        if (typeof err.code === "string" && err.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(err);
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode: typeof err.code === "number" ? err.code : -1, timedOut: err.killed === true && err.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
      });
    });
  const withDir = async <T>(fn: (dir: string) => Promise<T>) => {
    const dir = await mkdtemp(join(tmpdir(), "bebotter-ssh-"));
    try {
      await chmod(dir, 0o700);
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  return {
    generateKey: (comment) =>
      withDir(async (dir) => {
        const file = join(dir, "key");
        const r = await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", comment, "-f", file, "-q"]);
        if (r.exitCode !== 0) throw new Error("ssh-keygen failed");
        return { privateKey: await readFile(file, "utf8"), publicKey: (await readFile(`${file}.pub`, "utf8")).trim() };
      }),

    exec: (target, command, timeoutMs = 120_000) =>
      withDir(async (dir) => {
        const invalid = validTarget(target);
        if (invalid) throw new Error(invalid);
        const keyFile = join(dir, "key");
        const known = join(dir, "known_hosts");
        const hostRef = target.port === 22 ? target.host : `[${target.host}]:${target.port}`;
        await writeFile(keyFile, target.privateKey.endsWith("\n") ? target.privateKey : `${target.privateKey}\n`, { mode: 0o600 });
        if (target.hostKey) await writeFile(known, `${hostRef} ${target.hostKey}\n`, { mode: 0o600 });
        const r = await run("ssh", [
          "-F", "/dev/null", "-i", keyFile, "-p", String(target.port), "-l", target.username,
          "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=10",
          "-o", `UserKnownHostsFile=${known}`, "-o", `StrictHostKeyChecking=${target.hostKey ? "yes" : "accept-new"}`,
          "-o", "LogLevel=ERROR", "--", target.host, command,
        ], timeoutMs);
        let hostKey = target.hostKey;
        if (!hostKey) {
          // the throwaway file holds only this connection, and ssh lowercases the host it writes
          const f = (await readFile(known, "utf8").catch(() => "")).split("\n").find((l) => l.trim())?.trim().split(/\s+/);
          if (f && f.length >= 3) hostKey = `${f[1]} ${f[2]}`;
          else if (r.exitCode !== 255) throw new Error("host key not recorded");
        }
        const hostKeyMismatch = !!target.hostKey && r.exitCode === 255 && MISMATCH.test(r.stderr);
        return { output: formatOutput(r), exitCode: r.exitCode, hostKey, hostKeyMismatch };
      }),
  };
}

export function fakeSsh(opts: { hostKey?: string; mismatch?: boolean; output?: string } = {}): SshRunner & { calls: { target: SshTarget; command: string }[] } {
  const calls: { target: SshTarget; command: string }[] = [];
  return {
    calls,
    async generateKey(comment) {
      return { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n", publicKey: `ssh-ed25519 AAAAfake ${comment}` };
    },
    async exec(target, command) {
      calls.push({ target, command });
      if (opts.mismatch) return { output: "", exitCode: 255, hostKey: target.hostKey, hostKeyMismatch: true };
      return { output: opts.output ?? "", exitCode: 0, hostKey: target.hostKey ?? opts.hostKey ?? "ssh-ed25519 AAAAfake", hostKeyMismatch: false };
    },
  };
}
