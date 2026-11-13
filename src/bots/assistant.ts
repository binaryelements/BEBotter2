import { createSdkMcpServer, tool } from "../engine/mcp.js";
import type { McpServerHandle } from "../engine/mcp.js";
import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { assistantRequests, botDefinitions, people } from "../db/schema.js";
import { addTodo } from "../todos/store.js";
import { DirectoryError } from "../org/directory.js";

export type AssistantCtx = {
  tenantId: string;
  definitionId: string;
  readonly personId: string | undefined;
  readonly person: { id: string; name: string } | undefined;
};

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const no = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });
const MAX = 4000;

/**
 * One person's assistant asks another person's assistant. The request body is the only thing shared:
 * no memory, no chat history, no Graph data. The receiving assistant asks its owner before acting.
 */
export function assistantMcpServer(deps: { db: Db }, ctx: AssistantCtx): McpServerHandle {
  const { db } = deps;
  const tools = [
    tool(
      "ask_assistant",
      "Ask another person's personal assistant to do something for its owner, e.g. add a to-do or check a date. " +
        "`to` is the person's name or email. `request` is the whole request; the other assistant does not see this chat or your owner's memory. " +
        "A `kind: \"todo\"` request is low risk and is added to their list at once; any other request waits for their owner to accept it. " +
        "Use it only when the request is for that person, not for your own owner.",
      { to: z.string(), request: z.string(), kind: z.enum(["request", "todo"]).optional(), dueAt: z.string().optional() },
      async ({ to, request, kind, dueAt }) => {
        try {
          const personId = ctx.personId;
          if (!personId) return no("No message is being answered.");
          if (!request.trim() || request.length > MAX) return no(`The request must be 1 to ${MAX} characters`);
          const [sender] = await db.select().from(botDefinitions).where(and(eq(botDefinitions.id, ctx.definitionId), eq(botDefinitions.tenantId, ctx.tenantId)));
          if (!sender || sender.identity !== "person" || sender.ownerPersonId !== personId) return no("Only a personal assistant can ask another assistant.");
          const want = to.trim().toLowerCase();
          const [byPerson] = await db
            .select()
            .from(people)
            .where(and(eq(people.tenantId, ctx.tenantId), or(sql`lower(${people.name}) = ${want}`, sql`lower(${people.email}) = ${want}`)));
          let recipient = byPerson;
          // an assistant's own name: "Jasmine" is Pat's assistant, so asking Jasmine is asking Pat
          if (!recipient) {
            const [byAssistant] = await db
              .select({ owner: people })
              .from(botDefinitions)
              .innerJoin(people, eq(people.id, botDefinitions.ownerPersonId))
              .where(and(eq(botDefinitions.tenantId, ctx.tenantId), eq(botDefinitions.identity, "person"), sql`lower(${botDefinitions.displayName}) = ${want}`));
            recipient = byAssistant?.owner;
          }
          // "Pat" for Patricia: only when exactly one person starts that way
          if (!recipient) {
            const named = await db
              .select()
              .from(people)
              .where(and(eq(people.tenantId, ctx.tenantId), sql`lower(split_part(${people.name}, ' ', 1)) = ${want}`));
            if (named.length === 1) recipient = named[0];
          }
          if (!recipient) return no(`No person or assistant called "${to}". Use the person's full name or email, or the name of their assistant.`);
          if (recipient.id === personId) return no("That is your own owner; just do it yourself.");
          const [target] = await db
            .select()
            .from(botDefinitions)
            .where(and(eq(botDefinitions.tenantId, ctx.tenantId), eq(botDefinitions.ownerPersonId, recipient.id), eq(botDefinitions.identity, "person")));
          if (!target) return no(`${recipient.name} has no personal assistant.`);
          const id = crypto.randomUUID();
          const todo = kind === "todo";
          await db.insert(assistantRequests).values({
            id,
            tenantId: ctx.tenantId,
            fromDefinitionId: sender.id,
            toDefinitionId: target.id,
            fromPersonId: personId,
            toPersonId: recipient.id,
            kind: kind ?? "request",
            body: request.trim(),
          });
          if (todo) {
            // a to-do is low risk: add it straight away, then record that the request needed no approval
            try {
              const t = await addTodo(db, { tenantId: ctx.tenantId, personId: recipient.id, definitionId: target.id, requestId: id, title: request.trim().slice(0, 200), details: request.trim(), dueAt });
              await db.update(assistantRequests).set({ status: "accepted", resolvedAt: new Date() }).where(eq(assistantRequests.id, id));
              return ok(`Added to ${recipient.name}'s to-dos as #${t.id}: ${t.title}. ${recipient.name}'s assistant will tell them.`);
            } catch (e) {
              return no(`Sent to ${recipient.name}'s assistant, but the to-do could not be added: ${e instanceof DirectoryError ? e.message : "unknown error"}. It will ask ${recipient.name} first.`);
            }
          }
          return ok(`Sent to ${recipient.name}'s assistant. It will ask ${recipient.name} before acting.`);
        } catch (e) {
          console.error("ask_assistant failed", e instanceof Error ? e.message : e);
          return no("The other assistant could not be reached.");
        }
      },
    ),
    tool(
      "my_requests",
      "List requests other people's assistants have sent to your owner and that are waiting for an answer. " +
        "Tell your owner who asked and what they want, then use resolve_request only after your owner says yes or no.",
      {},
      async () => {
        try {
          const personId = ctx.personId;
          if (!personId) return no("No message is being answered.");
          const rows = await db
            .select({ id: assistantRequests.id, body: assistantRequests.body, kind: assistantRequests.kind, from: people.name, at: assistantRequests.createdAt })
            .from(assistantRequests)
            .innerJoin(people, eq(people.id, assistantRequests.fromPersonId))
            .where(and(eq(assistantRequests.tenantId, ctx.tenantId), eq(assistantRequests.toDefinitionId, ctx.definitionId), eq(assistantRequests.status, "pending")))
            .orderBy(assistantRequests.createdAt);
          if (!rows.length) return ok("No requests are waiting.");
          return ok(rows.map((r) => `#${r.id} from ${r.from} (${r.kind}): ${r.body}`).join("\n"));
        } catch (e) {
          console.error("my_requests failed", e instanceof Error ? e.message : e);
          return no("The requests could not be read.");
        }
      },
    ),
    tool(
      "resolve_request",
      "Accept or decline a request from another person's assistant. Only do this after your owner has said yes or no. " +
        "If you accept, the request body tells you what to do; do it with your own tools, then tell your owner.",
      { id: z.string(), accept: z.boolean() },
      async ({ id, accept }) => {
        try {
          const personId = ctx.personId;
          if (!personId) return no("No message is being answered.");
          const [row] = await db
            .select()
            .from(assistantRequests)
            .where(and(eq(assistantRequests.id, id), eq(assistantRequests.tenantId, ctx.tenantId), eq(assistantRequests.toDefinitionId, ctx.definitionId), eq(assistantRequests.status, "pending")));
          if (!row) return no("That request is not waiting for you.");
          await db.update(assistantRequests).set({ status: accept ? "accepted" : "declined", resolvedAt: new Date() }).where(eq(assistantRequests.id, id));
          return ok(accept ? `Accepted. Do this now: ${row.body}` : "Declined.");
        } catch (e) {
          console.error("resolve_request failed", e instanceof Error ? e.message : e);
          return no("The request could not be updated.");
        }
      },
    ),
  ];
  return createSdkMcpServer({ name: "assistant", tools });
}
