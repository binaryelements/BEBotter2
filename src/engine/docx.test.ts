import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { markdownToDocx, parseMarkdown } from "./docx.js";

/** A .docx's entry, by name, read from the local headers. */
function entry(buf: Buffer, name: string): Buffer | undefined {
  let off = 0;
  while (off + 30 <= buf.length) {
    const sig = buf.readUInt32LE(off);
    if (sig !== 0x04034b50) break;
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const nameEnd = off + 30 + nameLen;
    const file = buf.subarray(off + 30, nameEnd).toString("utf8");
    const dataStart = nameEnd + extraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (file === name) return method === 8 ? inflateRawSync(data) : data;
    off = dataStart + compSize;
  }
  return undefined;
}

describe("docx", () => {
  it("makes a Word package with the title, headings, lists, tables and a link", () => {
    const b = markdownToDocx("# Report\n\nSome **bold** and *italic* and [a link](https://example.com).\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> quote\n\n```js\nconst x = 1;\n```", "Quarterly report", new Date("2026-11-09T00:00:00Z"));
    expect(b.subarray(0, 4).toString("hex")).toBe("504b0304");
    const doc = entry(b, "word/document.xml")!.toString("utf8");
    expect(doc).toContain("w:document");
    expect(doc).toContain('w:pStyle w:val="Title"');
    expect(doc).toContain('w:pStyle w:val="Heading1"');
    expect(doc).toContain("<w:b/>");
    expect(doc).toContain("<w:i/>");
    expect(doc).toContain("w:hyperlink");
    expect(doc).toContain("w:tbl");
    expect(doc).toContain('w:pStyle w:val="Quote"');
    expect(doc).toContain('w:pStyle w:val="Code"');
    const rels = entry(b, "word/_rels/document.xml.rels")!.toString("utf8");
    expect(rels).toContain('Target="https://example.com"');
    expect(rels).toContain('TargetMode="External"');
    expect(entry(b, "[Content_Types].xml")!.toString("utf8")).toContain("word/document.xml");
    expect(entry(b, "docProps/core.xml")!.toString("utf8")).toContain("Quarterly report");
  });

  it("keeps the title separate and escapes the document's text", () => {
    const b = markdownToDocx("A & B < C > D", "T & T");
    const doc = entry(b, "word/document.xml")!.toString("utf8");
    expect(doc).toContain("A &amp; B &lt; C &gt; D");
    expect(doc).toContain("T &amp; T");
  });

  it("parses the blocks the model writes", () => {
    expect(parseMarkdown("## One\n\n- a\n- b\n\n1. c\n2. d\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> q\n\n```\ncode\n```\n").map((b) => b.kind)).toEqual(["h2", "bullet", "bullet", "ordered", "ordered", "table", "quote", "code"]);
  });
});
