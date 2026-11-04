import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/** Office files read through LibreOffice: documents and decks become a PDF for the model, spreadsheets become CSV text. */
export const OFFICE = /\.(docx?|odt|rtf|pptx?|odp|xlsx?|ods)$/i;
export const SHEET = /\.(xlsx?|ods)$/i;
export const MAX_PAGES = 100; // the model's limit for one PDF

type Run = (cmd: string, args: string[], opts: { timeout: number }) => Promise<unknown>;

/** Runs LibreOffice on the file in a folder of its own, hands that folder to `collect`, then removes it. */
async function convert<T>(bytes: Buffer, name: string, to: string, run: Run, collect: (dir: string) => Promise<T>): Promise<T> {
  const ext = OFFICE.exec(name)?.[0];
  if (!ext) throw new Error("not an office file");
  const dir = await mkdtemp(join(tmpdir(), "office-"));
  try {
    const file = join(dir, `in${ext.toLowerCase()}`);
    await writeFile(file, bytes);
    // a profile per call: two conversions at once would otherwise fight over one
    await run("soffice", ["--headless", "--norestore", `-env:UserInstallation=file://${join(dir, "profile")}`, "--convert-to", to, "--outdir", dir, file], { timeout: 120_000 });
    return await collect(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A document or deck as a PDF of at most MAX_PAGES pages. */
export function officeToPdf(bytes: Buffer, name: string, run: Run = promisify(execFile)): Promise<Buffer> {
  const filter = /\.(pptx?|odp)$/i.test(name) ? "impress_pdf_Export" : "writer_pdf_Export";
  const pages = JSON.stringify({ PageRange: { type: "string", value: `1-${MAX_PAGES}` } });
  return convert(bytes, name, `pdf:${filter}:${pages}`, run, (dir) => readFile(join(dir, "in.pdf")));
}

/** Every sheet of a spreadsheet as CSV, each under its sheet's name; the cells exactly, with no model reading them. */
export function sheetToCsv(bytes: Buffer, name: string, run: Run = promisify(execFile)): Promise<string> {
  // comma, double quote, UTF-8, from row 1, …, formatted as shown, …, every sheet (-1) to its own in-<sheet>.csv
  const to = "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1";
  return convert(bytes, name, to, run, async (dir) => {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".csv")).sort();
    const sheets = await Promise.all(files.map(async (f) => `## ${f.replace(/^in-?/, "").replace(/\.csv$/, "") || "Sheet"}\n${(await readFile(join(dir, f), "utf8")).trimEnd()}`));
    return sheets.join("\n\n");
  });
}
