import { describe, expect, it } from "vitest";
import type { BotDefinition } from "../db/schema.js";
import { classify } from "./gate.js";

const def = {
  mcpServers: [{ name: "tickets", transport: "http", readOnlyTools: ["list_tickets"] }],
} as unknown as BotDefinition;

describe("classify", () => {
  it("treats WebSearch and WebFetch as read", () => {
    expect(classify("WebSearch", def)).toBe("read");
    expect(classify("WebFetch", def)).toBe("read");
  });
  it("lets the browser look, click, type and run page scripts freely, but asks before it runs code on the server or uploads a file", () => {
    for (const t of ["navigate", "snapshot", "click", "type", "fill_form", "evaluate"]) expect(classify(`mcp__browser__browser_${t}`, def)).toBe("read");
    for (const t of ["run_code_unsafe", "file_upload", "cookie_set"]) expect(classify(`mcp__browser__browser_${t}`, def)).toBe("write");
  });
  it("treats the computer's bash as read", () => {
    expect(classify("mcp__computer__bash", def)).toBe("read");
  });
  it("built-in tools classify as specified", () => {
    const table: [string, string][] = [
      ...["list", "read", "search", "write"].map((t) => [`mcp__knowledge__${t}`, "read"] as [string, string]),
      ...["list", "request", "verify", "ssh_read", "http_read"].map((t) => [`mcp__connections__${t}`, "read"] as [string, string]),
      ["mcp__connections__ssh_change", "write"],
      ["mcp__connections__http_change", "write"],
      ["mcp__connections__approve", "approve"],
      ["mcp__routine__remind", "read"],
      ["mcp__routine__post", "read"],
      ["mcp__computer__bash", "read"],
      ["mcp__mail__send_email", "write"],
      ["mcp__mail__reply_to_email", "write"],
      ["mcp__mail__list_messages", "read"],
      ["mcp__mail__read_thread", "read"],
      ["mcp__mail__forward_email", "write"],
      ["mcp__connections__other", "write"],
      ["mcp__knowledge__other", "write"],
    ];
    for (const [name, want] of table) expect([name, classify(name, def)]).toEqual([name, want]);
    const listed = [{ name: "conn-helpdesk", readOnlyTools: ["list_tickets"] }];
    expect(classify("mcp__conn-helpdesk__list_tickets", def, listed)).toBe("read");
    expect(classify("mcp__conn-helpdesk__list_tickets", def)).toBe("write");
    expect(classify("mcp__conn-helpdesk__close", def, listed)).toBe("write");
  });
  it("treats a listed read-only MCP tool as read", () => {
    expect(classify("mcp__tickets__list_tickets", def)).toBe("read");
  });
  it("treats an unlisted MCP tool as write", () => {
    expect(classify("mcp__tickets__close_ticket", def)).toBe("write");
    expect(classify("mcp__other__list_tickets", def)).toBe("write");
  });
  it("treats anything else as write", () => {
    for (const n of ["Bash", "Write", "Edit", "Mystery"]) expect(classify(n, def)).toBe("write");
  });

  it("an admin rule turns a write free and a read into a confirmation; approve stays approve", () => {
    expect(classify("mcp__tickets__close_ticket", def, [], "free")).toBe("read");
    expect(classify("mcp__tickets__list_tickets", def, [], "confirm")).toBe("write");
    expect(classify("WebSearch", def, [], "confirm")).toBe("write");
    expect(classify("mcp__connections__approve", def, [], "free")).toBe("approve");
    expect(classify("mcp__someone__new_tool", def)).toBe("write");
  });

  it("Graph reads run freely and Graph writes always ask, whatever an admin rule says", () => {
    const reads = ["search_mail", "list_mail", "read_mail", "list_events", "find_free_time", "search_files", "read_file", "list_chats", "read_chat"];
    const writes = ["send_mail", "reply_mail", "create_event", "respond_event", "upload_file"];
    const person = { ...def, identity: "person" } as BotDefinition;
    for (const t of reads) expect(classify(`mcp__m365__${t}`, person)).toBe("read");
    for (const t of writes) {
      expect(classify(`mcp__m365__${t}`, person)).toBe("approve");
      expect(classify(`mcp__m365__${t}`, person, [], "free")).toBe("approve");
    }
    expect(classify("mcp__m365__delete_everything", person)).toBe("write");
    // a service definition has no m365 server of ours, so a server of its own by that name gets no free reads
    const legacy = { ...def, identity: "service", mcpServers: [{ name: "m365", transport: "http", readOnlyTools: [] }] } as unknown as BotDefinition;
    for (const t of reads) expect(classify(`mcp__m365__${t}`, legacy)).toBe("write");
  });
});
