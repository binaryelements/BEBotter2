import type { ToolResult } from "../engine/engine.js";
import { readBytes } from "../engine/read-document.js";

type Raw = { filename?: unknown; content_type?: unknown; size_bytes?: unknown; content_base64?: unknown };

/** BE AgentMail's get_attachment hands back the file as base64, which a model cannot read: give it what the document reader makes of the file instead. */
export async function readMailAttachment(result: ToolResult, readDocument?: (fileBase64: string, name: string) => Promise<string>): Promise<ToolResult> {
  if (result.isError) return result;
  let raw: Raw;
  try {
    raw = JSON.parse(result.text) as Raw;
  } catch {
    return result;
  }
  if (typeof raw?.content_base64 !== "string") return result;
  const filename = typeof raw.filename === "string" ? raw.filename : "";
  const contentType = typeof raw.content_type === "string" ? raw.content_type : "";
  const details = { filename, content_type: contentType, size_bytes: raw.size_bytes };
  const read = await readBytes(Buffer.from(raw.content_base64, "base64"), filename, contentType, readDocument);
  return "image" in read ? { text: JSON.stringify(details), images: [read.image] } : { text: JSON.stringify({ ...details, ...read }) };
}
