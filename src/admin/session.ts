import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export type Session = { personId: string; tenantId: string; csrf: string; exp: number };

export const SESSION_COOKIE = "bb_session";
export const LOGIN_COOKIE = "bb_login";

const derive = (secretsKey: Buffer, info: string) => Buffer.from(hkdfSync("sha256", secretsKey, Buffer.alloc(0), info, 32));
export const sessionKey = (secretsKey: Buffer) => derive(secretsKey, "admin-session");
/** A separate key, so a login-state token can never pass as a session and vice versa. */
export const loginKey = (secretsKey: Buffer) => derive(secretsKey, "admin-login");

const mac = (key: Buffer, body: string) => createHmac("sha256", key).update(body).digest();

/** `base64url(payloadJson).base64url(hmac)`; `exp` is in milliseconds since the epoch. */
export function signToken<T extends { exp: number }>(key: Buffer, payload: T): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(key, body).toString("base64url")}`;
}

export function readToken(key: Buffer, token: string | undefined, now = Date.now()): Record<string, unknown> | undefined {
  const parts = token?.split(".");
  if (parts?.length !== 2) return undefined;
  const [body, sig] = parts;
  // Compare the encoded form: base64url decoding ignores stray characters, so decoded bytes would accept many spellings.
  const given = Buffer.from(sig);
  const expected = Buffer.from(mac(key, body).toString("base64url"));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  return typeof p.exp === "number" && p.exp > now ? p : undefined;
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of header?.split(";") ?? []) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!out.has(name)) out.set(name, part.slice(i + 1).trim());
  }
  return out;
}

/** `maxAge` in seconds; 0 clears the cookie. */
export const cookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export const signSession = (key: Buffer, payload: Session) => signToken(key, payload);

export function readSession(key: Buffer, cookieHeader: string | undefined, now = Date.now()): Session | undefined {
  const p = readToken(key, parseCookies(cookieHeader).get(SESSION_COOKIE), now);
  if (!p || typeof p.personId !== "string" || typeof p.tenantId !== "string" || typeof p.csrf !== "string") return undefined;
  return { personId: p.personId, tenantId: p.tenantId, csrf: p.csrf, exp: p.exp as number };
}

/** Constant-time on hashes, so neither content nor length leaks. */
export function sameSecret(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

export function csrfOk(session: Session, body: Record<string, unknown>): boolean {
  return typeof body.csrf === "string" && body.csrf.length > 0 && sameSecret(body.csrf, session.csrf);
}
