import { AgentApplication, CardFactory, CloudAdapter, MessageFactory } from "@microsoft/agents-hosting";
import type { TurnState } from "@microsoft/agents-hosting";
import type { Db } from "../db/client.js";
import type { Confirmations } from "../engine/confirm.js";
import type { RunResult, RunTurnInput } from "../engine/runner.js";
import { findPersonId } from "../org/org.js";
import { resultCard } from "./cards.js";
import { clickPayload, handleConfirmClick, handleMessage, membersAddedGreeting, tenantBotName } from "./handlers.js";

export type TeamsAppDeps = {
  db: Db;
  runTurn: (turn: RunTurnInput) => Promise<RunResult>;
  confirmations: Confirmations;
  botName: string;
};

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
        conversationReference: ctx.activity.getConversationReference(),
      },
      async (text) => void (await ctx.sendActivity(text)),
      async (card) => void (await ctx.sendActivity(MessageFactory.attachment(CardFactory.adaptiveCard(card)))),
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
