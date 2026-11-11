import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "../db/test-db.js";
import type { Db } from "../db/client.js";
import { ensurePersonalAssistant, ensurePersonalDefinition, getDefinition, listDefinitions, setAllowedDepartments, upsertDefinition } from "../bots/definitions.js";
import { recordTools, toolRulesFor } from "../engine/tool-rules.js";
import { createDepartment, setMembership, setPersonalBot, setRole } from "../org/directory.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { GRAPH_CAPABILITIES, botDefinitions, definitionDepartments, people, connections, chatAssignments, chats, mailboxes, auditEvents, routines } from "../db/schema.js";
import { getConnectionGrant, listConnectionsFor } from "../connections/store.js";
import { fakeSsh } from "../connections/ssh.js";
import { encrypt } from "../secrets/cipher.js";
import { createRoutine, listRoutines } from "../routines/store.js";
import { addLearning, listLearnings } from "../learnings/store.js";
import { createProposal, listProposals, saveReflection } from "../reflections/store.js";
import { listAllMemory } from "../memory/store.js";
import { eq } from "drizzle-orm";
import type { MailDeps } from "../mail/mailboxes.js";
import { MailError } from "../mail/agentmail.js";
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
    for (const name of ["Ann", "Hal", "Eve", "Mo"]) id[name] = (await upsertPerson(db, { tenantId: T, aadObjectId: `aad-${name}`, name })).id;
    await setRole(db, T, id.Ann, "admin");
    sales = (await createDepartment(db, T, "Sales")).id;
    const eng = (await createDepartment(db, T, "Engineering")).id;
    await setMembership(db, T, sales, id.Hal, "head");
    await setMembership(db, T, eng, id.Eve, "head");
    const app = express();
    app.use("/admin", adminRouter({ db, config, exchangeCode: async () => ({ id_token: "x" }), verifyIdToken: async () => ({ oid: "", tid: "", name: "", email: "" }), botName: "Bot", defaultModel: "m-default", fetchUsers: async () => [],
      // no MCP server answers here, so listing a server's tools always fails
      fetchFn: (async () => { throw Object.assign(new Error("down"), { cause: { code: "ECONNREFUSED" } }); }) as typeof fetch,
      ssh: fakeSsh(), sql: async () => ({ columns: ["?"], rows: [[1]] }) }));
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

  it("a persona template fills the add-bot form; an unknown one leaves it empty", async () => {
    const page = await (await get("/admin/bots?template=it-support", "Ann")).text();
    expect(page).toContain('id="add" open');
    expect(page).toContain('href="/admin/bots?template=finance#add"');
    expect(page).toMatch(/name="displayName" maxlength="60" value="Iris"[\s\S]*name="name" required value="it-support"[\s\S]*name="label" required value="IT Support"/);
    expect(page).toMatch(/<textarea name="persona" rows="10">You are Iris, IT support/);
    const blank = await (await get("/admin/bots?template=nope", "Ann")).text();
    expect(blank).not.toContain('id="add" open');
    expect(blank).toContain('<textarea name="persona" rows="10"></textarea>');
  });

  it("an admin creates a bot, adds a server with a header, and never sees the header value", async () => {
    const res = await post("/admin/bots", "Ann", [["name", "helper"], ["label", "Helper"], ["persona", "Be useful."], ["model", "m1"]]);
    expect(res.status).toBe(303);
    const d = await def("helper");
    expect(d.model).toBe("m1");
    const add = await post(`/admin/bots/${d.id}/servers`, "Ann", [
      ["name", "tickets"], ["transport", "http"], ["url", "https://mcp.example.test/"], ["headerName", "Authorization"], ["headerValue", "Bearer s3cret"], ["readOnlyTools", "list_a, list_b"],
    ]);
    // saved even though its tools could not be listed, and the page says so without the header
    expect(add.status).toBe(400);
    const why = await add.text();
    expect(why).toContain("tickets was saved, but its tools could not be listed: Request failed: ECONNREFUSED");
    expect(why).not.toContain("s3cret");
    const page = await (await get(`/admin/bots/${d.id}?tab=connections`, "Ann")).text();
    expect(page).toContain("tickets");
    expect(page).toContain("headers set");
    expect(page).toContain("list_a, list_b");
    expect(page).not.toContain("s3cret");
    expect(JSON.stringify((await getDefinition(db, T, d.id))!.mcpServers)).not.toContain("s3cret");
    expect(await (await get("/admin/bots", "Ann")).text()).not.toContain("s3cret");
  });

  it("an admin adds an sql connection with its password and gives it to a bot; the page never shows the password", async () => {
    const d = await def("helper");
    const res = await post("/admin/connections", "Ann", [
      ["name", "sap"], ["kind", "sql"], ["target", "sql1.example.test"], ["mode", "read-only"], ["engine", "mssql"], ["database", "SBO"], ["username", "reader"], ["secret", "pw-top"], ["definitionId", d.id], ["description", "SAP B1 company database; look things up, never write"],
    ]);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/connections?saved=1");
    const page = await (await get("/admin/connections", "Ann")).text();
    expect(page).toContain('<span class="nm">sap</span>');
    expect(page).toContain("sql1.example.test");
    expect(page).toContain('<option value="read-only" selected>read-only</option>');
    expect(page).toContain(`/admin/bots/${d.id}?tab=connections`);
    expect(page).toContain("SAP B1 company database; look things up, never write");
    expect(page).not.toContain("pw-top");
    const id = page.match(/\/admin\/connections\/([^/]+)\/description/)![1];
    expect((await post(`/admin/connections/${id}/description`, "Ann", [["description", "SAP B1 live company; read only"]])).status).toBe(303);
    expect(await (await get(`/admin/bots/${d.id}?tab=connections`, "Ann")).text()).toContain("SAP B1 live company; read only");
    const duplicate = await post("/admin/connections", "Ann", [["name", "sap"], ["kind", "sql"], ["target", "x"], ["mode", "read-only"], ["engine", "mysql"], ["database", "d"], ["username", "u"], ["secret", "p"]]);
    expect(duplicate.status).toBe(303);
    const duplicateError = duplicate.headers.get("location")!;
    expect(duplicateError).toContain("/admin/connections?error=");
    const duplicatePage = await (await get(duplicateError, "Ann")).text();
    expect(duplicatePage).toContain("Connection not saved");
    expect(duplicatePage).toContain("already exists");
    expect(duplicatePage).toContain('id="add" open');
    expect((await post("/admin/connections", "Hal", [["name", "x"], ["kind", "http"], ["target", "https://x.test/"], ["mode", "read-only"]])).status).toBe(403);
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

  describe("the Personal bot", () => {
    let pid: string;
    beforeAll(async () => {
      await db.update(people).set({ personalBot: true }).where(eq(people.id, id.Mo));
      pid = (await ensurePersonalAssistant(db, T, id.Mo, "m")).id;
      await db.insert(definitionDepartments).values({ definitionId: pid, departmentId: sales }); // a stale link, by hand: the save refuses one
    });

    it("has a Microsoft 365 tab and no Email or Connections tab", async () => {
      const page = await (await get(`/admin/bots/${pid}`, "Ann")).text();
      expect(page).toContain("Acts as Mo in their own chat");
      expect(page).toContain(`href="/admin/bots/${pid}?tab=m365"`);
      expect(page).toContain(">Microsoft 365<");
      expect(page).not.toContain("?tab=email");
      expect(page).not.toContain("?tab=connections");
      const m365 = await (await get(`/admin/bots/${pid}?tab=m365`, "Ann")).text();
      for (const c of GRAPH_CAPABILITIES) expect(m365).toContain(`name="graph" value="${c}" checked`);
    });

    it("a service bot has no Microsoft 365 tab and refuses its post (400)", async () => {
      const d = await def("helper");
      expect(await (await get(`/admin/bots/${d.id}`, "Ann")).text()).not.toContain("?tab=m365");
      expect((await post(`/admin/bots/${d.id}/m365`, "Ann", [["graph", "mail.read"]])).status).toBe(400);
    });

    it("saves the capabilities, keeps identity, and ignores unknown ones", async () => {
      const before = await getDefinition(db, T, pid);
      const res = await post(`/admin/bots/${pid}/m365`, "Ann", [["graph", "mail.read"], ["graph", "calendar.read"], ["graph", "bogus"], ["identity", "service"]]);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`/admin/bots/${pid}?tab=m365`);
      const after = (await getDefinition(db, T, pid))!;
      expect(after.graph).toEqual(["mail.read", "calendar.read"]);
      expect(after.identity).toBe("person");
      expect(after.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
      const m365 = await (await get(`/admin/bots/${pid}?tab=m365`, "Ann")).text();
      expect(m365).toContain('value="mail.read" checked');
      expect(m365).not.toContain('value="mail.send" checked');
    });

    it("a head never edits it, even with a department link, and does not see it in the list", async () => {
      expect((await post(`/admin/bots/${pid}/m365`, "Hal", [["graph", "files.write"]])).status).toBe(403);
      expect((await getDefinition(db, T, pid))!.graph).toEqual(["mail.read", "calendar.read"]);
      expect((await get(`/admin/bots/${pid}`, "Hal")).status).toBe(403);
      expect((await post(`/admin/bots/${pid}`, "Hal", [["persona", "By head."]])).status).toBe(403);
      expect((await getDefinition(db, T, pid))!.persona).not.toBe("By head.");
      expect(await (await get("/admin/bots", "Hal")).text()).not.toContain(`/admin/bots/${pid}`);
    });

    it("the overview has no departments or computer, and the save refuses departments and keeps computer off", async () => {
      const page = await (await get(`/admin/bots/${pid}`, "Ann")).text();
      expect(page).not.toContain('name="departments"');
      expect(page).not.toContain('name="computer"');
      const fields: [string, string][] = [["label", "My assistant"], ["model", "m"], ["persona", "p"], ["computer", "on"]];
      const refused = await post(`/admin/bots/${pid}`, "Ann", [...fields, ["departments", sales]]);
      expect(refused.status).toBe(400);
      expect((await getDefinition(db, T, pid))!.persona).not.toBe("p");
      expect((await post(`/admin/bots/${pid}`, "Ann", fields)).status).toBe(303);
      const after = (await getDefinition(db, T, pid))!;
      expect([after.persona, after.computer]).toEqual(["p", false]);
    });

    it("refuses servers and connection links", async () => {
      expect((await post(`/admin/bots/${pid}/servers`, "Ann", [["name", "x"], ["transport", "stdio"], ["command", "c"]])).status).toBe(400);
      expect((await getDefinition(db, T, pid))!.mcpServers).toEqual([]);
      const cid = crypto.randomUUID();
      await db.insert(connections).values({ id: cid, tenantId: T, name: "personal-link", kind: "ssh", target: "host.example.test", config: { port: 22, username: "ops" }, mode: "read-only", status: "active" });
      expect((await post(`/admin/bots/${pid}/connections/${cid}/link`, "Ann", [["linked", "on"]])).status).toBe(400);
      expect(await listConnectionsFor(db, T, pid)).toEqual([]);
    });

    it("the assistants page and the overview show it once, with its owner", async () => {
      const assistants = await (await get("/admin/assistants", "Ann")).text();
      expect(assistants.match(/class="bot-name">My assistant</g) ?? []).toHaveLength(1);
      expect(assistants).toContain("for Mo");
      const overview = await (await get("/admin", "Ann")).text();
      expect(overview.match(/Personal assistants/g)).toHaveLength(1);
    });
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
    expect((await post(`/admin/bots/${d.id}/servers/tickets/delete`, "Ann", [["confirm", "yes"]])).status).toBe(303);
    expect((await getDefinition(db, T, d.id))!.mcpServers).toEqual([]);
    await setAllowedDepartments(db, T, d.id, []);
  });

  describe("connections and routines", () => {
    const conn = async (name: string, over: Partial<typeof connections.$inferInsert> = {}) => {
      const cid = crypto.randomUUID();
      await db.insert(connections).values({ id: cid, tenantId: T, name, kind: "ssh", target: "host.example.test", config: { port: 22, username: "ops" }, mode: "read-only", status: "active", secretCipher: "CIPHER-SECRET", publicKey: `ssh-ed25519 AAAAPUB ${name}`, ...over });
      return cid;
    };
    it("admin links and unlinks a connection for a bot", async () => {
      const d = await def("helper");
      const c = await conn("lnk");
      await post(`/admin/bots/${d.id}/connections/${c}/link`, "Ann", [["linked", "on"]]);
      expect((await listConnectionsFor(db, T, d.id)).map((x) => x.id)).toContain(c);
      const page = await (await get(`/admin/bots/${d.id}?tab=connections`, "Ann")).text();
      expect(page).toContain("lnk");
      expect(page).not.toContain("CIPHER-SECRET");
      expect(page).toContain("Connections this bot uses");
      const all = await (await get(`/admin/connections`, "Ann")).text();
      expect(all).toMatch(/lnk<\/span><\/td>[\s\S]*?Helper/); // the Connections screen names the bot that uses it
      expect((await get(`/admin/connections`, "Hal")).status).toBe(403);
      await post(`/admin/bots/${d.id}/connections/${c}/link`, "Ann", [["linked", "off"]]);
      expect((await listConnectionsFor(db, T, d.id)).map((x) => x.id)).not.toContain(c);
    });
    it("offers a search box and only the fields the chosen kind needs", async () => {
      const page = await (await get("/admin/connections", "Ann")).text();
      expect(page).toContain('class="search-form"');
      expect(page).toContain('name="q"');
      expect(page).toContain("data-connection-kind");
      expect(page).toContain('data-kind="ssh sql"');
      expect(page).toContain('data-kind="sql http mcp"');
      expect(page).toContain('data-kind="http mcp"');
    });

    it("searches connections by name, target and the bot that uses them", async () => {
      const d = await upsertDefinition(db, Buffer.alloc(32), T, { name: "search-helper", label: "Search Helper", persona: "p" });
      const c = await conn("search-me");
      await conn("other", { kind: "http", target: "https://api.example.test", config: {}, mode: "change" });
      await post(`/admin/bots/${d.id}/connections/${c}/link`, "Ann", [["linked", "on"]]);
      const byName = await (await get("/admin/connections?q=search-me", "Ann")).text();
      expect(byName).toContain("search-me");
      expect(byName).not.toContain(">other<");
      const byTarget = await (await get("/admin/connections?q=api.example", "Ann")).text();
      expect(byTarget).toContain(">other<");
      const byBot = await (await get("/admin/connections?q=Search", "Ann")).text();
      expect(byBot).toContain("search-me");
      const none = await (await get("/admin/connections?q=zzzz", "Ann")).text();
      expect(none).toContain("No connections match");
      expect((await get("/admin/connections?q=search-me", "Hal")).status).toBe(403);
    });

    it("searches the connections on a bot's Connections tab", async () => {
      const d = await upsertDefinition(db, Buffer.alloc(32), T, { name: "conn-search-bot", label: "Connections Search", persona: "p" });
      const a = await conn("conn-search-alpha");
      await conn("conn-search-beta", { kind: "http", target: "https://beta.example.test", config: {} });
      await post(`/admin/bots/${d.id}/connections/${a}/link`, "Ann", [["linked", "on"]]);
      const hits = await (await get(`/admin/bots/${d.id}?tab=connections&q=beta`, "Ann")).text();
      expect(hits).toContain("conn-search-beta");
      expect(hits).not.toContain(">conn-search-alpha<");
      expect(hits).toContain('name="q"');
      const none = await (await get(`/admin/bots/${d.id}?tab=connections&q=zzzz`, "Ann")).text();
      expect(none).toContain("No connections match");
    });

    it("lets an admin change a connection's own mode and caps old write grants", async () => {
      const d = await def("helper");
      const c = await conn("mode-switch");
      await post(`/admin/bots/${d.id}/connections/${c}/link`, "Ann", [["linked", "on"]]);
      expect((await post(`/admin/connections/${c}/mode`, "Ann", [["mode", "change"]])).status).toBe(303);
      expect((await db.select().from(connections).where(eq(connections.id, c)))[0].mode).toBe("change");
      expect(await (await get(`/admin/bots/${d.id}?tab=connections`, "Ann")).text()).toContain("change: ask");
      expect((await post(`/admin/bots/${d.id}/connections/${c}/permission`, "Ann", [["mode", "free"]])).status).toBe(303);
      expect(await getConnectionGrant(db, d.id, c)).toBe("free");
      expect((await post(`/admin/connections/${c}/mode`, "Ann", [["mode", "read-only"]])).status).toBe(303);
      expect((await db.select().from(connections).where(eq(connections.id, c)))[0].mode).toBe("read-only");
      expect(await getConnectionGrant(db, d.id, c)).toBe("read");
      expect(await (await get(`/admin/bots/${d.id}?tab=connections`, "Ann")).text()).toContain("read only");
      expect((await post(`/admin/connections/${c}/mode`, "Hal", [["mode", "change"]])).status).toBe(403);
    });

    it("changes a connection's mode from the bot's Connections tab", async () => {
      const d = await def("helper");
      const c = await conn("bot-mode");
      await post(`/admin/bots/${d.id}/connections/${c}/link`, "Ann", [["linked", "on"]]);
      const res = await post(`/admin/bots/${d.id}/connections/${c}/mode`, "Ann", [["mode", "change"], ["tab", "connections"]]);
      expect([res.status, res.headers.get("location")]).toEqual([303, `/admin/bots/${d.id}?tab=connections`]);
      expect((await db.select().from(connections).where(eq(connections.id, c)))[0].mode).toBe("change");
      expect(await (await get(`/admin/bots/${d.id}?tab=connections`, "Ann")).text()).toContain(`/admin/bots/${d.id}/connections/${c}/mode`);
      expect((await post(`/admin/bots/${d.id}/connections/${c}/mode`, "Hal", [["mode", "read-only"]])).status).toBe(403);
    });

    it("unblocks a blocked connection by pinning the current host key", async () => {
      const c = await conn("unblock-me", { status: "blocked", mode: "read-only", secretCipher: encrypt(secretsKey, "key"), hostKey: "ssh-ed25519 OLD" });
      const res = await post(`/admin/connections/${c}/unblock`, "Ann", []);
      expect([res.status, res.headers.get("location")]).toEqual([303, "/admin/connections?unblocked=1"]);
      const [row] = await db.select().from(connections).where(eq(connections.id, c));
      expect(row.status).toBe("active");
      expect(row.hostKey).toBe("ssh-ed25519 AAAAfake");
    });

    it("offers write: no confirmation on an MCP connection", async () => {
      const d = await def("helper");
      const c = await conn("mcp-free", { kind: "mcp", target: "https://mcp.example.test/mcp", config: { headerName: "Authorization", readOnlyTools: [] }, mode: "change" });
      await post(`/admin/bots/${d.id}/connections/${c}/link`, "Ann", [["linked", "on"]]);
      expect(await (await get(`/admin/bots/${d.id}?tab=connections`, "Ann")).text()).toContain("write: no confirmation");
      expect((await post(`/admin/bots/${d.id}/connections/${c}/permission`, "Ann", [["mode", "free"]])).status).toBe(303);
      expect(await getConnectionGrant(db, d.id, c)).toBe("free");
    });

    it("sets a per-bot permission for one connection", async () => {
      const d = await def("helper");
      const c = await conn("granted", { mode: "change" });
      await post(`/admin/bots/${d.id}/connections/${c}/link`, "Ann", [["linked", "on"]]);
      const page = await (await get(`/admin/bots/${d.id}?tab=connections`, "Ann")).text();
      expect(page).toContain("This bot");
      expect(page).toContain("change: ask");
      expect((await post(`/admin/bots/${d.id}/connections/${c}/permission`, "Ann", [["mode", "free"]])).status).toBe(303);
      expect(await getConnectionGrant(db, d.id, c)).toBe("free");
      expect(await (await get(`/admin/bots/${d.id}?tab=connections`, "Ann")).text()).toContain("write: no confirmation");
      expect((await post(`/admin/bots/${d.id}/connections/${c}/permission`, "Ann", [["mode", "nonsense"]])).status).toBe(400);
    });

    it("revoke shows the public key and the connection can no longer run", async () => {
      const c = await conn("rev");
      const armed = await post(`/admin/connections/${c}/revoke`, "Ann", []);
      expect(await armed.text()).toContain("confirm revoke?");
      expect((await db.select().from(connections).where(eq(connections.id, c)))[0].status).toBe("active"); // the first press changes nothing
      const res = await post(`/admin/connections/${c}/revoke`, "Ann", [["confirm", "yes"]]);
      const text = await res.text();
      expect(text).toContain("ssh-ed25519 AAAAPUB rev");
      const [row] = await db.select().from(connections).where(eq(connections.id, c));
      expect([row.status, row.secretCipher]).toEqual(["revoked", null]);
      const h = await conn("revhttp", { kind: "http", target: "https://x.example.test", config: {}, publicKey: null });
      expect(await (await post(`/admin/connections/${h}/revoke`, "Ann", [["confirm", "yes"]])).text()).toContain("Revoke the token at its source");
    });
    it("offers unblock for a blocked connection and the reset route clears the pin", async () => {
      const c = await conn("blk", { status: "blocked", hostKey: "k" });
      expect(await (await get("/admin/connections", "Ann")).text()).toContain(`/admin/connections/${c}/unblock`);
      const r = await post(`/admin/connections/${c}/reset-host-key`, "Ann", []);
      expect([r.status, r.headers.get("location")]).toEqual([303, "/admin/connections"]);
      const [row] = await db.select().from(connections).where(eq(connections.id, c));
      expect([row.status, row.hostKey]).toEqual(["pending", null]);
    });
    it("admin creates a routine with a grant held by that admin; a bad cron is refused with 400", async () => {
      const d = await def("helper");
      const chatId = "chat-r1";
      await db.insert(chats).values({ id: chatId, tenantId: T, conversationType: "personal", label: "Ops room" } as typeof chats.$inferInsert);
      await db.insert(chatAssignments).values({ chatId, definitionId: d.id } as typeof chatAssignments.$inferInsert);
      expect(await (await get(`/admin/bots/${d.id}?tab=chats`, "Ann")).text()).toContain("Ops room");
      const res = await post(`/admin/bots/${d.id}/routines`, "Ann", [["chatId", chatId], ["prompt", "Check disk"], ["schedule", "0 9 * * 1-5"], ["grant", "on"]]);
      expect(res.status).toBe(303);
      const [r] = await listRoutines(db, T, d.id);
      expect([r.schedule, r.grantPersonId]).toEqual(["0 9 * * 1-5", id.Ann]);
      expect((await post(`/admin/bots/${d.id}/routines`, "Ann", [["chatId", chatId], ["prompt", "x"], ["schedule", "bogus"]])).status).toBe(400);
      await post(`/admin/bots/${d.id}/routines/${r.id}/enabled`, "Ann", [["enabled", "off"]]);
      expect((await listRoutines(db, T, d.id))[0].enabled).toBe(false);
      const armed = await post(`/admin/bots/${d.id}/routines/${r.id}/delete`, "Ann", []);
      expect(await armed.text()).toContain("confirm delete?");
      expect(await listRoutines(db, T, d.id)).toHaveLength(1); // the first press changes nothing
      await post(`/admin/bots/${d.id}/routines/${r.id}/delete`, "Ann", [["confirm", "yes"]]);
      expect(await listRoutines(db, T, d.id)).toHaveLength(0);
    });
    it("the learnings tab lists who taught what and where, and an admin adds, rewords and deletes", async () => {
      const d = await def("helper");
      const chatId = "chat-l1";
      await db.insert(chats).values({ id: chatId, tenantId: T, conversationType: "personal", label: "Sales room" } as typeof chats.$inferInsert);
      await db.insert(chatAssignments).values({ chatId, definitionId: d.id } as typeof chatAssignments.$inferInsert);
      const l = await addLearning(db, T, { definitionId: d.id, text: "Call scheduled runs reminders", taughtByPersonId: id.Hal, chatId });
      const page = await (await get(`/admin/bots/${d.id}?tab=learnings`, "Ann")).text();
      expect(page).toMatch(/Call scheduled runs reminders<\/textarea>[\s\S]*?Hal<\/td><td>Sales room<\/td><td>everyone/);
      expect((await post(`/admin/bots/${d.id}/learnings`, "Hal", [["text", "x"]])).status).toBe(403);
      await post(`/admin/bots/${d.id}/learnings`, "Ann", [["text", "Sign off with Cheers"]]);
      await post(`/admin/bots/${d.id}/learnings/${l.id}`, "Ann", [["text", "Say reminders"]]);
      expect((await listLearnings(db, T, d.id)).map((x) => x.text)).toEqual(["Say reminders", "Sign off with Cheers"]);
      const other = await def("other");
      expect((await post(`/admin/bots/${other.id}/learnings/${l.id}`, "Ann", [["text", "hijack"]])).status).toBe(400); // another bot's id
      expect(await (await post(`/admin/bots/${d.id}/learnings/${l.id}/delete`, "Ann", [])).text()).toContain("confirm delete?");
      expect(await listLearnings(db, T, d.id)).toHaveLength(2);
      await post(`/admin/bots/${d.id}/learnings/${l.id}/delete`, "Ann", [["confirm", "yes"]]);
      expect((await listLearnings(db, T, d.id)).map((x) => x.text)).toEqual(["Sign off with Cheers"]);
    });
    it("the learnings tab shows reflection proposals and an admin approves or rejects them", async () => {
      const d = await def("helper");
      const add = await createProposal(db, { tenantId: T, definitionId: d.id, action: "add", text: "Check the SBC before the trunk" });
      const page = await (await get(`/admin/bots/${d.id}?tab=learnings`, "Ann")).text();
      expect(page).toContain("Proposed by the daily reflection");
      expect(page).toContain("Check the SBC before the trunk");
      expect((await post(`/admin/bots/${d.id}/proposals/${add.id}/approve`, "Hal", [])).status).toBe(403);
      await post(`/admin/bots/${d.id}/proposals/${add.id}/approve`, "Ann", []);
      expect((await listLearnings(db, T, d.id)).map((l) => l.text)).toContain("Check the SBC before the trunk");
      expect((await listProposals(db, T, d.id, "pending")).length).toBe(0);
      const reject = await createProposal(db, { tenantId: T, definitionId: d.id, action: "add", text: "Never do this" });
      await post(`/admin/bots/${d.id}/proposals/${reject.id}/reject`, "Ann", []);
      expect((await listLearnings(db, T, d.id)).map((l) => l.text)).not.toContain("Never do this");
      expect((await listProposals(db, T, d.id, "rejected")).map((p) => p.id)).toContain(reject.id);
    });
    it("the memory tab lists, adds, rewrites and deletes long-term memory", async () => {
      const d = await def("helper");
      const page = await (await get(`/admin/bots/${d.id}?tab=memory`, "Ann")).text();
      expect(page).toContain("Long-term memory");
      expect((await post(`/admin/bots/${d.id}/memory`, "Hal", [["text", "x"]])).status).toBe(403);
      await post(`/admin/bots/${d.id}/memory`, "Ann", [["text", "BE Voice: check the SIP trunk first"], ["kind", "procedure"], ["importance", "5"]]);
      const [m] = await listAllMemory(db, T, d.id);
      expect(m).toMatchObject({ text: "BE Voice: check the SIP trunk first", kind: "procedure", importance: 5 });
      await post(`/admin/bots/${d.id}/memory/${m.id}`, "Ann", [["text", "Check the SIP trunk first, then the SBC"]]);
      expect((await listAllMemory(db, T, d.id))[0].text).toBe("Check the SIP trunk first, then the SBC");
      expect(await (await post(`/admin/bots/${d.id}/memory/${m.id}/delete`, "Ann", [])).text()).toContain("confirm delete?");
      expect(await listAllMemory(db, T, d.id)).toHaveLength(1);
      await post(`/admin/bots/${d.id}/memory/${m.id}/delete`, "Ann", [["confirm", "yes"]]);
      expect(await listAllMemory(db, T, d.id)).toHaveLength(0);
    });
    it("the reflections tab shows the daily summaries and saves the per-bot setting", async () => {
      const d = await def("helper");
      const group = "chat-reflect";
      await db.insert(chats).values({ id: group, tenantId: T, conversationType: "groupChat", label: "IT room" } as typeof chats.$inferInsert);
      await db.insert(chatAssignments).values({ chatId: group, definitionId: d.id } as typeof chatAssignments.$inferInsert);
      await saveReflection(db, { tenantId: T, definitionId: d.id, day: "2026-11-07", summary: "A quiet day with one Voice issue.", wentWrong: "Restarted the SBC.", willDo: "Check the trunk first.", model: "deepseek/deepseek-flash", costUsd: 0.001 });
      const page = await (await get(`/admin/bots/${d.id}?tab=reflections`, "Ann")).text();
      expect(page).toContain("Daily reflection");
      expect(page).toContain("A quiet day with one Voice issue.");
      expect(page).toContain("Restarted the SBC.");
      expect(page).toContain("Check the trunk first.");
      expect(page).toContain('name="reflectionMode"');
      // auto mode needs a group
      expect((await post(`/admin/bots/${d.id}/reflection`, "Ann", [["reflectionMode", "auto"], ["reflectionHour", "7"]])).status).toBe(400);
      // the group must be one of this bot's chats
      expect((await post(`/admin/bots/${d.id}/reflection`, "Ann", [["reflectionMode", "auto"], ["reflectionChatId", "nope"], ["reflectionHour", "7"]])).status).toBe(400);
      expect((await post(`/admin/bots/${d.id}/reflection`, "Ann", [["reflectionMode", "auto"], ["reflectionChatId", group], ["reflectionHour", "7"]])).status).toBe(303);
      let saved = await getDefinition(db, T, d.id);
      expect(saved?.reflectionMode).toBe("auto");
      expect(saved?.reflectionChatId).toBe(group);
      expect(saved?.reflectionHour).toBe(7);
      expect((await post(`/admin/bots/${d.id}/reflection`, "Hal", [["reflectionMode", "off"], ["reflectionHour", "7"]])).status).toBe(403);
    });
    it("lists what is waiting or repeating, and folds one-offs that already ran away", async () => {
      const d = await def("helper");
      const chatId = "chat-r2";
      await db.insert(chats).values({ id: chatId, tenantId: T, conversationType: "personal", label: "Mine" } as typeof chats.$inferInsert);
      await db.insert(chatAssignments).values({ chatId, definitionId: d.id } as typeof chatAssignments.$inferInsert);
      const soon = new Date(Date.now() + 3600_000);
      await createRoutine(db, T, { definitionId: d.id, chatId, prompt: "Waiting reminder", runAt: soon, createdByPersonId: id.Ann });
      const done = await createRoutine(db, T, { definitionId: d.id, chatId, prompt: "Finished flight search", runAt: soon, createdByPersonId: id.Ann, background: true });
      await db.update(routines).set({ lastRunAt: new Date(), enabled: false }).where(eq(routines.id, done.id));
      const page = await (await get(`/admin/bots/${d.id}?tab=routines`, "Ann")).text();
      const [live, folded] = page.split("already ran (1)");
      expect(live).toContain("Waiting reminder");
      expect(live).not.toContain("Finished flight search");
      expect(folded).toMatch(/Finished flight search<\/td><td>background job/);
    });
    it("a foreign-tenant or unknown connection id gives 400 and changes nothing", async () => {
      await upsertTenant(db, { id: "other" });
      const c = await conn("foreign", { tenantId: "other" });
      const d = await def("helper");
      for (const p of [`/admin/connections/${c}/revoke`, `/admin/connections/${c}/reset-host-key`, `/admin/connections/nope/revoke`, `/admin/bots/${d.id}/connections/${c}/link`]) {
        expect((await post(p, "Ann", [["linked", "on"], ["confirm", "yes"]])).status).toBe(400);
      }
      const [row] = await db.select().from(connections).where(eq(connections.id, c));
      expect([row.status, row.secretCipher]).toEqual(["active", "CIPHER-SECRET"]);
    });
    it("head gets 403 on every connection and routine post, and sees neither section", async () => {
      const d = await def("helper");
      const c = await conn("hd");
      for (const p of [`/admin/bots/${d.id}/connections/${c}/link`, `/admin/connections/${c}/revoke`, `/admin/connections/${c}/reset-host-key`, `/admin/bots/${d.id}/routines`, `/admin/bots/${d.id}/routines/x/enabled`, `/admin/bots/${d.id}/routines/x/delete`]) {
        expect((await post(p, "Hal", [])).status).toBe(403);
      }
      const page = await (await get(`/admin/bots/${d.id}`, "Hal")).text();
      expect(page).not.toContain("Connections");
      expect(page).not.toContain("Routines");
    });
    it("no admin page contains BEGIN OPENSSH", async () => {
      const d = await def("helper");
      await conn("pk", { secretCipher: "-----BEGIN OPENSSH PRIVATE KEY-----" });
      const c = await conn("pk2", { secretCipher: "-----BEGIN OPENSSH PRIVATE KEY-----" });
      expect(await (await post(`/admin/connections/${c}/revoke`, "Ann", [["confirm", "yes"]])).text()).not.toContain("BEGIN OPENSSH");
      for (const p of ["/admin/bots", `/admin/bots/${d.id}`, "/admin/settings"]) expect(await (await get(p, "Ann")).text()).not.toContain("BEGIN OPENSSH");
    });
  });
  it("shows whose personal assistant a bot is, and lets an admin give it an owner", async () => {
    await setPersonalBot(db, T, id.Mo, true);
    const pa = await ensurePersonalAssistant(db, T, id.Mo, "m-default");
    const page = await (await get(`/admin/bots/${pa.id}`, "Ann")).text();
    expect(page).toContain(`for Mo · `);
    expect(page).toContain("Owner");
    expect(page).toContain('name="ownerPersonId"');
    const res = await post(`/admin/bots/${pa.id}`, "Ann", [["label", "My assistant"], ["persona", "p"], ["model", "m-default"], ["ownerPersonId", id.Eve]]);
    expect(res.status).toBe(303);
    expect((await listDefinitions(db, T)).find((d) => d.id === pa.id)?.ownerPersonId).toBe(id.Eve);
    const [eve] = await db.select().from(people).where(eq(people.id, id.Eve));
    expect(eve.personalBot).toBe(true);
  });

  it("gives a bot one inbound URL, pointed at one of its chats, and turns it off again", async () => {
    const d = await upsertDefinition(db, secretsKey, T, { name: "hooked", label: "Hooked", persona: "p" });
    await db.insert(chats).values({ id: "chat-hook", tenantId: T, conversationType: "groupChat", label: "Ops room" } as typeof chats.$inferInsert);
    await db.insert(chatAssignments).values({ chatId: "chat-hook", definitionId: d.id } as typeof chatAssignments.$inferInsert);
    await db.insert(chats).values({ id: "chat-elsewhere", tenantId: T, conversationType: "groupChat", label: "Elsewhere" } as typeof chats.$inferInsert);
    expect(await (await get(`/admin/bots/${d.id}`, "Ann")).text()).toContain("Inbound webhook");
    expect((await post(`/admin/bots/${d.id}/hook`, "Ann", [["chat", "chat-elsewhere"]])).status).toBeGreaterThanOrEqual(400);
    expect((await post(`/admin/bots/${d.id}/hook`, "Ann", [["chat", "chat-hook"]])).status).toBe(303);
    const [row] = await db.select().from(botDefinitions).where(eq(botDefinitions.id, d.id));
    expect([row.inboundChatId, row.inboundBy, !!row.inboundSecret]).toEqual(["chat-hook", id.Ann, true]);
    const page = await (await get(`/admin/bots/${d.id}`, "Ann")).text();
    expect(page).toContain(`https://bot.example.test/hooks/${d.id}/`);
    expect(page).toContain("Ops room");
    await post(`/admin/bots/${d.id}/hook/off`, "Ann", []);
    const [off] = await db.select().from(botDefinitions).where(eq(botDefinitions.id, d.id));
    expect([off.inboundSecret, off.inboundChatId, off.inboundBy]).toEqual([null, null, null]);
  });

});

