import { AgentApplication, CardFactory, CloudAdapter, MemoryStorage, MessageFactory, StreamingResponseResult } from "@microsoft/agents-hosting";
import type { TurnContext, TurnState } from "@microsoft/agents-hosting";
import type { Db } from "../db/client.js";
import type { Confirmations } from "../engine/confirm.js";
import type { RunResult, RunTurnInput } from "../engine/runner.js";
import { findPersonId } from "../org/org.js";
import { resultCard } from "./cards.js";
import { choosePayload, clickPayload, handleChoose, handleConfirmClick, handleInstall, handleMessage, membersAddedGreeting, needsSignIn, signInFailed } from "./handlers.js";
import type { TeamsStream } from "./handlers.js";

export type TeamsAppDeps = {
  db: Db;
  runTurn: (turn: RunTurnInput) => Promise<RunResult>;
  confirmations: Confirmations;
  botName: string;
  defaultModel: string;
  /** The Azure Bot OAuth connection behind the `graph` sign-in. */
  graphConnection: string;
};

const FAILED_TO_SIGN_IN = -120510; // Errors.FailedToSignIn in agents-hosting 1.9.1

/** The signed-in person's Graph token for this turn's sender, or undefined; never stored. */
export const graphToken = async (app: AgentApplication<TurnState>, ctx: TurnContext): Promise<string | undefined> =>
  (await app.authorization.getToken(ctx, "graph")).token;

/** The turn's Teams stream. end throws unless the final message reached the chat, so the caller can send it another way. */
export function teamsStream(ctx: TurnContext): TeamsStream {
  return {
    informative: (text) => ctx.streamingResponse.queueInformativeUpdate(text),
    chunk: (text) => ctx.streamingResponse.queueTextChunk(text),
    end: async (finalText, card) => {
      // the stream swallows send failures, even the final message's, and still reports success; watch that send ourselves
      let landed = false;
      const isFinal = (a: { type?: string; text?: string; attachments?: unknown[] }) =>
        a.type === "message" && (a.text ?? "") === finalText && !!a.attachments?.length === !!card;
      // what the stream sent after end, without text: why a final message did not land is otherwise invisible
      const sent: string[] = [];
      type Sent = { type?: string; text?: string; attachments?: unknown[]; entities?: { type?: string; streamType?: string }[] };
      const watch = async <T>(activities: Sent[], next: () => Promise<T>) => {
        for (const a of activities) sent.push(`${a.type}/${a.entities?.find((e) => e.type === "streaminfo")?.streamType ?? "-"}/${a.text === finalText ? "same" : `len${a.text?.length ?? 0}`}`);
        const r = await next().catch((e: unknown) => {
          sent.push(`refused: ${e instanceof Error ? e.message.slice(0, 200) : "unknown"}`);
          throw e;
        });
        if (activities.some(isFinal)) landed = true;
        return r;
      };
      ctx.onSendActivities((_c, activities, next) => watch(activities, next));
      ctx.onUpdateActivity((_c, activity, next) => watch([activity], next)); // a stream past Teams' time limit ends with an edit
      if (card) {
        const attachment = CardFactory.adaptiveCard(card);
        ctx.streamingResponse.setFinalMessage(MessageFactory.attachment(attachment, finalText || undefined));
        ctx.streamingResponse.setAttachments([attachment]); // the final message takes its attachments from here
      } else ctx.streamingResponse.setFinalMessage(MessageFactory.text(finalText));
      const result = await ctx.streamingResponse.endStream();
      if (result !== StreamingResponseResult.Success || !landed) throw new Error(`stream ended: ${landed ? result : "final message not sent"} [${sent.join(", ") || "nothing sent"}]`);
    },
  };
}

