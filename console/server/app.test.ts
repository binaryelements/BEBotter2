import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, sessionCookie } from "../../src/admin/test-server.js";
import { beginAction } from "../../src/audit/audit.js";
import { upsertDefinition } from "../../src/bots/definitions.js";
import type { Db } from "../../src/db/client.js";
import { testDb } from "../../src/db/test-db.js";
import { createDepartment, setMembership, setRole } from "../../src/org/directory.js";
import { upsertPerson, upsertTenant } from "../../src/org/org.js";
import { consoleApp } from "./app.js";

const secretsKey = Buffer.alloc(32, 9);

describe("console api", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  let admin: string, head: string, user: string;
  const as = (personId: string) => ({ cookie: sessionCookie(secretsKey, "tenant-1", personId) });

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: "tenant-1" });
    const p = (name: string) => upsertPerson(db, { tenantId: "tenant-1", aadObjectId: `aad-${name}`, name }).then((r) => r.id);
    admin = await p("Ann");
    head = await p("Hal");
    user = await p("Uma");
    await setRole(db, "tenant-1", admin, "admin");
    const sales = await createDepartment(db, "tenant-1", "Sales");
    await setMembership(db, "tenant-1", sales.id, head, "head");
    ({ url, close } = await serve(consoleApp({ db, secretsKey, pollMs: 50 })));
  });
  afterAll(() => close());

  it("answers under the path prefix and without it, and only to someone signed in who may enter", async () => {
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/admin/console/api/me`)).status).toBe(401);
    expect((await fetch(`${url}/api/me`, { headers: { cookie: "bb_session=forged" } })).status).toBe(401);
    expect((await fetch(`${url}/api/me`, { headers: as(user) })).status).toBe(403);
    const me = await fetch(`${url}/admin/console/api/me`, { headers: as(admin) });
    expect(me.headers.get("cache-control")).toBe("no-store");
    expect(await me.json()).toMatchObject({ name: "Ann", admin: true, csrf: "csrf-1" });
    expect(await (await fetch(`${url}/api/me`, { headers: as(head) })).json()).toMatchObject({ name: "Hal", admin: false, headOf: [expect.any(String)] });
  });

  it("refuses a change that does not carry the session's token", async () => {
    const post = (headers: Record<string, string>) => fetch(`${url}/api/nothing-yet`, { method: "POST", headers: { ...as(admin), ...headers } }).then((r) => r.status);
    expect(await post({})).toBe(403);
    expect(await post({ "x-csrf": "wrong" })).toBe(403);
    expect(await post({ "x-csrf": "csrf-1" })).toBe(404);
  });

  it("pushes what needs attention to an open page when it changes, and tells a department head nothing", async () => {
    const ctl = new AbortController();
    const res = await fetch(`${url}/api/events`, { headers: as(admin), signal: ctl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    const next = async (): Promise<{ approvals: number; items: { kind: string; title: string }[] }> => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        const data = /^data: (.*)$/m.exec(value)?.[1];
        if (data) return JSON.parse(data);
      }
    };
    expect(await next()).toMatchObject({ approvals: 0, items: [] });
    const bot = await upsertDefinition(db, secretsKey, "tenant-1", { name: "it", label: "IT", persona: "p", model: "m" } as never);
    await beginAction(db, { tenantId: "tenant-1", definitionId: bot.id, kind: "tool", toolName: "ssh_change", summary: "restart nginx on pve1" });
    expect(await next()).toMatchObject({ approvals: 1, items: [{ kind: "approval", title: "restart nginx on pve1" }] });
    ctl.abort();
    expect(await (await fetch(`${url}/api/notifications`, { headers: as(head) })).json()).toEqual({ approvals: 0, failures: 0, items: [] });
  });
});
