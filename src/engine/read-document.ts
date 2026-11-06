import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { OFFICE, SHEET, officeToPdf, sheetToCsv } from "./office-pdf.js";

export const TEXT_TYPE = /^(text\/|application\/(json|xml|csv|x-yaml|yaml|javascript|x-sh)\b)/;
export const TEXT_NAME = /\.(txt|md|csv|tsv|json|xml|html?|log|ya?ml|ini|sql|js|ts|py|sh)$/i;
const IMAGE_NAME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
/** The image type the bytes themselves say, for files Teams labels only "image/*" or names with no extension. */
export function sniffImage(bytes: Buffer): string | undefined {
  const hex = bytes.subarray(0, 12).toString("hex");
  return hex.startsWith("89504e47") ? "image/png" : hex.startsWith("ffd8ff") ? "image/jpeg" : hex.startsWith("47494638") ? "image/gif" : hex.startsWith("52494646") && hex.endsWith("57454250") ? "image/webp" : undefined;
}
export const MAX_IMAGE = 3_750_000; // bytes: the model's limit for one image
export const MAX_ATTACHMENT = 10 * 1024 * 1024;
// shortcut: one document stops here, to stay under the tool result limit (about 25,000 tokens); add paging if longer ones matter
const MAX_DOCUMENT = 80_000;

export type Readable = { note: string } | { text: string; note?: string } | { image: { data: string; mimeType: string } };
const documentText = (text: string): Readable => (text.length > MAX_DOCUMENT ? { text: text.slice(0, MAX_DOCUMENT), note: `cut short: first ${MAX_DOCUMENT} of ${text.length} characters` } : { text });

/** What a model can take of a file: its text (plain, PDF, Office, sheet), the image itself, or a note saying why neither. */
export async function readBytes(bytes: Buffer, name: string, type: string, readDocument?: (fileBase64: string, name: string) => Promise<string>): Promise<Readable> {
  if (bytes.length > MAX_ATTACHMENT) return { note: "too large to read" };
  if (TEXT_TYPE.test(type) || TEXT_NAME.test(name)) return documentText(bytes.toString("utf8"));
  const image = sniffImage(bytes) ?? (/^image\//.test(type) ? type : IMAGE_NAME[name.split(".").pop()?.toLowerCase() ?? ""]);
  if (image && Object.values(IMAGE_NAME).includes(image)) return bytes.length <= MAX_IMAGE ? { image: { data: bytes.toString("base64"), mimeType: image } } : { note: "image too large to show" };
  const pdf = type === "application/pdf" || /\.pdf$/i.test(name);
  if ((pdf || OFFICE.test(name)) && readDocument) return documentText(await readDocument(bytes.toString("base64"), pdf ? name || "file.pdf" : name));
  return { note: "not readable as text" };
}

type Run = (cmd: string, args: string[], opts: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;

/** A PDF's text, read by pdftotext: no model is involved, so the document cannot instruct anything. */
export async function pdfToText(bytes: Buffer, run: Run = promisify(execFile) as unknown as Run): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pdf-"));
  try {
    const file = join(dir, "in.pdf");
    await writeFile(file, bytes);
    const { stdout } = await run("pdftotext", ["-layout", file, "-"], { timeout: 120_000, maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A PDF's or Office file's text, with no model in the loop. */
export function documentReader(
  toPdf: typeof officeToPdf = officeToPdf,
  toCsv: typeof sheetToCsv = sheetToCsv,
  toText: (bytes: Buffer) => Promise<string> = pdfToText,
) {
  return async (fileBase64: string, name: string): Promise<string> => {
    // a spreadsheet's cells are already text: read directly, it is faster and exact where a model would retype every row
    if (SHEET.test(name)) return toCsv(Buffer.from(fileBase64, "base64"), name);
    const pdf = OFFICE.test(name) ? await toPdf(Buffer.from(fileBase64, "base64"), name) : Buffer.from(fileBase64, "base64");
    return toText(pdf);
  };
}
