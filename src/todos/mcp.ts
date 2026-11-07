import { createSdkMcpServer, tool } from "../engine/mcp.js";
import type { McpServerHandle } from "../engine/mcp.js";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { addTodo, completeTodo, deleteTodo, listTodos, updateTodo } from "./store.js";
import { DirectoryError } from "../org/directory.js";

export type TodoCtx = {
  tenantId: string;
  definitionId: string;
  readonly personId: string | undefined;
};

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const no = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });
const words = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "no due date");
const line = (t: { id: string; status: string; title: string; dueAt: Date | null }) => `#${t.id} ${t.status} — ${t.title} (${words(t.dueAt)})`;

/** The owner's own to-dos: add, list, complete, edit and remove. Never another person's. */
export function todoMcpServer(deps: { db: Db }, ctx: TodoCtx): McpServerHandle {
  const { db } = deps;
  const tools = [
    tool(
      "add_todo",
      "Add a to-do for your owner. Use it when they ask you to remember something, or when a request needs a task. `dueAt` is an ISO date or date-time, optional.",
      { title: z.string(), details: z.string().optional(), dueAt: z.string().optional() },
      async ({ title, details, dueAt }) => {
        try {
          const personId = ctx.personId;
          if (!personId) return no("No message is being answered.");
          const t = await addTodo(db, { tenantId: ctx.tenantId, personId, definitionId: ctx.definitionId, title, details, dueAt });
          return ok(`Added #${t.id}: ${t.title} (${words(t.dueAt)})`);
        } catch (e) {
          if (e instanceof DirectoryError) return no(e.message);
          console.error("add_todo failed", e instanceof Error ? e.message : e);
          return no("The to-do could not be added.");
        }
      },
    ),
    tool(
      "list_todos",
      "List your owner's to-dos. Use it when they ask what is on their list, what is due, or what is left.",
      { status: z.enum(["open", "done"]).optional(), limit: z.number().int().min(1).max(100).optional() },
      async ({ status, limit }) => {
        try {
          const personId = ctx.personId;
          if (!personId) return no("No message is being answered.");
          const rows = await listTodos(db, ctx.tenantId, personId, { status, limit });
          if (!rows.length) return ok(status === "done" ? "No done to-dos." : "No to-dos are open.");
          return ok(rows.map(line).join("\n"));
        } catch (e) {
          console.error("list_todos failed", e instanceof Error ? e.message : e);
          return no("The to-dos could not be read.");
        }
      },
    ),
    tool(
      "complete_todo",
      "Mark one of your owner's to-dos done, or open again. `id` is the id from list_todos or add_todo.",
      { id: z.string(), done: z.boolean().optional() },
      async ({ id, done }) => {
        try {
          const personId = ctx.personId;
          if (!personId) return no("No message is being answered.");
          const t = await completeTodo(db, ctx.tenantId, personId, id, done ?? true);
          if (!t) return no("No such to-do for your owner.");
          return ok(`${t.status === "done" ? "Done" : "Reopened"}: ${t.title}`);
        } catch (e) {
          console.error("complete_todo failed", e instanceof Error ? e.message : e);
          return no("The to-do could not be updated.");
        }
      },
    ),
    tool(
      "update_todo",
      "Change one of your owner's to-dos: title, details or due date.",
      { id: z.string(), title: z.string().optional(), details: z.string().optional(), dueAt: z.string().nullable().optional() },
      async ({ id, title, details, dueAt }) => {
        try {
          const personId = ctx.personId;
          if (!personId) return no("No message is being answered.");
          const t = await updateTodo(db, ctx.tenantId, personId, id, { title, details, dueAt });
          if (!t) return no("No such to-do for your owner.");
          return ok(`Updated: ${line(t)}`);
        } catch (e) {
          if (e instanceof DirectoryError) return no(e.message);
          console.error("update_todo failed", e instanceof Error ? e.message : e);
          return no("The to-do could not be updated.");
        }
      },
    ),
    tool(
      "delete_todo",
      "Remove one of your owner's to-dos. Ask them first unless they already said to delete it.",
      { id: z.string() },
      async ({ id }) => {
        try {
          const personId = ctx.personId;
          if (!personId) return no("No message is being answered.");
          await deleteTodo(db, ctx.tenantId, personId, id);
          return ok("Removed.");
        } catch (e) {
          console.error("delete_todo failed", e instanceof Error ? e.message : e);
          return no("The to-do could not be removed.");
        }
      },
    ),
  ];
  return createSdkMcpServer({ name: "todos", tools });
}
