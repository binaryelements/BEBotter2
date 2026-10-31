import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "../db/test-db.js";
import type { Db } from "../db/client.js";
import { getDefinition, listDefinitions, setAllowedDepartments } from "../bots/definitions.js";
import { createDepartment, setMembership, setRole } from "../org/directory.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { adminRouter } from "./router.js";
import { serve, sessionCookie } from "./test-server.js";

const secretsKey = Buffer.alloc(32, 5);
const T = "tenant-1";
const config = { teams: { clientId: "c", tenantId: T, clientSecret: "s" }, publicUrl: "https://bot.example.test", adminEmails: [], secretsKey };

describe("bots screen", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  const id: Record<string, string> = {};
  let sales: string;

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: T });
    for (const name of ["Ann", "Hal", "Eve"]) id[name] = (await upsertPerson(db, { tenantId: T, aadObjectId: `aad-${name}`, name })).id;
    await setRole(db, T, id.Ann, "admin");
    sales = (await createDepartment(db, T, "Sales")).id;
    const eng = (await createDepartment(db, T, "Engineering")).id;
    await setMembership(db, T, sales, id.Hal, "head");
    await setMembership(db, T, eng, id.Eve, "head");
    const app = express();
    app.use("/admin", adminRouter({ db, config, exchangeCode: async () => ({ id_token: "x" }), verifyIdToken: async () => ({ oid: "", tid: "", name: "", email: "" }), botName: "Bot", defaultModel: "m-default", fetchUsers: async () => [] }));
    ({ url, close } = await serve(app));
  });
  afterAll(() => close());

  const get = (path: string, who: string) => fetch(url + path, { redirect: "manual", headers: { cookie: sessionCookie(secretsKey, T, id[who]) } });
  const post = (path: string, who: string, body: [string, string][]) =>
    fetch(url + path, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie(secretsKey, T, id[who]) },
      body: new URLSearchParams([["csrf", "csrf-1"], ...body]).toString(),
    });
  const def = async (name: string) => (await listDefinitions(db, T)).find((d) => d.name === name)!;

  it("an admin creates a bot, adds a server with a header, and never sees the header value", async () => {
    const res = await post("/admin/bots", "Ann", [["name", "helper"], ["label", "Helper"], ["persona", "Be useful."], ["model", "m1"]]);
    expect(res.status).toBe(303);
    const d = await def("helper");
    expect(d.model).toBe("m1");
    const add = await post(`/admin/bots/${d.id}/servers`, "Ann", [
      ["name", "tickets"], ["transport", "http"], ["url", "https://mcp.example.test/"], ["headerName", "Authorization"], ["headerValue", "Bearer s3cret"], ["readOnlyTools", "list_a, list_b"],
    ]);
    expect(add.status).toBe(303);
    const page = await (await get(`/admin/bots/${d.id}`, "Ann")).text();
    expect(page).toContain("tickets");
    expect(page).toContain("headers set");
    expect(page).toContain("list_a, list_b");
    expect(page).not.toContain("s3cret");
    expect(JSON.stringify((await getDefinition(db, T, d.id))!.mcpServers)).not.toContain("s3cret");
    expect(await (await get("/admin/bots", "Ann")).text()).not.toContain("s3cret");
  });

  it("saving the main form keeps the stored headers byte-identical", async () => {
    const d = await def("helper");
    const before = d.mcpServers[0].headersCipher;
    expect(before).toBeTruthy();
    const res = await post(`/admin/bots/${d.id}`, "Ann", [["label", "Helper 2"], ["persona", "New."], ["model", "m2"], ["webSearch", "on"], ["departments", sales]]);
    expect(res.status).toBe(303);
    const after = (await getDefinition(db, T, d.id))!;
    expect(after.mcpServers[0].headersCipher).toBe(before);
    expect([after.label, after.model, after.webSearch, after.computer]).toEqual(["Helper 2", "m2", true, false]);
  });

  it("a head of a linked department edits the persona only", async () => {
    const d = await def("helper");
    expect((await get(`/admin/bots/${d.id}`, "Hal")).status).toBe(200);
    expect((await post(`/admin/bots/${d.id}`, "Hal", [["persona", "By head."], ["model", "evil"]])).status).toBe(303);
    const after = (await getDefinition(db, T, d.id))!;
    expect([after.persona, after.model]).toEqual(["By head.", "m2"]);
    expect((await post(`/admin/bots/${d.id}/servers`, "Hal", [["name", "x"], ["transport", "stdio"], ["command", "c"]])).status).toBe(403);
    expect((await post(`/admin/bots/${d.id}/servers/tickets/delete`, "Hal", [])).status).toBe(403);
    expect((await post("/admin/bots", "Hal", [["name", "n"], ["label", "n"]])).status).toBe(403);
  });

  it("a head of an unrelated department gets 403, and the list shows only linked bots", async () => {
    const d = await def("helper");
    expect((await post(`/admin/bots/${d.id}`, "Eve", [["persona", "no"]])).status).toBe(403);
    expect((await get(`/admin/bots/${d.id}`, "Eve")).status).toBe(403);
    await post("/admin/bots", "Ann", [["name", "other"], ["label", "Other"], ["persona", "p"]]);
    expect(await (await get("/admin/bots", "Hal")).text()).toContain("Helper 2");
    const eve = await (await get("/admin/bots", "Eve")).text();
    expect(eve).not.toContain("Helper 2");
    expect(eve).not.toContain(">Other<");
    const ann = await (await get("/admin/bots", "Ann")).text();
    expect(ann).toContain("Helper 2");
    expect(ann).toContain("Other");
  });

  it("invalid server input shows the message with 400 and stores nothing; duplicates are rejected", async () => {
    const d = await def("helper");
    let res = await post(`/admin/bots/${d.id}/servers`, "Ann", [["name", "s1"], ["transport", "stdio"]]);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("requires command");
    res = await post(`/admin/bots/${d.id}/servers`, "Ann", [["name", "computer"], ["transport", "stdio"], ["command", "c"]]);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("reserved");
    res = await post(`/admin/bots/${d.id}/servers`, "Ann", [["name", "tickets"], ["transport", "stdio"], ["command", "c"]]);
    expect(res.status).toBe(400);
    for (const h of [[["headerName", "X-A"]], [["headerValue", "v"]], [["headerName", "bad name"], ["headerValue", "v"]]] as [string, string][][]) {
      res = await post(`/admin/bots/${d.id}/servers`, "Ann", [["name", "s2"], ["transport", "stdio"], ["command", "c"], ...h]);
      expect(res.status).toBe(400);
    }
    for (const v of ["a\r\nX-B: c", "a\nb", "a\0b", "   "]) {
      res = await post(`/admin/bots/${d.id}/servers`, "Ann", [["name", "s2"], ["transport", "http"], ["url", "https://mcp.example.test/"], ["headerName", "X-A"], ["headerValue", v]]);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Invalid header value");
    }
    expect((await getDefinition(db, T, d.id))!.mcpServers.map((s) => s.name)).toEqual(["tickets"]);
  });

  it("an admin removes a server", async () => {
    const d = await def("helper");
    expect((await post(`/admin/bots/${d.id}/servers/tickets/delete`, "Ann", [])).status).toBe(303);
    expect((await getDefinition(db, T, d.id))!.mcpServers).toEqual([]);
    await setAllowedDepartments(db, T, d.id, []);
  });
});