export function createTeamsApp(deps: TeamsAppDeps): AgentApplication<TurnState> {
  // longRunningMessages answers the HTTP request at once; a turn can wait minutes on a confirmation card
  // startServer reuses app.adapter, so proactive sends go through the same adapter as replies
  // the `graph` handler signs a person in (Teams SSO, else the OAuth card) on routes that ask for it; storage holds a pending sign-in's message
  // shortcut: MemoryStorage loses a pending sign-in on restart and keeps per-conversation turn state without bound; upgrade to Postgres-backed storage when that matters
  const app = new AgentApplication<TurnState>({
    adapter: new CloudAdapter(), startTypingTimer: true, removeRecipientMention: true, longRunningMessages: true,
    storage: new MemoryStorage(),
    authorization: {
      graph: {
        azureBotOAuthConnectionName: deps.graphConnection,
        title: "sign in",
        text: "Sign in so I can act as you in Microsoft 365.",
        invalidSignInRetryMessageFormat: "Finish signing in on the card above.", // what a message typed while the card waits gets
        // a wrong code, or too many messages while the card waits: the SDK ends the sign-in, so the next message starts over
        invalidSignInRetryMessage: signInFailed,
        invalidSignInRetryMaxExceededMessage: signInFailed,
      },
    },
  });
  // the SDK default posts "please fix the source code" into the chat and logs nothing we can see; handlers already tell the user
  app.adapter.onTurnError = async (ctx, err) => {
    const e = err as { name?: string; message?: string; statusCode?: number; code?: unknown };
    // the SDK wraps any throw from a sign-in handler as FailedToSignIn; `graph` is our only handler
    if (e?.code === FAILED_TO_SIGN_IN || String(e?.message ?? "").startsWith("[handler:graph]")) {
      console.error(`sign-in failed in ${ctx.activity.conversation?.id ?? "?"}: ${String(e?.code ?? "unknown")}`);
      if (ctx.activity.type === "message") await ctx.sendActivity(signInFailed).catch(() => console.error("sign-in failure reply not sent"));
      return;
    }
    console.error(`turn error in ${ctx.activity.conversation?.id ?? "?"}: ${e?.name ?? "Error"} ${e?.statusCode ?? ""} ${String(e?.message ?? "").slice(0, 300)}`);
  };

  app.onConversationUpdate("membersAdded", async (ctx) => {
    const botId = ctx.activity.recipient?.id;
    if (!ctx.activity.membersAdded?.some((m) => m.id === botId)) return;
    const tenantId = ctx.activity.conversation?.tenantId;
    if (!tenantId) return void (await ctx.sendActivity(membersAddedGreeting(deps.botName)));
    const from = ctx.activity.from;
    await handleInstall(
      deps,
      { tenantId, chatId: ctx.activity.conversation!.id, conversationType: ctx.activity.conversation?.conversationType ?? "personal", from: from?.aadObjectId ? { aadObjectId: from.aadObjectId, name: from.name ?? "" } : undefined },
      { send: async (text) => (await ctx.sendActivity(text))?.id, sendCard: async (card) => void (await ctx.sendActivity(MessageFactory.attachment(CardFactory.adaptiveCard(card)))) },
    );
  });

  // the SDK replays the message that started a sign-in once it succeeds, so nothing runs here
  app.onSignInFailure(async (ctx) => {
    const code = (ctx.activity.value as { code?: unknown } | undefined)?.code;
    console.error(`sign-in failed in ${ctx.activity.conversation?.id ?? "?"}: ${typeof code === "string" ? code.slice(0, 80) : "unknown"}`);
    await ctx.sendActivity(signInFailed);
  });

  const onMessage = (signedIn: boolean) => async (ctx: TurnContext, state: TurnState) => {
    const receivedAt = new Date();
    const { conversation, from } = ctx.activity;
    if (!conversation?.tenantId || !from?.aadObjectId) {
      console.warn(`skipped message without tenant or user id in chat ${conversation?.id}`);
      return;
    }
    const conversationType = conversation.conversationType ?? "personal";
    console.log(`chat ${conversation.id} (${conversationType})`);
    await handleMessage(
      deps,
      {
        tenantId: conversation.tenantId,
        chatId: conversation.id,
        conversationType,
        from: { aadObjectId: from.aadObjectId, name: from.name ?? "" },
        text: (ctx.activity.text ?? "").trim(),
        receivedAt,
        conversationReference: ctx.activity.getConversationReference(),
      },
      {
        send: async (text) => (await ctx.sendActivity(text))?.id,
        update: async (id, text) => {
          const activity = MessageFactory.text(text);
          activity.id = id; // the spread form loses the Activity class
          await ctx.updateActivity(activity);
        },
        sendCard: async (card) => void (await ctx.sendActivity(MessageFactory.attachment(CardFactory.adaptiveCard(card)))),
        // Teams streams in one-to-one chats only; the stream replies to the user's message even on this continued turn
        ...(conversationType === "personal" ? { stream: teamsStream(ctx) } : {}),
        ...(signedIn ? { graphToken: () => graphToken(app, ctx), signOut: () => app.authorization.signOut(ctx, state, "graph") } : {}),
      },
    );
  };
  // a message that will run the sender's own Personal signs in first; the route order makes it win
  // shortcut: 1.9.1 has no public way to drop a pending sign-in, so "switch" typed while the card waits counts as a wrong answer (the choose card shows once the retries run out), and a pending entry whose message no longer selects Personal (switched off, switched away) lingers until Personal is selected again and its retries run out; upgrade when the SDK exposes clearing it
  // the selector runs a few small queries, about twice per message (authorization, then routing)
  const personTurn = async (ctx: TurnContext) => {
    const { type, conversation, from, text } = ctx.activity;
    if (type !== "message" || !conversation?.tenantId || !from?.aadObjectId) return false;
    return needsSignIn(deps, { tenantId: conversation.tenantId, chatId: conversation.id, conversationType: conversation.conversationType ?? "personal", aadObjectId: from.aadObjectId, text: text ?? "" });
  };
  app.onActivity(personTurn, onMessage(true), ["graph"]);
  app.onActivity("message", onMessage(false));

  app.adaptiveCards.actionExecute<unknown>("confirm", async (ctx, _state, data) => {
    const { conversation, from } = ctx.activity;
    const personId =
      conversation?.tenantId && from?.aadObjectId ? await findPersonId(deps.db, conversation.tenantId, from.aadObjectId) : undefined;
    const text = await handleConfirmClick(
      deps.confirmations,
      clickPayload(data),
      personId,
      from?.name ?? "",
    );
    return resultCard(text) as { type: "AdaptiveCard" };
  });

  app.adaptiveCards.actionExecute<unknown>("choose", async (ctx, _state, data) => {
    const { conversation, from } = ctx.activity;
    const tenantId = conversation?.tenantId;
    const personId = tenantId && from?.aadObjectId ? await findPersonId(deps.db, tenantId, from.aadObjectId) : undefined;
    return (await handleChoose(deps, { tenantId: tenantId ?? "", chatId: conversation?.id ?? "", personId }, choosePayload(data))) as { type: "AdaptiveCard" };
  });

  return app;
}
