import type { SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";
import { OFFICE, SHEET, officeToPdf, sheetToCsv } from "./office-pdf.js";

const ASK = "Transcribe this document's text, keeping tables and amounts exactly. Reply with the text only.";

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