describe("bot names and email addresses", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  const id: Record<string, string> = {};
  const calls: string[] = [];
  const taken = new Set(["busy"]);
  let n = 0;
  // BE AgentMail stand-in; the secrets it hands out are fake
  const admin = {
    mailDomain: async () => "mail.test",
    inboxTaken: async (l: string) => taken.has(l),
    findInbox: async (l: string) => (taken.has(l) ? { id: "x", address: `${l}@mail.test`, ownerAgent: "other" } : undefined),
    createInbox: async (l: string) => ({ id: `inbox-${++n}`, address: `${l}@mail.test` }),
    setInboxActive: async (i: string, on: boolean) => void calls.push(`active ${i} ${on}`),
    setDisplayName: async () => undefined,
    listKeys: async () => [],
    listWebhooks: async () => [],
    issueKey: async () => ({ id: `key-${++n}`, key: "bam_fake" }),
    revokeKey: async (k: string) => void calls.push(`revoke ${k}`),
    addWebhook: async () => ({ id: `hook-${++n}`, secret: "amwh_fake" }),
    removeWebhook: async (h: string) => void calls.push(`unhook ${h}`),
    checkSendAs: async (a: string) => (calls.push(`check ${a}`), a.endsWith("@bad.test") ? { ok: false, reasons: ["spf: not set up"] } : { ok: true, reasons: [] }),
    requestSendAs: async (i: string, a: string) => (calls.push(`send-as ${i} ${a}`), {}),
    getSendAs: async () => ({ status: "pending forward", key: "bam_leak" }),
    removeSendAs: async (i: string) => void calls.push(`clear ${i}`),
  };

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: T });
    await upsertTenant(db, { id: "tenant-2" });
    for (const name of ["Ann", "Hal"]) id[name] = (await upsertPerson(db, { tenantId: T, aadObjectId: `aad-${name}`, name })).id;
    id.Zed = (await upsertPerson(db, { tenantId: "tenant-2", aadObjectId: "aad-Zed", name: "Zed" })).id;
    await setRole(db, T, id.Ann, "admin");
    await setRole(db, "tenant-2", id.Zed, "admin");
    const sales = (await createDepartment(db, T, "Sales")).id;
    await setMembership(db, T, sales, id.Hal, "head");
    const mail = { db, secretsKey, admin: admin as unknown as MailDeps["admin"], publicUrl: "https://bot.example.test" };
    const app = express();
    app.use("/admin", adminRouter({ db, config, exchangeCode: async () => ({ id_token: "x" }), verifyIdToken: async () => ({ oid: "", tid: "", name: "", email: "" }), botName: "Bot", defaultModel: "m", fetchUsers: async () => [], mail }));
    ({ url, close } = await serve(app));
  });
  afterAll(() => close());

  const get = (path: string, who: string) => fetch(url + path, { redirect: "manual", headers: { cookie: sessionCookie(secretsKey, id[who] === id.Zed ? "tenant-2" : T, id[who]) } });
  const post = (path: string, who: string, body: [string, string][]) =>
    fetch(url + path, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie(secretsKey, id[who] === id.Zed ? "tenant-2" : T, id[who]) },
      body: new URLSearchParams([["csrf", "csrf-1"], ...body]).toString(),
    });
  const box = async (definitionId: string) => (await db.select().from(mailboxes).where(eq(mailboxes.definitionId, definitionId)))[0];
  const create = async (name: string, extra: [string, string][] = []) => {
    const res = await post("/admin/bots", "Ann", [["name", name], ["displayName", "Iris"], ["label", name], ["persona", "p"], ...extra]);
    return { res, def: (await listDefinitions(db, T)).find((d) => d.name === name)! };
  };

  it("the name saves, shows, and a blank address creates no mailbox", async () => {
    const { res, def } = await create("plain");
    expect(res.status).toBe(303);
    expect(def.displayName).toBe("Iris");
    expect(await box(def.id)).toBeUndefined();
    expect(await (await get("/admin/bots", "Ann")).text()).toContain('name="localPart"');
    await post(`/admin/bots/${def.id}`, "Ann", [["displayName", "Ines"], ["label", "plain"], ["model", "m"], ["persona", "p"]]);
    expect((await getDefinition(db, T, def.id))!.displayName).toBe("Ines");
    const page = await (await get(`/admin/bots/${def.id}?tab=email`, "Ann")).text();
    expect(page).toContain("create email address");
    expect(await (await get(`/admin/bots/${def.id}`, "Ann")).text()).toContain('value="Ines"');
  });

  it("a typed address creates the mailbox and the page shows it without any key", async () => {
    const { res, def } = await create("withmail", [["localPart", "Iris"]]);
    expect(res.status).toBe(303);
    expect((await box(def.id))?.address).toBe("iris@mail.test");
    const page = await (await get(`/admin/bots/${def.id}?tab=email`, "Ann")).text();
    expect(page).toContain("iris@mail.test");
    expect(page).toContain("remove email address");
    for (const secret of ["bam_", "amwh_"]) expect(page).not.toContain(secret);
  });

  it("a taken address says so, the bot stays saved and no mailbox exists", async () => {
    const { res, def } = await create("clash", [["localPart", "busy"]]);
    expect(await res.text()).toContain("That address is taken");
    expect(def).toBeTruthy();
    expect(await box(def.id)).toBeUndefined();
    const page = await post(`/admin/bots/${def.id}/mailbox`, "Ann", [["localPart", "busy"]]);
    expect(page.status).toBe(400);
    expect(await page.text()).toContain("That address is taken");
  });

  it("Personal gets no mailbox", async () => {
    const pid = (await ensurePersonalDefinition(db, T, "m")).id;
    expect((await post(`/admin/bots/${pid}/mailbox`, "Ann", [["localPart", "mine"]])).status).toBe(400);
    expect(await box(pid)).toBeUndefined();
  });

  it("remove and restore call the mailbox functions; removed offers restore", async () => {
    const def = (await listDefinitions(db, T)).find((d) => d.name === "withmail")!;
    expect((await post(`/admin/bots/${def.id}/mailbox/remove`, "Ann", [["confirm", "yes"]])).status).toBe(303);
    expect((await box(def.id))?.status).toBe("removed");
    expect(await (await get(`/admin/bots/${def.id}?tab=email`, "Ann")).text()).toContain("restore email address");
    expect((await post(`/admin/bots/${def.id}/mailbox/restore`, "Ann", [])).status).toBe(303);
    expect((await box(def.id))?.status).toBe("active");
  });

  it("a refused address shows the reason and leaves no mailbox", async () => {
    const real = admin.createInbox;
    admin.createInbox = async () => { throw new MailError("bad", 422, "reserved name"); };
    const { res, def } = await create("refused", [["localPart", "admin"]]);
    admin.createInbox = real;
    expect(await res.text()).toContain("reserved name");
    expect(await box(def.id)).toBeUndefined();
  });

  it("a pending mailbox offers Try again and a removing one Finish removing", async () => {
    const { def } = await create("stuck");
    await db.insert(mailboxes).values({ definitionId: def.id, tenantId: T, agent: "bb2-stuck", localPart: "stuck", status: "pending" });
    expect(await (await get(`/admin/bots/${def.id}?tab=email`, "Ann")).text()).toContain("try again");
    expect((await post(`/admin/bots/${def.id}/mailbox/retry`, "Ann", [])).status).toBe(303);
    expect((await box(def.id))?.status).toBe("active");
    await db.update(mailboxes).set({ status: "removing" }).where(eq(mailboxes.definitionId, def.id));
    expect(await (await get(`/admin/bots/${def.id}?tab=email`, "Ann")).text()).toContain("finish removing");
    expect((await post(`/admin/bots/${def.id}/mailbox/remove`, "Ann", [["confirm", "yes"]])).status).toBe(303);
    expect((await box(def.id))?.status).toBe("removed");
    expect((await post(`/admin/bots/${def.id}/mailbox/retry`, "Hal", [])).status).toBe(403);
  });

  it("the company address is checked, requested, shown without secrets, and cleared", async () => {
    const def = (await listDefinitions(db, T)).find((d) => d.name === "withmail")!;
    expect((await post(`/admin/bots/${def.id}/send-as`, "Ann", [["address", "iris@company.test"]])).status).toBe(303);
    expect(calls).toContain("check iris@company.test");
    expect(calls.some((c) => c.startsWith("send-as ") && c.endsWith(" iris@company.test"))).toBe(true);
    const page = await (await get(`/admin/bots/${def.id}?tab=email`, "Ann")).text();
    expect(page).toContain("pending forward");
    expect(page).toContain("automatic forwarding");
    expect(page).not.toContain("bam_");
    expect((await post(`/admin/bots/${def.id}/send-as/remove`, "Ann", [["confirm", "yes"]])).status).toBe(303);
    expect(calls.some((c) => c.startsWith("clear "))).toBe(true);
  });

  it("a negative send-as verdict stops before the request and shows the reason", async () => {
    const def = (await listDefinitions(db, T)).find((d) => d.name === "withmail")!;
    const before = calls.length;
    const res = await post(`/admin/bots/${def.id}/send-as`, "Ann", [["address", "iris@bad.test"]]);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("spf: not set up");
    expect(calls.slice(before)).toEqual(["check iris@bad.test"]);
  });

  it("an invalid local part is shown and creates nothing; a post without CSRF is refused", async () => {
    const { def } = await create("badlocal");
    const res = await post(`/admin/bots/${def.id}/mailbox`, "Ann", [["localPart", "no spaces!"]]);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("letters, digits");
    expect(await box(def.id)).toBeUndefined();
    const noCsrf = await fetch(`${url}/admin/bots/${def.id}/mailbox`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie(secretsKey, T, id.Ann) },
      body: new URLSearchParams([["localPart", "fine"]]).toString(),
    });
    expect(noCsrf.status).toBe(403);
    expect(await box(def.id)).toBeUndefined();
  });

  it("every action leaves an admin audit row, shown on the Activity page", async () => {
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.kind, "admin"));
    expect(rows.length).toBeGreaterThan(4);
    expect(rows.every((r) => r.chatId === null && r.personId === id.Ann)).toBe(true);
    expect(rows.some((r) => r.toolName === "send-as" && r.status === "failed")).toBe(true);
    expect(rows.some((r) => r.toolName === "mailbox/remove" && r.status === "done")).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/bam_|amwh_/);
    const res = await get("/admin/activity", "Ann");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Admin: mailbox/remove");
  });

  it("heads and another tenant's admin are refused", async () => {
    const def = (await listDefinitions(db, T)).find((d) => d.name === "withmail")!;
    for (const path of ["mailbox", "mailbox/remove", "mailbox/restore", "send-as", "send-as/remove"]) {
      expect((await post(`/admin/bots/${def.id}/${path}`, "Hal", [["localPart", "x"], ["address", "a@b.test"]])).status).toBe(403);
      expect((await post(`/admin/bots/${def.id}/${path}`, "Zed", [["localPart", "x"], ["address", "a@b.test"]])).status).toBe(400);
    }
    expect((await box(def.id))?.status).toBe("active");
  });
});

