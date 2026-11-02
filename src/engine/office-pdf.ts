import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/** Office files read by turning them into a PDF first; the model reads PDFs, not these. */
export const OFFICE = /\.(docx?|odt|rtf|pptx?|odp|xlsx?|ods)$/i;
export const MAX_PAGES = 100; // the model's limit for one PDF

const FILTER: [RegExp, string][] = [
  [/\.(pptx?|odp)$/i, "impress_pdf_Export"],
  [/\.(xlsx?|ods)$/i, "calc_pdf_Export"],
  [/./, "writer_pdf_Export"],
];

type Run = (cmd: string, args: string[], opts: { timeout: number }) => Promise<unknown>;

/** The file as a PDF of at most MAX_PAGES pages, made by LibreOffice in a folder of its own that is removed after. */
export async function officeToPdf(bytes: Buffer, name: string, run: Run = promisify(execFile)): Promise<Buffer> {
  const ext = OFFICE.exec(name)?.[0];
  if (!ext) throw new Error("not an office file");
  const dir = await mkdtemp(join(tmpdir(), "office-"));
  try {
    const file = join(dir, `in${ext.toLowerCase()}`);
    await writeFile(file, bytes);
    const filter = FILTER.find(([re]) => re.test(ext))![1];
    const pages = JSON.stringify({ PageRange: { type: "string", value: `1-${MAX_PAGES}` } });
    // a profile per call: two conversions at once would otherwise fight over one
    await run("soffice", ["--headless", "--norestore", `-env:UserInstallation=file://${join(dir, "profile")}`, "--convert-to", `pdf:${filter}:${pages}`, "--outdir", dir, file], { timeout: 120_000 });
    return await readFile(join(dir, "in.pdf"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
