import { describe, expect, it, vi } from "vitest";
import { documentReader, pdfToText } from "./read-document.js";

describe("documentReader", () => {
  it("reads a PDF as text with no model in the loop", async () => {
    const toText = vi.fn(async () => "Invoice 777");
    expect(await documentReader(undefined, undefined, toText)(Buffer.from("%PDF").toString("base64"), "inv.pdf")).toBe("Invoice 777");
    expect(toText).toHaveBeenCalledWith(Buffer.from("%PDF"));
  });

  it("turns an Office file into a PDF first, then reads its text", async () => {
    const toPdf = vi.fn(async () => Buffer.from("%PDF-deck"));
    const toText = vi.fn(async () => "slide text");
    expect(await documentReader(toPdf, undefined, toText)(Buffer.from("PK").toString("base64"), "Deck.pptx")).toBe("slide text");
    expect(toPdf).toHaveBeenCalledWith(Buffer.from("PK"), "Deck.pptx");
    expect(toText).toHaveBeenCalledWith(Buffer.from("%PDF-deck"));
  });

  it("reads a spreadsheet as CSV with no PDF step", async () => {
    const toCsv = vi.fn(async () => "## Calls\nDate,Cost");
    const toText = vi.fn();
    expect(await documentReader(undefined, toCsv, toText)(Buffer.from("PK").toString("base64"), "cdr.xlsx")).toBe("## Calls\nDate,Cost");
    expect(toCsv).toHaveBeenCalledWith(Buffer.from("PK"), "cdr.xlsx");
    expect(toText).not.toHaveBeenCalled();
  });
});

describe("pdfToText", () => {
  it("runs pdftotext and returns its stdout", async () => {
    const run = vi.fn(async () => ({ stdout: "hello" }));
    expect(await pdfToText(Buffer.from("%PDF"), run)).toBe("hello");
    expect(run).toHaveBeenCalledWith("pdftotext", ["-layout", expect.any(String), "-"], expect.objectContaining({ timeout: 120_000 }));
  });
});
