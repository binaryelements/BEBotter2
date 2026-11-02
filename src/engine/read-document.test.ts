import { describe, expect, it, vi } from "vitest";
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
    expect(await documentReader(f.fn, "m", "/srv/files")("UERG", "inv.pdf")).toBe("Invoice 777");
    expect(f.seen.options).toMatchObject({ model: "m", tools: [], allowedTools: [], maxTurns: 1, persistSession: false });
    expect(f.seen.content).toMatchObject([{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "UERG" } }, { type: "text" }]);
  });

  it("an Office file is turned into a PDF first, and the PDF is what the model reads", async () => {
    const f = fake({ subtype: "success", result: "slide text" });
    const toPdf = vi.fn(async () => Buffer.from("%PDF-deck"));
    expect(await documentReader(f.fn, "m", "/", toPdf)(Buffer.from("PK").toString("base64"), "Deck.pptx")).toBe("slide text");
    expect(toPdf).toHaveBeenCalledWith(Buffer.from("PK"), "Deck.pptx");
    expect(f.seen.content).toMatchObject([{ type: "document", source: { data: Buffer.from("%PDF-deck").toString("base64") } }, { type: "text" }]);
  });

  it("a spreadsheet is read as CSV with no model run", async () => {
    const f = fake({ subtype: "success", result: "not used" });
    const toCsv = vi.fn(async () => "## Calls\nDate,Cost");
    expect(await documentReader(f.fn, "m", "/", undefined, toCsv)(Buffer.from("PK").toString("base64"), "cdr.xlsx")).toBe("## Calls\nDate,Cost");
    expect(toCsv).toHaveBeenCalledWith(Buffer.from("PK"), "cdr.xlsx");
    expect(f.seen.content).toBeUndefined();
  });

  it("a failed run throws without quoting the document", async () => {
    await expect(documentReader(fake({ subtype: "error_max_turns" }).fn, "m", "/")("UERG", "inv.pdf")).rejects.toThrow("document read error_max_turns");
  });
});
