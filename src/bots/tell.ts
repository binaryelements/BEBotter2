import { createSdkMcpServer, tool } from "../engine/mcp.js";
import type { McpServerHandle } from "../engine/mcp.js";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { mayUseDefinition } from "../admin/access.js";
import type { Db } from "../db/client.js";
import { chats } from "../db/schema.js";
import type { BotDefinition, Person } from "../db/schema.js";
import { botTitle } from "../teams/cards.js";
import { getDefinition, listDefinitions } from "./definitions.js";

/** The told bot's turn: the same chat and person, the target bot, one hop deeper. */
export type TellRun = (input: {
  tenantId: string;
  chatId: string;
  definition: BotDefinition;
  person: Person;
  text: string;
  askConfirmation: (req: never) => Promise<void>;
  graphToken?: () => Promise<string | undefined>;
  relay: number;
}) => Promise<{ text: string }>;

export type TellCtx = {
  tenantId: string;
  chatId: string;
  definitionId: string;
  /** Read at call time: the turn running now, if any. */
  readonly person: Person | undefined;
  readonly relay: number;
  readonly askConfirmation: ((req: never) => Promise<void>) | undefined;
};

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const no = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });
const MAX_MESSAGE = 4000;

/** `tell_bot`: one bot hands a message to another, which acts on it as the same person and answers back. */
export function tellMcpServer(deps: { db: Db; run: TellRun; personToken?: (chatId: string) => Promise<string | undefined> }, ctx: TellCtx): McpServerHandle {
  const { db } = deps;
  const tools = [
    tool(
      "tell_bot",
      "Pass a message to another of the company's bots, as the person you're talking to, and get its reply back. `bot` is its name (Mickey) or its role (IT Support). " +
        "Use it when the person asks you to tell, ask or hand something to another bot. The other bot acts on the message itself: it may use its own tools and ask the chat to confirm, " +
        "then its reply comes back to you to relay. Say everything it needs in `message`; it does not see this chat. One hop only: a bot that was told cannot tell further.",
      { bot: z.string(), message: z.string() },
      async ({ bot, message }) => {
        try {
          if (ctx.relay > 0) return no("Another bot passed this to you, so you can't pass it on; answer it yourself.");
          const { person } = ctx;
          if (!person) return no("No message is being answered.");
          if (!message.trim() || message.length > MAX_MESSAGE) return no(`The message must be 1 to ${MAX_MESSAGE} characters`);
          const caller = await getDefinition(db, ctx.tenantId, ctx.definitionId);
          if (!caller) return no("Not available");
          const all = (await listDefinitions(db, ctx.tenantId)).filter((d) => d.id !== caller.id);
          const want = bot.trim().toLowerCase();
          const target = all.find((d) => [d.displayName, d.label, d.name].some((n) => n && n.toLowerCase() === want));
          if (!target) {
            const usable = [];
            for (const d of all) if (await mayUseDefinition(db, ctx.tenantId, person.id, d.id)) usable.push(botTitle(d));
            return no(`No bot called "${bot}". ${usable.length ? `The bots ${person.name} can reach: ${usable.join("; ")}` : `${person.name} can reach no other bot`}`);
          }
          if (!(await mayUseDefinition(db, ctx.tenantId, person.id, target.id))) return no(`${person.name} can't use ${botTitle(target)}, so it can't be told for them.`);
          let graphToken: (() => Promise<string | undefined>) | undefined;
          if (target.identity === "person") {
            // the assistant acts with its owner's sign-in: only in the owner's own chat, with the token kept from their sign-in
            if (target.ownerPersonId && target.ownerPersonId !== person.id) return no(`${botTitle(target)} belongs to someone else.`);
            const [chat] = await db.select({ type: chats.conversationType, owner: chats.ownerPersonId }).from(chats).where(and(eq(chats.id, ctx.chatId), eq(chats.tenantId, ctx.tenantId)));
            if (chat?.type !== "personal" || chat.owner !== person.id) return no(`${botTitle(target)} is private to its owner and answers only in their own chat.`);
            const token = await deps.personToken?.(ctx.chatId).catch(() => undefined);
            if (!token) return no(`${person.name} must sign in to their assistant first (send it a message in this chat).`);
            graphToken = async () => deps.personToken!(ctx.chatId);
          }
          const text = `[${botTitle(caller)} passes this on for ${person.name}. Deal with it as if ${person.name} asked you, then reply; ${caller.displayName || caller.label} relays your reply to them.]\n\n${message}`;
          const r = await deps.run({ tenantId: ctx.tenantId, chatId: ctx.chatId, definition: target, person, text, askConfirmation: ctx.askConfirmation ?? (async () => {}), ...(graphToken ? { graphToken } : {}), relay: ctx.relay + 1 });
          return ok(`${botTitle(target)} replied:\n${r.text}`);
        } catch (e) {
          console.error("tell_bot failed", e instanceof Error ? e.message : e);
          return no("The other bot could not be reached.");
        }
      },
    ),
  ];
  return createSdkMcpServer({ name: "bots", tools });
}