describe("action rules", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  const id: Record<string, string> = {};
  let botId: string;

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: T });
    await upsertTenant(db, { id: "tenant-2" });
    for (const name of ["Ann", "Hal"]) id[name] = (await upsertPerson(db, { tenantId: T, aadObjectId: `aad-${name}`, name })).id;
    id.Zed = (await upsertPerson(db, { tenantId: "tenant-2", aadObjectId: "aad-Zed", name: "Zed" })).id;
    await setRole(db, T, id.Ann, "admin");
    await setRole(db, "tenant-2", id.Zed, "admin");
    const sales = (await createDepartment(db, T, "Sales")).id;
    await setMembership(db, T, sales, id.Hal, "head");
    const app = express();
    app.use("/admin", adminRouter({ db, config, exchangeCode: async () => ({ id_token: "x" }), verifyIdToken: async () => ({ oid: "", tid: "", name: "", email: "" }), botName: "Bot", defaultModel: "m", fetchUsers: async () => [] }));
    ({ url, close } = await serve(app));
    const def = await upsertDefinition(db, secretsKey, T, { name: "ops", label: "Ops", persona: "p", mcpServers: [{ name: "tickets", transport: "http", url: "https://mcp.example.test/", readOnlyTools: ["list_tickets"] }] });
    botId = def.id;
    await setAllowedDepartments(db, T, botId, [sales]);
    await recordTools(db, botId, ["WebSearch", "mcp__mail__send_email", "mcp__connections__approve", "mcp__tickets__list_tickets", "mcp__tickets__close_ticket"]);
  });
  afterAll(() => close());

  const cookie = (who: string) => sessionCookie(secretsKey, who === "Zed" ? "tenant-2" : T, id[who]);
  const get = (path: string, who: string) => fetch(url + path, { redirect: "manual", headers: { cookie: cookie(who) } });
  const post = (path: string, who: string, body: [string, string][]) =>
    fetch(url + path, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie(who) }, body: new URLSearchParams([["csrf", "csrf-1"], ...body]).toString() });
  const rules = async () => Object.fromEntries(await toolRulesFor(db, botId));

  it("the page groups the bot's tools by source, marks defaults and locks approvals", async () => {
    const page = await (await get(`/admin/bots/${botId}?tab=actions`, "Ann")).text();
    expect(page).toContain("<h2>Actions</h2>");
    for (const g of ["web", "mail", "connections", "tickets"]) expect(page).toContain(`<h3>${g}</h3>`);
    expect(page).toMatch(/name="rule:WebSearch" value="free" checked><span>Runs freely \(default\)/);
    expect(page).toMatch(/name="rule:mcp__mail__send_email" value="confirm" checked><span>Needs confirmation \(default\)/);
    expect(page).toContain("Needs confirmation (locked)");
    expect(page).not.toContain('name="rule:mcp__connections__approve"');
  });

  it("an admin's change is saved, shown and audited; choosing the default again clears it", async () => {
    expect((await post(`/admin/bots/${botId}/actions`, "Ann", [["rule:mcp__mail__send_email", "free"], ["rule:WebSearch", "free"]])).status).toBe(303);
    expect(await rules()).toEqual({ mcp__mail__send_email: "free" });
    expect(await (await get(`/admin/bots/${botId}?tab=actions`, "Ann")).text()).toMatch(/name="rule:mcp__mail__send_email" value="free" checked><span>Runs freely</);
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.kind, "admin"));
    expect(rows).toHaveLength(1); // the unchanged WebSearch writes no row
    expect(rows[0]).toMatchObject({ chatId: null, personId: id.Ann, toolName: "mcp__mail__send_email", status: "done", summary: "Admin: mcp__mail__send_email (Needs confirmation → Runs freely)" });
    await post(`/admin/bots/${botId}/actions`, "Ann", [["rule:mcp__mail__send_email", "confirm"], ["rule:mcp__tickets__list_tickets", "confirm"]]);
    expect(await rules()).toEqual({ mcp__tickets__list_tickets: "confirm" });
  });

  it("an approval cannot be set free, and an unknown tool is ignored", async () => {
    const before = await rules();
    expect((await post(`/admin/bots/${botId}/actions`, "Ann", [["rule:mcp__connections__approve", "free"], ["rule:mcp__tickets__close_ticket", "free"]])).status).toBe(400);
    expect((await post(`/admin/bots/${botId}/actions`, "Ann", [["rule:mcp__evil__anything", "free"]])).status).toBe(303);
    expect(await rules()).toEqual(before);
  });

  it("heads get 403 and see no Actions; another tenant's admin is refused", async () => {
    expect((await post(`/admin/bots/${botId}/actions`, "Hal", [["rule:mcp__tickets__close_ticket", "free"]])).status).toBe(403);
    expect(await (await get(`/admin/bots/${botId}`, "Hal")).text()).not.toContain("<h2>Actions</h2>");
    expect((await post(`/admin/bots/${botId}/actions`, "Zed", [["rule:mcp__tickets__close_ticket", "free"]])).status).toBe(400);
    expect((await rules()).mcp__tickets__close_ticket).toBeUndefined();
  });
});


