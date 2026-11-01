import type { SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";

const ASK = "Transcribe this document's text, keeping tables and amounts exactly. Reply with the text only.";

/**
 * A PDF's text, read by the model in a run of its own with no tools: a tool result can't hand the bot's model a PDF,
 * and whatever the document says can do nothing here but come back as text.
 */
export function documentReader(queryFn: typeof query, model: string, cwd: string) {
  return async (pdfBase64: string): Promise<string> => {
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
