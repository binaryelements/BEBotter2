import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const full = {
  DATABASE_URL: "postgres://x", ANTHROPIC_API_KEY: "k", SECRETS_KEY: Buffer.alloc(32, 1).toString("base64"),
  PUBLIC_URL: "https://x.test", clientId: "cid", tenantId: "tid", clientSecret: "sec",
};

describe("loadConfig", () => {
  it("fills defaults", () => {
    const c = loadConfig(full);
    expect(c.botName).toBe("BE Bot");
    expect(c.defaultModel).toBe("claude-haiku-5-5");
    expect(c.port).toBe(3978);
    expect(c.computerImage).toBe("bebotter2-computer");
    expect(c.dockerSocket).toBe("/var/run/docker.sock");
    expect(c.filesDir).toBe("/srv/files");
    expect(c.secretsKey.length).toBe(32);
  });
  it("turns mailboxes on only with an admin key", () => {
    expect(loadConfig(full).agentmail).toBeUndefined();
    expect(loadConfig({ ...full, AGENTMAIL_ADMIN_KEY: "k", AGENTMAIL_URL: "https://m.test/" }).agentmail).toEqual({ url: "https://m.test", adminKey: "k" });
    expect(loadConfig({ ...full, AGENTMAIL_ADMIN_KEY: "k" }).agentmail?.url).toBe("https://agentmail.a.sapautomate.com");
  });
  it("names a missing variable", () => {
    expect(() => loadConfig({ ...full, SECRETS_KEY: undefined })).toThrow(/SECRETS_KEY/);
  });
  it("rejects a SECRETS_KEY that is not 32 bytes", () => {
    expect(() => loadConfig({ ...full, SECRETS_KEY: "c2hvcnQ=" })).toThrow(/32 bytes/);
  });
  it("normalises PUBLIC_URL and defaults ADMIN_EMAILS", () => {
    const c = loadConfig({ ...full, PUBLIC_URL: "https://x.test/" });
    expect(c.publicUrl).toBe("https://x.test");
    expect(c.adminEmails).toEqual([]);
  });
  it("lower-cases and splits ADMIN_EMAILS", () => {
    expect(loadConfig({ ...full, ADMIN_EMAILS: "A@x.test, b@x.test" }).adminEmails).toEqual(["a@x.test", "b@x.test"]);
  });
  it("names a missing PUBLIC_URL", () => {
    expect(() => loadConfig({ ...full, PUBLIC_URL: undefined })).toThrow(/PUBLIC_URL/);
  });
  it("requires an absolute https PUBLIC_URL", () => {
    for (const v of ["http://x.test", "x.test", "/admin", "https://", ""]) expect(() => loadConfig({ ...full, PUBLIC_URL: v })).toThrow(/PUBLIC_URL/);
  });
});
