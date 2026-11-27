import express from "express";
import type { Router } from "express";
import { and, eq } from "drizzle-orm";
import { getDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { turnLogs, workflowRuns } from "../db/schema.js";
import type { EngineMessage } from "../engine/engine.js";
import { TOOL_TEXT_MAX, TURN_LOG_DAYS } from "../engine/turn-log.js";
import { publishedGraph } from "../workflows/store.js";
import { isAdmin } from "./access.js";
import { chatNames } from "./chat-names.js";
import { chip, html, layout } from "./html.js";
import type { SafeHtml } from "./html.js";
import { adminOf, wrap } from "./http.js";
import { page } from "./oidc.js";
import { whenFor } from "./words.js";

const block = (kind: string, title: SafeHtml | string, body: string, bad = false) =>
  html`<section class="tlog-msg tlog-${kind}${bad ? " bad" : ""}"><h3>${title}</h3><pre>${body}</pre></section>`;

const json = (v: unknown) => {
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch {
    return String(v);
  }
};

/** One message as a person reads it. `userTitle` names a user message; a tool result is named after the call it answers. */
function message(m: EngineMessage, callName: Map<string, string>, userTitle: string): SafeHtml[] {
  if (m.role === "user") return [block(userTitle === "Image from a tool" ? "tool" : "sent", userTitle, m.text || "[image]")];
  if (m.role === "tool") return [block("tool", html`<code>${callName.get(m.toolCallId) ?? "tool"}</code> returned${m.isError ? " an error" : ""}`, m.text, !!m.isError)];
  return [
    ...(m.text ? [block("ai", "AI said", m.text)] : []),
    ...(m.toolCalls ?? []).map((c) => block("call", html`AI called <code>${c.name}</code>`, json(c.input))),
  ];
}

/** An admin's view of one AI turn: the system prompt, what was sent and everything that came back. */
export function turnLogRoutes(db: Db): Router {
  const router = express.Router();

  router.get(
    "/turn-logs/:id",
    wrap(async (req, res) => {
      const { actor, csrf } = adminOf(res);
      // the log can hold anything a tool returned, costs and margins included, so heads don't see it
      const [log] = isAdmin(actor) ? await db.select().from(turnLogs).where(and(eq(turnLogs.id, req.params.id), eq(turnLogs.tenantId, actor.tenantId))) : [];
      if (!log) return page(res, 404, "Not found.");
      const def = await getDefinition(db, actor.tenantId, log.definitionId);
      const chats = await chatNames(db, actor.tenantId);
      const when = await whenFor(db, actor.tenantId);

      let runLink: SafeHtml | string = log.workflowRunId ?? "";
      let stepLabel = log.nodeId ?? "";
      if (log.workflowRunId) {
        const [run] = await db.select({ id: workflowRuns.id, title: workflowRuns.title, workflowId: workflowRuns.workflowId }).from(workflowRuns).where(and(eq(workflowRuns.id, log.workflowRunId), eq(workflowRuns.tenantId, actor.tenantId)));
        if (run) {
          const graph = await publishedGraph(db, run.workflowId);
          stepLabel = graph?.nodes.find((n) => n.id === log.nodeId)?.label ?? stepLabel;
          runLink = html`<a href="/admin/workflow-runs/${run.id}">${run.title}</a>`;
        }
      }

      const callName = new Map<string, string>();
      for (const m of log.messages) if (m.role === "assistant") for (const c of m.toolCalls ?? []) callName.set(c.id, c.name);
      const sent = Math.min(log.sentCount, log.messages.length);
      const earlier = log.messages.slice(0, Math.max(0, sent - 1));
      const own = sent > 0 ? log.messages[sent - 1] : undefined;
      const reply = log.messages.slice(sent);

      const facts: [string, SafeHtml | string][] = [
        ["bot", def ? (def.displayName ? `${def.displayName} · ${def.label}` : def.label) : log.definitionId],
        ["chat", (log.chatId && chats.get(log.chatId)) || ""],
        ["started by", log.startedBy],
        ["when", when(log.createdAt)],
        ...(log.workflowRunId ? ([["run", runLink], ["step", stepLabel]] as [string, SafeHtml | string][]) : []),
        ["model", log.model],
        ["ended", html`${chip(log.stopReason === "text" ? "done" : log.stopReason)}${log.error ? html` <span class="be-bad">${log.error}</span>` : ""}`],
        ["tokens", `${log.inputTokens ?? 0} in · ${log.outputTokens ?? 0} out`],
        ["cost", log.costUsd ? `US$${Number(log.costUsd).toFixed(4)}` : ""],
      ];
      const back = log.workflowRunId ? html`<a class="be-btn sm" href="/admin/workflow-runs/${log.workflowRunId}">back to the run</a>` : html`<a class="be-btn sm" href="/admin/activity">activity</a>`;
      const body = html`<header class="be-pagehead"><div class="pt"><h1>AI turn</h1><p class="meta">Everything sent to the AI and everything that came back. Kept ${TURN_LOG_DAYS} days. Tool results over ${TOOL_TEXT_MAX / 1000} KB are cut, and secret-looking values are hidden.</p></div><div class="act">${back}</div></header>
<dl class="tlog-facts">${facts.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
<div class="tlog">
<details class="tlog-fold"><summary>System prompt · ${log.systemPrompt.length.toLocaleString("en-AU")} characters</summary><pre>${log.systemPrompt}</pre></details>
${earlier.length ? html`<details class="tlog-fold"><summary>Earlier in the chat · ${earlier.length} messages</summary>${earlier.flatMap((m) => message(m, callName, "Earlier message"))}</details>` : ""}
${own ? message(own, callName, "Sent to the AI") : html`<p class="muted">The message sent to the AI isn't in this log.</p>`}
${reply.length ? reply.flatMap((m) => message(m, callName, "Image from a tool")) : html`<p class="muted">Nothing came back.</p>`}
</div>`;
      res.type("html").send(layout({ title: "AI turn", body, actor, csrf }));
    }),
  );

  return router;
}
