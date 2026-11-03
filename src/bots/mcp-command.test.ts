import { describe, expect, it } from "vitest";
import { parseMcpAdd } from "./mcp-command.js";

describe("parseMcpAdd", () => {
  it("reads an http server with a quoted header, as servers publish it", () => {
    expect(parseMcpAdd(`claude mcp add --transport http xero-abc https://xeromcp.example.test/abc --header "Authorization: Bearer tok 123"`)).toEqual({
      name: "xero-abc", transport: "http", url: "https://xeromcp.example.test/abc", headers: { Authorization: "Bearer tok 123" },
    });
    expect(parseMcpAdd(`claude mcp add -t http -s user api https://a.test/mcp -H 'X-Key: a"b' \\\n -H=X-Other:2`)).toEqual({
      name: "api", transport: "http", url: "https://a.test/mcp", headers: { "X-Key": 'a"b', "X-Other": "2" },
    });
  });
  it("reads a stdio server with its arguments after --", () => {
    expect(parseMcpAdd("claude mcp add files -- npx -y @scope/server --root /data")).toEqual({ name: "files", transport: "stdio", command: "npx", args: ["-y", "@scope/server", "--root", "/data"] });
  });
  it("refuses what it can't add, without echoing a header that may be the secret", () => {
    expect(() => parseMcpAdd("npm install x")).toThrow(/claude mcp add/);
    expect(() => parseMcpAdd("claude mcp add x -e KEY=1 -- npx y")).toThrow(/--env/);
    expect(() => parseMcpAdd("claude mcp add x 'unclosed")).toThrow(/quote/);
    const err = (() => { try { parseMcpAdd("claude mcp add --transport http x https://a.test -H supersecrettoken"); } catch (e) { return (e as Error).message; } })();
    expect(err).toMatch(/Name: value/);
    expect(err).not.toContain("supersecrettoken");
  });
});
