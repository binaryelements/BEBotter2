import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "./cipher.js";

describe("cipher", () => {
  it("round-trips and detects tampering", () => {
    const key = Buffer.alloc(32, 7);
    const c = encrypt(key, "hunter2");
    expect(c).not.toContain("hunter2");
    expect(decrypt(key, c)).toBe("hunter2");
    expect(encrypt(key, "hunter2")).not.toBe(c); // fresh iv each time
    const bytes = Buffer.from(c, "base64"); bytes[bytes.length - 1] ^= 1;
    expect(() => decrypt(key, bytes.toString("base64"))).toThrow();
    expect(() => decrypt(Buffer.alloc(32, 8), c)).toThrow();
  });
});
