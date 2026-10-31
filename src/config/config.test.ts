import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const full = {
  DATABASE_URL: "postgres://x", ANTHROPIC_API_KEY: "k", SECRETS_KEY: Buffer.alloc(32, 1).toString("base64"),
  clientId: "cid", tenantId: "tid", clientSecret: "sec",
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
  it("names a missing variable", () => {
    expect(() => loadConfig({ ...full, SECRETS_KEY: undefined })).toThrow(/SECRETS_KEY/);
  });
  it("rejects a SECRETS_KEY that is not 32 bytes", () => {
    expect(() => loadConfig({ ...full, SECRETS_KEY: "c2hvcnQ=" })).toThrow(/32 bytes/);
  });
});
