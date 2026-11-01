import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageFactory, TurnContext } from "@microsoft/agents-hosting";
import type { CloudAdapter } from "@microsoft/agents-hosting";
import { assignToChat, upsertDefinition } from "../bots/definitions.js";
import { testDb } from "../db/test-db.js";
import { Confirmations } from "../engine/confirm.js";
import type { RunTurnInput } from "../engine/runner.js";
import { setPersonalBot } from "../org/directory.js";
import { upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { createTeamsApp, teamsStream } from "./app.js";

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

describe("sign-in for a person's own assistant", () => {
  afterEach(() => vi.restoreAllMocks());

  /** The real app over PGlite; only the Bot Framework's HTTP edges (connector, token service) are faked. */
  async function signInApp() {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const ann = await upsertPerson(db, { tenantId: "t1", aadObjectId: "aad-ann", name: "Ann" });
    await setPersonalBot(db, "t1", ann.id, true);
    const turns: RunTurnInput[] = [];
    const runTurn = vi.fn(async (turn: RunTurnInput) => {
      turns.push(turn);
      return { text: "reply", costUsd: 0, sessionId: "s", changed: false, auditId: "none", timings: { receivedAt: new Date().toISOString(), tools: 0 } };
    });
    const app = createTeamsApp({ db, runTurn, confirmations: new Confirmations(), botName: "Bot", defaultModel: "m", graphConnection: "graph" });
    const sent: { type?: string; text?: string; attachments?: { contentType?: string }[] }[] = [];
    vi.spyOn(app.adapter, "sendActivities").mockImplementation(async (_c, activities) => {
      sent.push(...activities);
      return activities.map((_, i) => ({ id: `r${sent.length}-${i}` }));
    });
    vi.spyOn(app.adapter, "updateActivity").mockImplementation(async () => undefined);
    let token: string | undefined;
    const tokenService = {
      getTokenOrSignInResource: vi.fn(async () => (token ? { tokenResponse: { token } } : { signInResource: { signInLink: "https://signin.example.test" } })),
      exchangeTokenAsync: vi.fn(async () => ({ token: (token = "tok-ann-secret") })),
      signOut: vi.fn(async () => void (token = undefined)),
    };
    const turnOf = (activity: object) => {
      const ctx = new TurnContext(app.adapter, Object.assign(MessageFactory.text(""), activity));
      ctx.turnState.set(app.adapter.UserTokenClientKey, tokenService);
      return ctx;
    };
    const base = { channelId: "msteams", serviceUrl: "https://smba.example.test", from: { id: "29:ann", aadObjectId: "aad-ann", name: "Ann" }, recipient: { id: "28:bot" } };
    // long-running turns continue on a proactive context; the real adapter would call the connector here
    vi.spyOn(app.adapter, "continueConversation").mockImplementation(async (_id, ref, logic) => {
      await logic(turnOf({ type: "event", name: "continueConversation", ...base, conversation: ref.conversation, from: ref.user, recipient: ref.agent }));
    });
    // a turn that throws ends in onTurnError, the way the adapter's middleware hands it on
    const say = (text: string, conversation = { id: "c1", conversationType: "personal", tenantId: "t1" }) => {
      const ctx = turnOf({ ...base, type: "message", id: `m-${text}`, text, conversation });
      return app.run(ctx).catch((err) => app.adapter.onTurnError(ctx, err));
    };
    const invoke = (name: string, value: object) =>
      app.run(turnOf({ ...base, type: "invoke", id: `i-${name}`, name, value, conversation: { id: "c1", conversationType: "personal", tenantId: "t1" } }));
    const oauthCards = () => sent.filter((a) => a.attachments?.some((x) => x.contentType === "application/vnd.microsoft.card.oauth"));
    const expire = () => void (token = undefined);
    return { db, app, runTurn, turns, sent, tokenService, say, invoke, oauthCards, expire };
  }

  it("a person turn without a token sends the sign-in card and runs no engine", async () => {
    const s = await signInApp();
    await s.say("what's on my calendar?");
    expect(s.oauthCards()).toHaveLength(1);
    expect(s.runTurn).not.toHaveBeenCalled();
  });

  it("after sign-in the pending text runs once, with the token fetched through the closure", async () => {
    const s = await signInApp();
    const logged: unknown[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a) => void logged.push(...a));
    await s.say("what's on my calendar?");
    await s.invoke("signin/tokenExchange", { id: "x1", connectionName: "graph", token: "sso-from-teams" });
    await vi.waitFor(() => expect(s.runTurn).toHaveBeenCalledTimes(1));
    await new Promise((res) => setTimeout(res, 20));
    expect(s.runTurn).toHaveBeenCalledTimes(1);
    expect(s.turns[0]!.text).toBe("what's on my calendar?");
    await expect(s.turns[0]!.graphToken!()).resolves.toBe("tok-ann-secret");
    await s.say("and tomorrow?"); // signed in: no second card
    await vi.waitFor(() => expect(s.runTurn).toHaveBeenCalledTimes(2));
    expect(s.oauthCards()).toHaveLength(1);
    expect(JSON.stringify(s.sent)).not.toContain("tok-ann-secret");
    expect(JSON.stringify(logged)).not.toContain("tok-ann-secret");
  });

  it("the sign-in card and a message typed while it waits use our copy", async () => {
    const s = await signInApp();
    await s.say("what's on my calendar?");
    const card = (s.oauthCards()[0]!.attachments![0] as { content?: { text?: string; buttons?: { title?: string }[] } }).content!;
    expect(card.text).toBe("Sign in so I can act as you in Microsoft 365.");
    expect(card.buttons?.[0]?.title).toBe("sign in");
    await s.say("hello?");
    expect(s.sent.at(-1)?.text).toBe("Finish signing in on the card above.");
    expect(s.runTurn).not.toHaveBeenCalled();
  });

  it("an expired token brings a fresh sign-in card and no turn", async () => {
    const s = await signInApp();
    await s.say("what's on my calendar?");
    await s.invoke("signin/tokenExchange", { id: "x1", connectionName: "graph", token: "sso-from-teams" });
    await vi.waitFor(() => expect(s.runTurn).toHaveBeenCalledTimes(1));
    s.expire();
    await s.say("and tomorrow?");
    expect(s.oauthCards()).toHaveLength(2);
    await new Promise((res) => setTimeout(res, 20));
    expect(s.runTurn).toHaveBeenCalledTimes(1);
  });

  it("a sign-in that throws says so, runs no turn and logs no token", async () => {
    const s = await signInApp();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    s.tokenService.getTokenOrSignInResource.mockRejectedValueOnce(Object.assign(new Error("token service down tok-ann-secret"), { statusCode: 503 }));
    await s.say("what's on my calendar?");
    expect(s.sent.map((a) => a.text)).toContain("Sign-in didn't work. Say anything to try again.");
    expect(s.runTurn).not.toHaveBeenCalled();
    expect(JSON.stringify(err.mock.calls)).not.toContain("tok-ann-secret");
  });

  it("a turn whose Graph call was refused signs the person out of graph, so the next message brings the card", async () => {
    const s = await signInApp();
    await s.say("what's on my calendar?");
    await s.invoke("signin/tokenExchange", { id: "x1", connectionName: "graph", token: "sso-from-teams" });
    await vi.waitFor(() => expect(s.runTurn).toHaveBeenCalledTimes(1));
    expect(s.tokenService.signOut).not.toHaveBeenCalled();
    // the token service still hands out the revoked token until the sign-out
    s.runTurn.mockImplementationOnce(async (turn: RunTurnInput) => {
      s.turns.push(turn);
      return { text: "reply", costUsd: 0, sessionId: "s", changed: false, auditId: "none", timings: { receivedAt: new Date().toISOString(), tools: 0 }, signInLost: true };
    });
    await s.say("and tomorrow?");
    await vi.waitFor(() => expect(s.tokenService.signOut).toHaveBeenCalledWith("29:ann", "graph", "msteams"));
    await s.say("and Friday?");
    await vi.waitFor(() => expect(s.oauthCards()).toHaveLength(2));
    await new Promise((res) => setTimeout(res, 20));
    expect(s.runTurn).toHaveBeenCalledTimes(2);
  });

  it("a service turn never asks", async () => {
    const s = await signInApp();
    await upsertChat(s.db, { id: "g1", tenantId: "t1", conversationType: "groupChat" });
    await assignToChat(s.db, "g1", (await upsertDefinition(s.db, Buffer.alloc(32), "t1", { name: "helper", label: "Helper", persona: "p" } as never)).id);
    await s.say("hello", { id: "g1", conversationType: "groupChat", tenantId: "t1" });
    await vi.waitFor(() => expect(s.runTurn).toHaveBeenCalledTimes(1));
    expect(s.turns[0]!.graphToken).toBeUndefined();
    expect(s.tokenService.getTokenOrSignInResource).not.toHaveBeenCalled();
    expect(s.oauthCards()).toEqual([]);
  });

  it("a failed sign-in says so and logs only the error code", async () => {
    const s = await signInApp();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await s.say("what's on my calendar?");
    await s.invoke("signin/failure", { code: "resourcematchfailed", message: "detail that may name the user" });
    expect(s.sent.map((a) => a.text)).toContain("Sign-in didn't work. Say anything to try again.");
    expect(s.runTurn).not.toHaveBeenCalled();
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).toContain("resourcematchfailed");
    expect(logged).not.toContain("detail that may name the user");
  });
});
