import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { systemSsh, validTarget, type ExecFileImpl } from "./ssh.js";

const have = (bin: string) => { try { execFileSync("which", [bin], { stdio: "ignore" }); return true; } catch { return false; } };
const target = { host: "pve1", port: 2222, username: "bot", privateKey: "KEY", hostKey: "ssh-ed25519 AAAAx" };
const dirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("bebotter-ssh-"));

describe("validTarget", () => {
  it("refuses option-like and malformed values", () => {
    for (const host of ["-oProxyCommand=x", "a b", "a;b", "u@h", "x\n"]) expect(validTarget({ host, port: 22, username: "u" })).toBeTruthy();
    for (const port of [0, 70000]) expect(validTarget({ host: "pve1", port, username: "u" })).toBeTruthy();
    expect(validTarget({ host: "h", port: 22, username: "-u" })).toBeTruthy();
    for (const host of ["pve1", "10.0.0.5", "pve1.tail1234.ts.net", "fd7a::1"]) expect(validTarget({ host, port: 22, username: "u" })).toBeUndefined();
  });
});

describe("systemSsh", () => {
  it.skipIf(!have("ssh-keygen"))("generateKey returns an OpenSSH ed25519 pair", async () => {
    const k = await systemSsh().generateKey("bot@test");
    expect(k.privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
    expect(k.publicKey.startsWith("ssh-ed25519 ")).toBe(true);
    expect(k.publicKey.endsWith(" bot@test")).toBe(true);
  });

  it("exec runs ssh without a shell and with the pinned-key options", async () => {
    let argv: string[] = [];
    let seen: string[] = [];
    const impl: ExecFileImpl = (file, args, _o, cb) => {
      expect(file).toBe("ssh");
      argv = args;
      const kh = args.find((a) => a.startsWith("UserKnownHostsFile="))!.slice(19);
      seen = [kh];
      expect(existsSync(kh)).toBe(true);
      cb(null, "hi", "");
    };
    const r = await systemSsh(impl).exec(target, "uptime");
    expect(argv).toContain("StrictHostKeyChecking=yes");
    expect(argv[argv.indexOf("-l") + 1]).toBe("bot");
    expect(argv.slice(argv.indexOf("--"))).toEqual(["--", "pve1", "uptime"]);
    expect(r).toMatchObject({ output: "hi", exitCode: 0, hostKey: target.hostKey, hostKeyMismatch: false });
    expect(existsSync(seen[0]!)).toBe(false);
    const failing: ExecFileImpl = (_f, _a, _o, cb) => cb(Object.assign(new Error("x"), { code: 1 }), "", "boom");
    expect((await systemSsh(failing).exec(target, "false")).exitCode).toBe(1);
    expect(dirs()).toEqual([]);
  });

  it("first connect reads the accepted key back (non-default and default port)", async () => {
    for (const port of [2222, 22]) {
      const { writeFileSync } = await import("node:fs");
      const impl: ExecFileImpl = (_f, args, _o, cb) => {
        expect(args).toContain("StrictHostKeyChecking=accept-new");
        const ref = port === 22 ? "pve1" : `[pve1]:${port}`;
        writeFileSync(args.find((a) => a.startsWith("UserKnownHostsFile="))!.slice(19), `${ref} ssh-ed25519 AAAAnew\n`);
        cb(null, "", "");
      };
      const r = await systemSsh(impl).exec({ ...target, port, hostKey: null }, "true");
      expect(r.hostKey).toBe("ssh-ed25519 AAAAnew");
    }
  });

  it("exit 255 with a changed host key on a pinned target sets hostKeyMismatch", async () => {
    const impl: ExecFileImpl = (_f, _a, _o, cb) => cb(Object.assign(new Error("x"), { code: 255 }), "", "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!");
    const r = await systemSsh(impl).exec(target, "uptime");
    expect(r.hostKeyMismatch).toBe(true);
    expect(r.exitCode).toBe(255);
    const unpinned = await systemSsh(impl).exec({ ...target, hostKey: null }, "uptime");
    expect(unpinned.hostKeyMismatch).toBe(false);
  });
});
