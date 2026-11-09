import { crc32, deflateRawSync } from "node:zlib";

/**
 * A Word document made from Markdown, with no Office runtime: the .docx is a ZIP of WordprocessingML
 * parts, so the person can open it in Word, Teams or a browser. The model writes Markdown; the
 * tool uploads these bytes to the person's OneDrive.
 */

type Block =
  | { kind: "title" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "quote" | "code"; text: string }
  | { kind: "bullet" | "ordered"; text: string; level: number; n: number }
  | { kind: "table"; rows: string[][] }
  | { kind: "rule" };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const NAMED = ["&amp;", "&lt;", "&gt;", "&quot;"];

type Run = { text: string; bold?: boolean; italic?: boolean; code?: boolean; link?: string };
const rpr = (r: Run) => {
  const parts: string[] = [];
  if (r.bold) parts.push("<w:b/>");
  if (r.italic) parts.push("<w:i/>");
  if (r.code) parts.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
  if (r.link) parts.push('<w:rStyle w:val="Hyperlink"/>');
  return parts.length ? `<w:rPr>${parts.join("")}</w:rPr>` : "";
};

/** The inline text of a line as Word runs: bold, italic, code and links. */
function inline(text: string, links: string[], boldAll = false): string {
  const out: string[] = [];
  const push = (r: Run) => {
    if (!r.text) return;
    const run = { ...r, ...(boldAll ? { bold: true } : {}) };
    if (r.link) {
      const id = `rId${links.length + 2}`;
      links.push(r.link);
      out.push(`<w:hyperlink r:id="${id}"><w:r>${rpr(run)}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r></w:hyperlink>`);
      return;
    }
    out.push(`<w:r>${rpr(run)}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`);
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      push({ text: link[1]!, link: link[2]! });
      i += link[0].length;
      continue;
    }
    const bold = /^(\*\*|__)(.+?)\1/.exec(rest);
    if (bold) {
      push({ text: bold[2]!, bold: true });
      i += bold[0].length;
      continue;
    }
    const italic = /^(\*|_)([^*_]+?)\1/.exec(rest);
    if (italic) {
      push({ text: italic[2]!, italic: true });
      i += italic[0].length;
      continue;
    }
    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      push({ text: code[1]!, code: true });
      i += code[0].length;
      continue;
    }
    const escaped = /^\\([\\`*_{}[\]()#+\-.!>])/.exec(rest);
    if (escaped) {
      push({ text: escaped[1]! });
      i += escaped[0].length;
      continue;
    }
    const next = rest.search(/[*_`[\\]/);
    if (next === 0) {
      push({ text: rest[0]! });
      i += 1;
      continue;
    }
    const end = next === -1 ? rest.length : next;
    // entities are decoded first, so the document never carries the literal "&amp;" a model typed
    push({ text: rest.slice(0, end).replace(/&(amp|lt|gt|quot);/g, (m) => NAMED.includes(m) ? ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"' } as Record<string, string>)[m]! : m) });
    i += end;
  }
  return out.join("");
}

const isBlockStart = (line: string) =>
  /^\s*(```|#{1,6}\s|>\s|[-*+]\s|\d+[.)]\s|(-{3,}|\*{3,}|_{3,})\s*$)/.test(line);

/** Markdown into the blocks a Word document is built from. */
export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i++]!);
      i++; // the closing fence
      for (const part of code) blocks.push({ kind: "code", text: part });
      if (!code.length) blocks.push({ kind: "code", text: "" });
      continue;
    }
    const heading = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ kind: (["h1", "h2", "h3", "h4", "h5", "h6"] as const)[heading[1]!.length - 1]!, text: heading[2]! });
      i++;
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      const text: string[] = [];
      while (i < lines.length) {
        const q = /^\s*>\s?(.*)$/.exec(lines[i]!);
        if (!q) break;
        text.push(q[1]!);
        i++;
      }
      blocks.push({ kind: "quote", text: text.join(" ") });
      continue;
    }
    const table = /^\s*\|.*\|\s*$/.test(line);
    if (table) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
        const cells = lines[i]!.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
        rows.push(cells);
        i++;
      }
      // the second row is the separator; the first is the header
      if (rows.length >= 2 && rows[1]!.every((c) => /^:?-{2,}:?$/.test(c))) {
        rows.splice(1, 1);
        blocks.push({ kind: "table", rows });
      } else {
        for (const r of rows) blocks.push({ kind: "p", text: r.join(" | ") });
      }
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const level = Math.min(3, Math.floor(bullet[1]!.length / 2));
      blocks.push({ kind: "bullet", text: bullet[2]!, level, n: 0 });
      i++;
      continue;
    }
    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      const level = Math.min(3, Math.floor(ordered[1]!.length / 2));
      blocks.push({ kind: "ordered", text: ordered[3]!, level, n: Number(ordered[2]!) });
      i++;
      continue;
    }
    // a paragraph runs until a blank line or the next block
    const text: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!) && !/^\s*\|.*\|\s*$/.test(lines[i]!)) text.push(lines[i++]!);
    blocks.push({ kind: "p", text: text.join(" ") });
  }
  return blocks;
}

const para = (runs: string, style?: string, indent?: number, extra?: string) => {
  const ppr: string[] = [];
  if (style) ppr.push(`<w:pStyle w:val="${style}"/>`);
  if (indent) ppr.push(`<w:ind w:left="${indent}" w:hanging="360"/>`);
  if (extra) ppr.push(extra);
  return `<w:p>${ppr.length ? `<w:pPr>${ppr.join("")}</w:pPr>` : ""}${runs}</w:p>`;
};

const tableXml = (rows: string[][], links: string[]) =>
  `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>${rows
    .map((r, ri) => `<w:tr>${r.map((c) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${para(inline(c, links, ri === 0))}</w:tc>`).join("")}</w:tr>`)
    .join("")}</w:tbl>`;

const documentXml = (blocks: Block[], title: string | undefined, links: string[]) => {
  const body: string[] = [];
  if (title) body.push(para(inline(title, links), "Title"));
  for (const b of blocks) {
    switch (b.kind) {
      case "title":
        body.push(para(inline(b.text, links), "Title"));
        break;
      case "h1":
        body.push(para(inline(b.text, links), "Heading1"));
        break;
      case "h2":
        body.push(para(inline(b.text, links), "Heading2"));
        break;
      case "h3":
        body.push(para(inline(b.text, links), "Heading3"));
        break;
      case "h4":
        body.push(para(inline(b.text, links), "Heading4"));
        break;
      case "h5":
        body.push(para(inline(b.text, links), "Heading5"));
        break;
      case "h6":
        body.push(para(inline(b.text, links), "Heading6"));
        break;
      case "p":
        body.push(para(inline(b.text, links)));
        break;
      case "bullet":
        body.push(para(inline(`${b.level ? "◦" : "•"} ${b.text}`, links), "Normal", 720 + b.level * 360));
        break;
      case "ordered":
        body.push(para(inline(`${b.n}. ${b.text}`, links), "Normal", 720 + b.level * 360));
        break;
      case "quote":
        body.push(para(inline(b.text, links), "Quote"));
        break;
      case "code":
        body.push(`<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:t xml:space="preserve">${esc(b.text)}</w:t></w:r></w:p>`);
        break;
      case "table":
        body.push(tableXml(b.rows, links));
        break;
      case "rule":
        body.push(`<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>`);
        break;
    }
  }
  if (!body.length) body.push(para(""));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
};

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="240" w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="60"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="120" w:after="40"/></w:pPr><w:rPr><w:b/><w:i/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:rPr><w:i/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/><w:color w:val="555555"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;

const coreXml = (title: string, at: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>BE Teammate</dc:creator><cp:lastModifiedBy>BE Teammate</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${at}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${at}</dcterms:modified></cp:coreProperties>`;

const APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>BE Teammate</Application></Properties>`;

type ZipEntry = { name: string; data: Buffer };

/** A ZIP with the stored or deflated entries, as a .docx needs. */
export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data) >>> 0;
    const compressed = deflateRawSync(e.data);
    const useDeflate = compressed.length < e.data.length;
    const body = useDeflate ? compressed : e.data;
    const method = useDeflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, dir, end]);
}

/** A Word document (.docx) from Markdown; title is the document's title, when given. */
export function markdownToDocx(markdown: string, title?: string, at = new Date()): Buffer {
  const links: string[] = [];
  const blocks = parseMarkdown(markdown);
  const document = documentXml(blocks, title, links);
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${links.map((target, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(target)}" TargetMode="External"/>`).join("")}</Relationships>`;
  const stamp = at.toISOString().replace(/\.\d{3}Z$/, "Z");
  return zip([
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(ROOT_RELS, "utf8") },
    { name: "word/document.xml", data: Buffer.from(document, "utf8") },
    { name: "word/styles.xml", data: Buffer.from(STYLES, "utf8") },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(rels, "utf8") },
    { name: "docProps/core.xml", data: Buffer.from(coreXml(title || "Document", stamp), "utf8") },
    { name: "docProps/app.xml", data: Buffer.from(APP_XML, "utf8") },
  ]);
}
