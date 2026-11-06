import { describe, expect, it } from "vitest";
import type { EngineMessage } from "./engine.js";
import { compact, estimateTokens, withoutImages } from "./transcript.js";

const user = (text: string): EngineMessage => ({ role: "user", text });
const assistant = (text: string): EngineMessage => ({ role: "assistant", text });

describe("transcript", () => {
  it("leaves a short history alone", () => {
    const messages = [user("hi"), assistant("hello")];
    expect(compact(messages, undefined, 100_000)).toEqual({ messages });
  });

  it("folds the oldest messages into a summary and keeps the recent window", () => {
    const messages = Array.from({ length: 20 }, (_, i) => user(`message ${i} ${"x".repeat(400)}`));
    const out = compact(messages, undefined, 1_000); // 60% = 600 tokens; each message is about 100
    expect(out.messages.length).toBeLessThan(messages.length);
    expect(out.messages.length).toBeGreaterThanOrEqual(4);
    expect(out.summary).toContain("message 0");
    expect(out.summary).not.toContain("message 19");
    expect(out.messages.at(-1)).toEqual(messages.at(-1));
  });

  it("keeps the previous summary and caps the new one", () => {
    const messages = Array.from({ length: 20 }, (_, i) => user(`m${i} ${"y".repeat(400)}`));
    const out = compact(messages, "older summary", 1_000);
    expect(out.summary).toContain("older summary");
    expect(out.summary!.length).toBeLessThanOrEqual(4_000);
  });

  it("never starts the kept window on a tool result", () => {
    const messages: EngineMessage[] = [
      user("old"),
      { role: "assistant", toolCalls: [{ id: "c1", name: "x", input: {} }] },
      { role: "tool", toolCallId: "c1", text: "result" },
      ...Array.from({ length: 20 }, (_, i) => user(`m${i} ${"z".repeat(400)}`)),
    ];
    for (let window = 200; window <= 4_000; window += 50) {
      expect([window, compact(messages, undefined, window).messages[0]?.role]).not.toEqual([window, "tool"]);
    }
  });

  it("keeps an assistant tool call with its tool result", () => {
    const messages: EngineMessage[] = [
      user("old"),
      { role: "assistant", toolCalls: [{ id: "c1", name: "x", input: {} }] },
      { role: "tool", toolCallId: "c1", text: "result" },
    ];
    expect(compact(messages, undefined, 1_000_000).messages).toEqual(messages);
  });

  it("counts an image as a flat cost", () => {
    expect(estimateTokens([{ role: "user", text: "", images: [{ data: "x", mimeType: "image/png" }] }])).toBe(1_000);
  });

  it("caps the stored window even when the context is huge", () => {
    const messages = Array.from({ length: 100 }, (_, i) => user(`m${i}`));
    expect(compact(messages, undefined, 10_000_000).messages).toHaveLength(40);
  });

  it("strips image bytes before the transcript is stored", () => {
    const messages: EngineMessage[] = [{ role: "user", text: "look", images: [{ data: "x", mimeType: "image/png" }] }];
    expect(withoutImages(messages)).toEqual([{ role: "user", text: "look", images: undefined }]);
  });
});
