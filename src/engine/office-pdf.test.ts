import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { officeToPdf, sheetToCsv } from "./office-pdf.js";

describe("officeToPdf", () => {
  it("runs LibreOffice with the filter for the kind of file and a page limit, returns the PDF and cleans up", async () => {
    let seen: string[] = [];
    let input = "";
    const run = async (cmd: string, args: string[]) => {
      seen = [cmd, ...args];
      const file = args.at(-1)!;
      input = await readFile(file, "utf8");
      await writeFile(join(dirname(file), "in.pdf"), "%PDF-out");
    };
    expect((await officeToPdf(Buffer.from("deck"), "KJ Overview.PPTX", run)).toString()).toBe("%PDF-out");
    expect(input).toBe("deck");
    expect(seen[0]).toBe("soffice");
    expect(seen).toContain('pdf:impress_pdf_Export:{"PageRange":{"type":"string","value":"1-100"}}');
    expect(seen.at(-1)).toMatch(/in\.pptx$/);
    expect(existsSync(dirname(seen.at(-1)!))).toBe(false);
  });

  it("uses the writer filter for documents", async () => {
    let to = "";
    const run = async (_: string, args: string[]) => {
      to = args[args.indexOf("--convert-to") + 1]!;
      await writeFile(join(dirname(args.at(-1)!), "in.pdf"), "x");
    };
    await officeToPdf(Buffer.from("d"), "a.docx", run);
    expect(to.split(":")[1]).toBe("writer_pdf_Export");
  });

  it("a spreadsheet comes back as CSV, every sheet under its name, and the folder is removed", async () => {
    let seen: string[] = [];
    const run = async (_: string, args: string[]) => {
      seen = args;
      const dir = dirname(args.at(-1)!);
      await writeFile(join(dir, "in-Calls.csv"), "Date,Cost\n2026-10-01,1.20\n");
      await writeFile(join(dir, "in-Summary.csv"), "Total,1.20\n");
    };
    expect(await sheetToCsv(Buffer.from("PK"), "cdr.XLSX", run)).toBe("## Calls\nDate,Cost\n2026-10-01,1.20\n\n## Summary\nTotal,1.20");
    expect(seen[seen.indexOf("--convert-to") + 1]).toMatch(/^csv:Text - txt - csv \(StarCalc\):44,34,76,.*,-1$/);
    expect(existsSync(dirname(seen.at(-1)!))).toBe(false);
  });

  it("a failed conversion throws and still cleans up", async () => {
    let dir = "";
    const run = async (_: string, args: string[]) => {
      dir = dirname(args.at(-1)!);
      throw new Error("soffice died");
    };
    await expect(officeToPdf(Buffer.from("d"), "a.docx", run)).rejects.toThrow("soffice died");
    expect(existsSync(dir)).toBe(false);
  });
});
