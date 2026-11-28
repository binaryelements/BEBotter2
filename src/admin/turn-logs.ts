import express from "express";
import type { Router } from "express";
import { and, eq } from "drizzle-orm";
import { getDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { turnLogs, workflowRuns } from "../db/schema.js";
import type { EngineMessage, RawExchange } from "../engine/engine.js";
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

// line breaks inside values (an email body) are shown as breaks, so the text reads as written
const json = (v: unknown) => {
  try {
    return (JSON.stringify(v, null, 2) ?? "").replace(/(?<!\\)\\n/g, "\n");
  } catch {
    return String(v);
  }
};

// a write held for a person's approval comes back to the AI as an error result, but nothing went wrong
const HELD = /^Sent for approval\b/;

/** One message as a person reads it. `userTitle` names a user message; a tool result is named after the call it answers. */
function message(m: EngineMessage, callName: Map<string, string>, userTitle: string): SafeHtml[] {
  if (m.role === "user") return [block(userTitle === "Image from a tool" ? "tool" : "sent", userTitle, m.text || "[image]")];
  if (m.role === "tool") {
    const name = callName.get(m.toolCallId) ?? "tool";
    if (HELD.test(m.text)) return [block("tool", html`<code>${name}</code> held for approval`, m.text)];
    return [block("tool", html`<code>${name}</code> returned${m.isError ? " an error" : ""}`, m.text, !!m.isError)];
  }
  return [
    ...(m.text ? [block("ai", "AI said", m.text)] : []),
    ...(m.toolCalls ?? []).map((c) => block("call", html`AI called <code>${c.name}</code>`, json(c.input))),
  ];
}

const exact = (v: unknown) => JSON.stringify(v, null, 2) ?? "";
const kb = (v: unknown) => `${Math.max(1, Math.round(exact(v).length / 1000)).toLocaleString("en-AU")} KB`;

/** Every call's full request body and reply, for the download. */
const rawCalls = (raw: RawExchange) =>
  raw.calls.map((c, i) => ({ call: i + 1, request: { ...raw.request, messages: raw.messages.slice(0, c.sent) }, reply: c.reply ?? null, ...(c.error ? { error: c.error } : {}) }));

/** The raw section: the shared settings once, then per call only the messages new to it, so a long step stays readable. */
function rawSection(id: string, raw: RawExchange | null): SafeHtml {
  if (!raw) return html`<h2 class="tlog-h">Raw calls</h2><p class="muted">Raw calls weren't kept for this turn. It ran before they were saved.</p>`;
  const used = (u: unknown) => {
    const x = (u ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
    return x.prompt_tokens !== undefined ? ` · ${x.prompt_tokens} in · ${x.completion_tokens ?? 0} out` : "";
  };
  return html`<h2 class="tlog-h">Raw calls</h2>
<p class="meta">${raw.calls.length} ${raw.calls.length === 1 ? "call" : "calls"} to the AI. Each one sends the settings and tools below, plus the message list up to that point, exactly as JSON. <a href="/admin/turn-logs/${id}/raw.json" download>download JSON</a> has every call's full request.</p>
<details class="tlog-fold"><summary>Settings and tools · ${kb(raw.request)}</summary><pre>${exact(raw.request)}</pre></details>
${raw.calls.map((c, i) => {
    const from = i === 0 ? 0 : raw.calls[i - 1]!.sent;
    return html`<details class="tlog-fold"><summary>Call ${i + 1} · sent ${c.sent} messages${i ? ` (${c.sent - from} new)` : ""}${c.reply ? ` · ${c.reply.finish_reason ?? "no finish reason"}${used(c.reply.usage)}` : " · failed"}</summary>
<section class="tlog-msg tlog-sent"><h3>${i ? "new messages sent" : "messages sent"}</h3><pre>${exact(raw.messages.slice(from, c.sent))}</pre></section>
${c.reply ? html`<section class="tlog-msg tlog-ai"><h3>reply</h3><pre>${exact(c.reply)}</pre></section>` : ""}
${c.error ? html`<section class="tlog-msg bad"><h3>error</h3><pre>${c.error}</pre></section>` : ""}
</details>`;
  })}`;
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
${rawSection(log.id, log.raw)}
</div>`;
      res.type("html").send(layout({ title: "AI turn", body, actor, csrf }));
    }),
  );

  router.get(
    "/turn-logs/:id/raw.json",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      const [log] = isAdmin(actor) ? await db.select({ id: turnLogs.id, raw: turnLogs.raw }).from(turnLogs).where(and(eq(turnLogs.id, req.params.id), eq(turnLogs.tenantId, actor.tenantId))) : [];
      if (!log?.raw) return page(res, 404, "Not found.");
      res.set({ "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="ai-turn-${log.id}.json"`, "Cache-Control": "no-store" }).send(exact(rawCalls(log.raw)));
    }),
  );

  return router;
}
