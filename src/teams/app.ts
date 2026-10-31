import { AgentApplication, CardFactory, CloudAdapter, MessageFactory, StreamingResponseResult } from "@microsoft/agents-hosting";
import type { TurnContext, TurnState } from "@microsoft/agents-hosting";
import type { Db } from "../db/client.js";
import type { Confirmations } from "../engine/confirm.js";
import type { RunResult, RunTurnInput } from "../engine/runner.js";
import { findPersonId } from "../org/org.js";
import { resultCard } from "./cards.js";
import { clickPayload, handleConfirmClick, handleMessage, membersAddedGreeting, tenantBotName } from "./handlers.js";
import type { TeamsStream } from "./handlers.js";

export type TeamsAppDeps = {
  db: Db;
  runTurn: (turn: RunTurnInput) => Promise<RunResult>;
  confirmations: Confirmations;
  botName: string;
};

/** The turn's Teams stream. end throws unless the final message reached the chat, so the caller can send it another way. */
export function teamsStream(ctx: TurnContext): TeamsStream {
  return {
    informative: (text) => ctx.streamingResponse.queueInformativeUpdate(text),
    chunk: (text) => ctx.streamingResponse.queueTextChunk(text),
    end: async (finalText) => {
      // the stream swallows send failures, even the final message's, and still reports success; watch that send ourselves
      let landed = false;
      const watch = async <T>(activities: { type?: string; text?: string }[], next: () => Promise<T>) => {
        const r = await next();
        if (activities.some((a) => a.type === "message" && a.text === finalText)) landed = true;
        return r;
      };
      ctx.onSendActivities((_c, activities, next) => watch(activities, next));
      ctx.onUpdateActivity((_c, activity, next) => watch([activity], next)); // a stream past Teams' time limit ends with an edit
      ctx.streamingResponse.setFinalMessage(MessageFactory.text(finalText));
      const result = await ctx.streamingResponse.endStream();
      if (result !== StreamingResponseResult.Success || !landed) throw new Error(`stream ended: ${landed ? result : "final message not sent"}`);
    },
  };
}

export function createTeamsApp(deps: TeamsAppDeps): AgentApplication<TurnState> {
  // longRunningMessages answers the HTTP request at once; a turn can wait minutes on a confirmation card
  // startServer reuses app.adapter, so proactive sends go through the same adapter as replies
  const app = new AgentApplication<TurnState>({ adapter: new CloudAdapter(), startTypingTimer: true, removeRecipientMention: true, longRunningMessages: true });

  app.onConversationUpdate("membersAdded", async (ctx) => {
    const botId = ctx.activity.recipient?.id;
    if (!ctx.activity.membersAdded?.some((m) => m.id === botId)) return;
    const tenantId = ctx.activity.conversation?.tenantId;
    await ctx.sendActivity(membersAddedGreeting(tenantId ? await tenantBotName(deps.db, tenantId, deps.botName) : deps.botName));
  });

  app.onActivity("message", async (ctx) => {
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
      },
    );
  });

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

  return app;
}
