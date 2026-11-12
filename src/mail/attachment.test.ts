import { describe, expect, it, vi } from "vitest";
import { readMailAttachment } from "./attachment.js";

const raw = (filename: string, content_type: string, bytes: Buffer) =>
  ({ text: JSON.stringify({ id: "a1", message_id: "m1", filename, content_type, size_bytes: bytes.length, content_base64: bytes.toString("base64") }) });
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("readMailAttachment", () => {
  it("gives the model the file's text, picture or a note, never the base64", async () => {
    const csv = await readMailAttachment(raw("parts.csv", "text/csv", Buffer.from("item,qty\nlaptop,20")));
    expect(JSON.parse(csv.text)).toEqual({ filename: "parts.csv", content_type: "text/csv", size_bytes: 18, text: "item,qty\nlaptop,20" });

    const png = await readMailAttachment(raw("photo.png", "image/png", PNG));
    expect(png.images).toEqual([{ data: PNG.toString("base64"), mimeType: "image/png" }]);
    expect(png.text).not.toContain("content_base64");

    const zip = await readMailAttachment(raw("x.zip", "application/zip", Buffer.from("PK\u0003\u0004")));
    expect(JSON.parse(zip.text)).toMatchObject({ filename: "x.zip", note: "not readable as text" });

    const reader = vi.fn(async () => "Quote request: 20 laptops");
    const pdf = await readMailAttachment(raw("spec.pdf", "application/pdf", Buffer.from("%PDF-1.4")), reader);
    expect(reader).toHaveBeenCalledWith(Buffer.from("%PDF-1.4").toString("base64"), "spec.pdf");
    expect(JSON.parse(pdf.text)).toMatchObject({ filename: "spec.pdf", text: "Quote request: 20 laptops" });
  });

  it("passes errors and anything that is not a file through unchanged", async () => {
    const error = { text: "attachment x not found", isError: true };
    expect(await readMailAttachment(error)).toBe(error);
    expect(await readMailAttachment({ text: "plain" })).toEqual({ text: "plain" });
    expect(await readMailAttachment({ text: '{"id":"a1"}' })).toEqual({ text: '{"id":"a1"}' });
  });
});
