import type { SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";
import { OFFICE, SHEET, officeToPdf, sheetToCsv } from "./office-pdf.js";

const ASK = "Transcribe this document's text, keeping tables and amounts exactly. Reply with the text only.";

export const TEXT_TYPE = /^(text\/|application\/(json|xml|csv|x-yaml|yaml|javascript|x-sh)\b)/;
export const TEXT_NAME = /\.(txt|md|csv|tsv|json|xml|html?|log|ya?ml|ini|sql|js|ts|py|sh)$/i;
const IMAGE_NAME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
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
  const image = /^image\//.test(type) ? type : IMAGE_NAME[name.split(".").pop()?.toLowerCase() ?? ""];
  if (image && Object.values(IMAGE_NAME).includes(image)) return bytes.length <= MAX_IMAGE ? { image: { data: bytes.toString("base64"), mimeType: image } } : { note: "image too large to show" };
  const pdf = type === "application/pdf" || /\.pdf$/i.test(name);
  if ((pdf || OFFICE.test(name)) && readDocument) return documentText(await readDocument(bytes.toString("base64"), pdf ? name || "file.pdf" : name));
  return { note: "not readable as text" };
}

/**
 * A PDF's text, read by the model in a run of its own with no tools: a tool result can't hand the bot's model a PDF,
 * and whatever the document says can do nothing here but come back as text.
 */
export function documentReader(queryFn: typeof query, model: string, cwd: string, toPdf: typeof officeToPdf = officeToPdf, toCsv: typeof sheetToCsv = sheetToCsv) {
  return async (fileBase64: string, name: string): Promise<string> => {
    // a spreadsheet's cells are already text: read directly, it is faster and exact where a model would retype every row
    if (SHEET.test(name)) return toCsv(Buffer.from(fileBase64, "base64"), name);
    const pdfBase64 = OFFICE.test(name) ? (await toPdf(Buffer.from(fileBase64, "base64"), name)).toString("base64") : fileBase64;
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: "user",
        session_id: "",
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } }, { type: "text", text: ASK }] },
      };
    }
    for await (const m of queryFn({ prompt: prompt(), options: { model, cwd, tools: [], allowedTools: [], maxTurns: 1, persistSession: false } })) {
      if (m.type === "result") {
        if (m.subtype !== "success") throw new Error(`document read ${m.subtype}`);
        return m.result;
      }
    }
    throw new Error("document read ended without a result");
  };
}
