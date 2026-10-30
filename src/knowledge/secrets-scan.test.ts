import { describe, expect, it } from "vitest";
import { findSecret } from "./secrets-scan.js";

describe("findSecret", () => {
  it("finds private keys, tokens and passwords", () => {
    expect(findSecret("-----BEGIN OPENSSH PRIVATE KEY-----\nabc")).toBe("private key");
    expect(findSecret("-----BEGIN RSA PRIVATE KEY-----")).toBe("private key");
    for (const t of ["sk-ant-api03-abcdefgh1234", "ghp_" + "a".repeat(30), "github_pat_" + "a".repeat(30), "xoxb-1234567890-abc", "AKIAABCDEFGHIJKLMNOP", "eyJhbGciOi.eyJzdWIiOi.sig_nature"]) {
      expect(findSecret(`use ${t} here`)).toBe("token");
    }
    expect(findSecret("password: hunter2")).toBe("password");
    expect(findSecret("DB_PASSWD=abc123")).toBe("password");
    expect(findSecret("token = abc")).toBe("token");
  });

  it("allows public keys, fingerprints and placeholder passwords", () => {
    expect(findSecret("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample host")).toBeUndefined();
    expect(findSecret("SHA256:abcdEFGH1234+/xyz")).toBeUndefined();
    for (const p of ["password: <set in vault>", "password: ***", "password: [redacted]", "password:", "token = <token>"]) {
      expect(findSecret(p)).toBeUndefined();
    }
  });
});
