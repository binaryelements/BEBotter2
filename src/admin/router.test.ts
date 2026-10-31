import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDb } from "../db/test-db.js";
import type { Db } from "../db/client.js";
import * as directory from "../org/directory.js";
import { createDepartment, setMembership, setRole } from "../org/directory.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { adminRouter } from "./router.js";
import { serve, sessionCookie } from "./test-server.js";

vi.mock("../org/directory.js", async (original) => {
  const mod = await original<typeof import("../org/directory.js")>();
  return { ...mod, listPeople: vi.fn(mod.listPeople) };
});

const secretsKey = Buffer.alloc(32, 9);
const config = {
  teams: { clientId: "client-1", tenantId: "tenant-1", clientSecret: "s" },
  publicUrl: "https://bot.example.test",
  adminEmails: [],
  secretsKey,
};

describe("admin router", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  let admin: string, head: string, user: string;

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
    const app = express();
    app.use("/admin", adminRouter({ db, config, exchangeCode: async () => ({ id_token: "x" }), verifyIdToken: async () => ({ oid: "", tid: "", name: "", email: "" }), botName: "Bot", defaultModel: "m", fetchUsers: async () => [] }));
    ({ url, close } = await serve(app));
  });
  afterAll(() => close());

  const get = (path: string, cookie?: string) => fetch(url + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
  const post = (path: string, body: Record<string, string>, cookie?: string) =>
    fetch(url + path, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams(body).toString(),
    });
  const as = (id: string) => sessionCookie(secretsKey, "tenant-1", id);

  it("leaves the sign-in routes open", async () => {
    const res = await get("/admin/auth/login");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("login.microsoftonline.com");
  });

  it("serves the design system assets without a session, cacheable, with the right types", async () => {
    for (const [file, type] of [["be/tokens.css", "text/css"], ["be/components.css", "text/css"], ["admin.css", "text/css"], ["be/be-mark-cyan.png", "image/png"]]) {
      const res = await get(`/admin/assets/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(type);
      expect(res.headers.get("cache-control")).not.toContain("no-store");
    }
    expect((await get("/admin/assets/nope.css")).status).not.toBe(200);
  });

  it("the theme link sets a Lax cookie on /admin and returns to the page; bad input is ignored", async () => {
    const res = await get("/admin/theme?set=light&next=/admin/people");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/people");
    expect(res.headers.get("set-cookie")).toBe("theme=light; Path=/admin; SameSite=Lax; Max-Age=31536000");
    const bad = await get("/admin/theme?set=red&next=//evil.example");
    expect(bad.headers.get("location")).toBe("/admin");
    expect(bad.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("pages carry the theme cookie, the company, the role and the current menu item; an invalid theme is ignored", async () => {
    const page = await (await get("/admin/people", `${as(admin)}; theme=light`)).text();
    expect(page).toContain('data-theme="light"');
    expect(page).toContain('class="active" aria-current="page">People</a>');
    expect(page).toContain("Ann</b> · admin");
    expect(await (await get("/admin/people", `${as(admin)}; theme=bogus`)).text()).not.toContain("data-theme");
    expect(await (await get("/admin/people", as(head))).text()).toContain("Hal</b> · head");
  });

  it("a GET without a session redirects to sign-in", async () => {
    for (const path of ["/admin", "/admin/people", "/admin/departments"]) {
      const res = await get(path);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/admin/auth/login");
    }
  });

  it("a forged or expired session is treated as none", async () => {
    expect((await get("/admin/people", sessionCookie(Buffer.alloc(32, 1), "tenant-1", admin))).status).toBe(303);
    expect((await get("/admin/people", "bb_session=garbage")).status).toBe(303);
  });

  it("an oversized form without a session is a plain 400, not logged", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await post("/admin/departments", { name: "x".repeat(200_000) });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Bad request.");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("sets no-store and frame-ancestors on pages and the sign-in redirect", async () => {
    for (const res of [await get("/admin/people", as(admin)), await get("/admin/people"), await get("/admin/auth/login")]) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    }
  });

  it("a POST without a session is 403", async () => {
    const res = await post("/admin/departments", { name: "X", csrf: "csrf-1" });
    expect(res.status).toBe(403);
  });

  it("a signed-in user who is neither admin nor head is refused", async () => {
    expect((await get("/admin/people", as(user))).status).toBe(403);
    expect((await get("/admin/people", sessionCookie(secretsKey, "tenant-1", "no-such-person"))).status).toBe(403);
  });

  it("GET /admin lands admins and heads on the Overview; plain users are refused", async () => {
    for (const who of [admin, head]) {
      const res = await get("/admin", as(who));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<h1>Overview</h1>");
    }
    expect((await get("/admin/overview", as(user))).status).toBe(403);
  });

  it("a POST with a missing or wrong csrf is 403", async () => {
    expect((await post("/admin/departments", { name: "NoCsrf" }, as(admin))).status).toBe(403);
    expect((await post("/admin/departments", { name: "BadCsrf", csrf: "nope" }, as(admin))).status).toBe(403);
    const names = (await directory.listDepartments(db, "tenant-1")).map((d) => d.name);
    expect(names).not.toContain("NoCsrf");
    expect(names).not.toContain("BadCsrf");
  });

  it("an unknown error renders a plain 500 page without a stack", async () => {
    vi.mocked(directory.listPeople).mockRejectedValueOnce(new Error("secret internals at /src/x.ts:1"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await get("/admin/people", as(admin));
    const body = await res.text();
    expect(res.status).toBe(500);
    expect(body).toContain("Something went wrong.");
    expect(body).not.toContain("secret internals");
    expect(body).not.toMatch(/\n\s+at /);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
