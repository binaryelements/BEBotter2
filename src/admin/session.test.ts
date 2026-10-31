import { describe, expect, it } from "vitest";
import { csrfOk, readSession, sessionKey, signSession } from "./session.js";

const key = sessionKey(Buffer.alloc(32, 1));
const payload = { personId: "p1", tenantId: "t1", csrf: "c".repeat(43), exp: 2_000_000 };
const cookie = (token: string) => `other=1; bb_session=${token}; x=y`;

describe("session", () => {
  it("round-trips", () => {
    expect(readSession(key, cookie(signSession(key, payload)), 1_000_000)).toEqual(payload);
  });

  it("rejects a tampered signature or payload", () => {
    const token = signSession(key, payload);
    const [body, sig] = token.split(".");
    const flipped = sig.slice(0, -2) + (sig.at(-2) === "A" ? "B" : "A") + sig.at(-1);
    expect(readSession(key, cookie(`${body}.${flipped}`), 1)).toBeUndefined();
    const other = Buffer.from(JSON.stringify({ ...payload, personId: "p2" })).toString("base64url");
    expect(readSession(key, cookie(`${other}.${sig}`), 1)).toBeUndefined();
    expect(readSession(key, cookie(`${token}!`), 1)).toBeUndefined();
  });

  it("rejects an expired session", () => {
    expect(readSession(key, cookie(signSession(key, payload)), payload.exp)).toBeUndefined();
  });

  it("rejects a session signed under another key", () => {
    const other = sessionKey(Buffer.alloc(32, 2));
    expect(readSession(key, cookie(signSession(other, payload)), 1)).toBeUndefined();
  });

  it("rejects malformed tokens and missing cookies", () => {
    for (const bad of ["", "abc", "a.b.c", ".", "!!.!!", `${Buffer.from("not json").toString("base64url")}.x`])
      expect(readSession(key, cookie(bad), 1)).toBeUndefined();
    expect(readSession(key, undefined, 1)).toBeUndefined();
    expect(readSession(key, "other=1", 1)).toBeUndefined();
    const wrongShape = signSession(key, { ...payload, personId: 5 } as never);
    expect(readSession(key, cookie(wrongShape), 1)).toBeUndefined();
  });

  it("csrfOk accepts the right token and rejects others", () => {
    expect(csrfOk(payload, { csrf: payload.csrf })).toBe(true);
    expect(csrfOk(payload, {})).toBe(false);
    expect(csrfOk(payload, { csrf: "wrong" })).toBe(false);
    expect(csrfOk(payload, { csrf: [payload.csrf] })).toBe(false);
  });
});
