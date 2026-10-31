import { describe, expect, it, vi } from "vitest";
import { MessageFactory, TurnContext } from "@microsoft/agents-hosting";
import type { CloudAdapter } from "@microsoft/agents-hosting";
import { teamsStream } from "./app.js";

/** A Teams turn whose adapter records what it sends; failFinal makes the stream's final message fail to send. */
function teamsTurn(failFinal: boolean) {
  const sent: { type?: string; text?: string; attachments?: { contentType?: string; content?: unknown }[] }[] = [];
  const adapter = {
    sendActivities: async (_ctx: unknown, activities: (typeof sent)[number][]) => {
      if (failFinal && activities.some((a) => a.type === "message")) throw new Error("503");
      sent.push(...activities.map(({ type, text, attachments }) => ({ type, text, ...(attachments?.length ? { attachments } : {}) })));
      return activities.map((_, i) => ({ id: `a${i}` }));
    },
    updateActivity: async () => {},
  } as unknown as CloudAdapter;
  const incoming = Object.assign(MessageFactory.text("hi"), {
    channelId: "msteams",
    id: "m1",
    serviceUrl: "https://smba.example.test",
    conversation: { id: "c1", conversationType: "personal" },
    from: { id: "u1" },
    recipient: { id: "b1" },
  });
  const ctx = new TurnContext(adapter, incoming);
  ctx.streamingResponse.setDelayInMs(0);
  return { ctx, sent };
}

describe("teamsStream", () => {
  it("ends with exactly the final text", async () => {
    const { ctx, sent } = teamsTurn(false);
    const stream = teamsStream(ctx);
    stream.chunk("Let me check.");
    await stream.end("The answer.");
    expect(sent.at(-1)).toEqual({ type: "message", text: "The answer." });
  });

  it("ends with a card as the final message, replacing the progress line", async () => {
    const { ctx, sent } = teamsTurn(false);
    const stream = teamsStream(ctx);
    stream.informative("Working: reply to email…");
    const card = { type: "AdaptiveCard", version: "1.5", body: [] };
    await stream.end("", card);
    expect(sent.at(-1)).toEqual({ type: "message", text: undefined, attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }] });
  });

  it("throws when the final message fails to send, though the stream reports success", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = teamsTurn(true);
    const stream = teamsStream(ctx);
    stream.chunk("Let me check.");
    await expect(stream.end("The answer.")).rejects.toThrow("final message not sent");
    vi.mocked(console.error).mockRestore();
  });
});
