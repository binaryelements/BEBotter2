import { describe, expect, it } from "vitest";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import { documentReader } from "./read-document.js";

/** queryFn faked: records the options and the prompt's content, then yields one result. */
function fake(result: Record<string, unknown>) {
  const seen: { options?: Record<string, unknown>; content?: unknown } = {};
  const fn = (({ prompt, options }: { prompt: AsyncIterable<{ message: { content: unknown } }>; options: Record<string, unknown> }) =>
    (async function* () {
      seen.options = options;
      for await (const m of prompt) seen.content = m.message.content;
      yield { type: "result", ...result };
    })()) as unknown as typeof query;
  return { fn, seen };
}

describe("documentReader", () => {
  it("sends the PDF as a document to a run with no tools and returns its text", async () => {
    const f = fake({ subtype: "success", result: "Invoice 777" });
    expect(await documentReader(f.fn, "m", "/srv/files")("UERG")).toBe("Invoice 777");
    expect(f.seen.options).toMatchObject({ model: "m", tools: [], allowedTools: [], maxTurns: 1, persistSession: false });
    expect(f.seen.content).toMatchObject([{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "UERG" } }, { type: "text" }]);
  });

  it("a failed run throws without quoting the document", async () => {
    await expect(documentReader(fake({ subtype: "error_max_turns" }).fn, "m", "/")("UERG")).rejects.toThrow("document read error_max_turns");
  });
});