describe("bot page tabs and arming", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  let ann: string, botId: string;

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: T });
    ann = (await upsertPerson(db, { tenantId: T, aadObjectId: "aad-Ann", name: "Ann" })).id;
    await setRole(db, T, ann, "admin");
    botId = (await upsertDefinition(db, secretsKey, T, { name: "tabby", label: "Tabby", persona: "Persona text.", model: "m1", mcpServers: [] } as Parameters<typeof upsertDefinition>[3])).id;
    await recordTools(db, botId, ["WebSearch"]);
    await db.insert(mailboxes).values({ definitionId: botId, tenantId: T, agent: "a", localPart: "tabby", inboxId: "in1", address: "tabby@mail.test", status: "active" });
    const mail = { db, secretsKey, publicUrl: "https://bot.example.test", admin: { mailDomain: async () => "mail.test", getSendAs: async () => ({}), setInboxActive: async () => undefined, listKeys: async () => [], listWebhooks: async () => [], revokeKey: async () => undefined, removeWebhook: async () => undefined } } as unknown as MailDeps;
    const app = express();
    app.use("/admin", adminRouter({ db, config, exchangeCode: async () => ({ id_token: "x" }), verifyIdToken: async () => ({ oid: "", tid: "", name: "", email: "" }), botName: "Bot", defaultModel: "m", fetchUsers: async () => [], mail }));
    ({ url, close } = await serve(app));
  });
  afterAll(() => close());

  const cookie = () => sessionCookie(secretsKey, T, ann);
  const get = (path: string) => fetch(url + path, { redirect: "manual", headers: { cookie: cookie() } }).then((r) => r.text());

  it("each tab shows its own section and not the others", async () => {
    const section: Record<string, string> = { persona: "Persona text.", email: "remove email address", actions: "<h2>Actions</h2>", connections: "<h2>MCP servers</h2>", routines: "<h2>Routines and reminders</h2>", learnings: "<h2>Learnings</h2>" };
    for (const [tab, mark] of Object.entries(section)) {
      const page = await get(`/admin/bots/${botId}?tab=${tab}`);
      expect(page).toContain(mark);
      for (const [other, m] of Object.entries(section)) if (other !== tab && m !== "Persona text.") expect(page).not.toContain(m);
      expect(page).toContain(`class="active" aria-current="page">${tab}</a>`);
    }
    const first = await get(`/admin/bots/${botId}`);
    expect(first).toContain('class="active" aria-current="page">overview</a>');
    expect(first).toContain("be-pagehead");
    expect(first).toContain("tabby@mail.test · m1");
    expect(first).not.toMatch(/bam_|amwh_/);
  });

  it("removing a server, deleting a routine and clearing the company address need a second press", async () => {
    const post = (path: string, body: [string, string][]) =>
      fetch(`${url}/admin/bots/${botId}/${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() }, body: new URLSearchParams([["csrf", "csrf-1"], ["tab", "connections"], ...body]).toString() });
    await db.update(botDefinitions).set({ mcpServers: [{ name: "srv", transport: "stdio", command: "c", args: [], readOnlyTools: [] }] as never }).where(eq(botDefinitions.id, botId));
    const first = await post("servers/srv/delete", []);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("confirm remove?");
    expect((await getDefinition(db, T, botId))!.mcpServers.map((x) => x.name)).toEqual(["srv"]);
    expect((await post("servers/srv/delete", [["confirm", "yes"]])).status).toBe(303);
    expect((await getDefinition(db, T, botId))!.mcpServers).toHaveLength(0);
    const armed = await post("send-as/remove", []);
    expect(armed.status).toBe(200);
    expect(await armed.text()).toContain("confirm clear?");
  });

  it("removing the email address needs a second press and then works", async () => {
    const post = (body: [string, string][]) =>
      fetch(`${url}/admin/bots/${botId}/mailbox/remove`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie() }, body: new URLSearchParams([["csrf", "csrf-1"], ["tab", "email"], ...body]).toString() });
    const first = await post([]);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("confirm remove?");
    expect((await db.select().from(mailboxes).where(eq(mailboxes.definitionId, botId)))[0].status).toBe("active");
    const second = await post([["confirm", "yes"]]);
    expect(second.status).toBe(303);
    expect(second.headers.get("location")).toBe(`/admin/bots/${botId}?tab=email`);
    expect((await db.select().from(mailboxes).where(eq(mailboxes.definitionId, botId)))[0].status).toBe("removed");
  });
});

describe("adding an MCP server", () => {
  it("a pasted claude mcp add command adds the server, lists its tools, frees the read-only ones, and one switch sets a whole group", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: T });
    const ann = (await upsertPerson(db, { tenantId: T, aadObjectId: "aad-Ann", name: "Ann" })).id;
    await setRole(db, T, ann, "admin");
    const botId = (await upsertDefinition(db, secretsKey, T, { name: "finance", label: "Finance", persona: "p" })).id;
    const seen: Headers[] = [];
    let up = true;
    const fetchFn = (async (_u: string | URL | Request, init?: RequestInit) => {
      if (!up) throw Object.assign(new Error("down"), { cause: { code: "ECONNREFUSED" } });
      seen.push(new Headers(init?.headers));
      const msg = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result = msg.method === "initialize" ? { protocolVersion: "2025-06-18" }
        : { tools: [{ name: "list-invoices", annotations: { readOnlyHint: true } }, { name: "create-invoice" }, { name: "list-contacts" }] };
      return Response.json({ jsonrpc: "2.0", id: msg.id, result });
    }) as typeof fetch;
    const app = express();
    app.use("/admin", adminRouter({ db, config, exchangeCode: async () => ({ id_token: "x" }), verifyIdToken: async () => ({ oid: "", tid: "", name: "", email: "" }), botName: "Bot", defaultModel: "m", fetchUsers: async () => [], fetchFn }));
    const { url, close } = await serve(app);
    const post = (path: string, body: [string, string][]) => fetch(url + path, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie(secretsKey, T, ann) },
      body: new URLSearchParams([["csrf", "csrf-1"], ...body]).toString(),
    });
    try {
      const res = await post(`/admin/bots/${botId}/servers`, [["commandLine", `claude mcp add --transport http xero https://xero.example.test/abc --header "Authorization: Bearer tok-1"`]]);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`/admin/bots/${botId}?tab=actions`);
      const def = (await getDefinition(db, T, botId))!;
      expect(def.mcpServers).toEqual([expect.objectContaining({ name: "xero", transport: "http", url: "https://xero.example.test/abc", headersCipher: expect.any(String) })]);
      expect(JSON.stringify(def.mcpServers)).not.toContain("tok-1");
      expect(seen[0]!.get("authorization")).toBe("Bearer tok-1");
      expect(Object.fromEntries(await toolRulesFor(db, botId))).toEqual({ "mcp__xero__list-invoices": "free" });
      const page = await (await fetch(`${url}/admin/bots/${botId}?tab=actions`, { headers: { cookie: sessionCookie(secretsKey, T, ann) } })).text();
      expect(page).toContain("create-invoice");
      expect(page).toContain('name="all:xero"');
      expect((await post(`/admin/bots/${botId}/actions`, [["all:xero", "free"], ["rule:mcp__xero__create-invoice", "confirm"]])).status).toBe(303);
      expect(Object.fromEntries(await toolRulesFor(db, botId))).toEqual({ "mcp__xero__list-invoices": "free", "mcp__xero__create-invoice": "free", "mcp__xero__list-contacts": "free" });
      up = false;
      const failed = await (await post(`/admin/bots/${botId}/servers/xero/tools`, [])).text();
      expect(failed).toContain("xero&#39;s tools could not be listed");
      expect(failed).not.toContain("tok-1");
    } finally {
      await close();
    }
  });
});
