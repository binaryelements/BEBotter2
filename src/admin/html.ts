import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import type { Actor } from "./access.js";
import { isAdmin } from "./access.js";

export class SafeHtml {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

type Value = SafeHtml | string | number | boolean | null | undefined | readonly Value[];

const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => entities[c]);
const render = (v: Value): string =>
  v instanceof SafeHtml ? v.value : Array.isArray(v) ? v.map(render).join("") : v == null || v === false ? "" : escape(String(v));

export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  return new SafeHtml(strings.reduce((out, s, i) => out + s + (i < values.length ? render(values[i]) : ""), ""));
}

/** Trusted markup only; never pass user input. */
export const raw = (s: string) => new SafeHtml(s);

/** Per-request facts the shell needs but pages do not pass: set by the router. */
export type Shell = {
  theme?: string;
  path: string;
  url?: string;
  company?: string;
  flash?: { kind: "good" | "bad"; text: string };
  notifications?: { approvals: number; failures: number; items: { kind: "approval" | "failure"; title: string; meta: string; href: string }[] };
};
export const shell = new AsyncLocalStorage<Shell>();

export const assetsDir = fileURLToPath(new URL("./assets/", import.meta.url));
const version = readFileSync(`${assetsDir}be/VERSION`, "utf8").trim();

export const themes = ["dark", "light"] as const;
export const themeOf = (cookieHeader: string | undefined) => {
  const v = /(?:^|;\s*)theme=(\w+)/.exec(cookieHeader ?? "")?.[1];
  return themes.find((t) => t === v);
};

const groups = [
  {
    name: "Operate",
    items: [
      { label: "Dashboard", path: "overview", head: true, icon: "dashboard" },
      { label: "Bots", path: "bots", head: false, icon: "bots" },
      { label: "Personal assistants", path: "assistants", head: false, icon: "assistant" },
      { label: "To-dos", path: "todos", head: false, icon: "todos" },
      { label: "People", path: "people", head: true, icon: "people" },
      { label: "Connections", path: "connections", head: false, icon: "connections" },
      { label: "Runbooks", path: "runbooks", head: true, icon: "runbooks" },
      { label: "Shared notes", path: "knowledge", head: true, icon: "notes" },
    ],
  },
  {
    name: "Configure",
    items: [
      { label: "Assignments", path: "assignments", head: false, icon: "assignments" },
      { label: "Departments", path: "departments", head: true, icon: "departments" },
      { label: "Settings", path: "settings", head: false, icon: "settings" },
    ],
  },
  {
    name: "Audit",
    items: [{ label: "Activity", path: "activity", head: true, icon: "activity" }],
  },
];

const navIcons: Record<string, string> = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  bots: '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M9 7V5a3 3 0 0 1 6 0v2M9 12h.01M15 12h.01"/>',
  assistant: '<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M5 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/>',
  todos: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2"/>',
  people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  connections: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  runbooks: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  notes: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  assignments: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  departments: '<path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M15 9h.01M9 13h.01M15 13h.01M9 17h.01M15 17h.01"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  activity: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>',
};
const navIcon = (name: string) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${navIcons[name] ?? ""}</svg>`;

// The design system files change only on a re-sync (VERSION); the app's own stylesheet is versioned by its content.
const appCss = createHash("sha1").update(readFileSync(`${assetsDir}admin.css`)).digest("hex").slice(0, 8);
const href = (file: string) => `/admin/assets/${file}?v=${file === "admin.css" ? appCss : version}`;

// 16px line icons in the text colour: a screen (follow the device), a sun, a moon
const svg = (d: string) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const themeIcons: Record<string, string> = {
  device: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  light: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  dark: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
};

const toast = (flash: Shell["flash"]) =>
  flash
    ? html`<div class="be-toasts" role="status" aria-live="polite"><div class="be-toast ${flash.kind}"><span>${flash.text}</span><button class="be-toast-x" type="button" aria-label="dismiss" onclick="this.parentElement.remove()">×</button></div></div>`
    : "";

export function layout(opts: { title: string; body: SafeHtml; actor?: Actor; csrf?: string }): string {
  const { actor } = opts;
  const ctx = shell.getStore();
  const theme = ctx?.theme;
  const visible = (s: { head: boolean }) => !!actor && (isAdmin(actor) || (s.head && actor.headOf.length > 0));
  const menu = groups
    .map((g) => ({ ...g, items: g.items.filter(visible) }))
    .filter((g) => g.items.length > 0)
    .map(
      (g) => html`<div class="nav-group">${g.name ? html`<div class="nav-label nh">${g.name}</div>` : ""}${g.items.map((s) => {
        const on = ctx?.path === `/admin/${s.path}` || (s.path === "overview" && ctx?.path === "/admin") || ctx?.path.startsWith(`/admin/${s.path}/`);
        return html`<a href="/admin/${s.path}" class="nav-item${on ? " active" : ""}"${on ? raw(' aria-current="page"') : ""}>${raw(navIcon(s.icon))}${s.label}</a>`;
      })}</div>`,
    );
  const pick = (v: string, label: string) =>
    html`<button class="be-btn sm icon" name="set" value="${v}" aria-label="${label}" title="${label}" aria-pressed="${String((theme ?? "device") === v)}">${raw(themeIcons[v])}</button>`;
  const initials = (actor?.name ?? "?").split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const role = actor ? (isAdmin(actor) ? "admin" : "head") : "";
  const brand = html`<a class="brand" href="/admin"><img class="be-mark-dark" src="${href("be/be-mark-cyan.png")}" alt=""><img class="be-mark-light" src="${href("be/be-mark-red.png")}" alt=""><span>TEAMMATE<span class="by">by Binary Elements</span></span></a>`;
  const themeForm = html`<form class="theme" method="get" action="/admin/theme" aria-label="theme"><input type="hidden" name="next" value="${ctx?.url ?? ctx?.path ?? "/admin"}">${pick("device", "follow device")}${pick("light", "light")}${pick("dark", "dark")}</form>`;
  const n = ctx?.notifications;
  const notifCount = (n?.approvals ?? 0) + (n?.failures ?? 0);
  const notif = html`<details class="notif"><summary class="icon-btn" aria-label="Notifications" title="Notifications"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>${notifCount ? html`<span class="dot"></span>` : ""}</summary><div class="panel"><div class="panel-head"><b>Notifications</b>${notifCount ? html`<span class="be-chip bad">${notifCount} new</span>` : ""}<a class="be-btn sm quiet" href="/admin/activity">All activity</a></div><div class="panel-list">${n?.items.length ? n.items.map((item) => html`<a class="panel-item" href="${item.href}"><div class="ico ${item.kind === "failure" ? "bad" : "warn"}">${raw(item.kind === "failure" ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 8v4M12 16h.01"/><circle cx="12" cy="12" r="9"/></svg>')}</div><div class="grow"><b>${item.title}</b><div class="meta">${item.meta}</div></div></a>`) : html`<div class="panel-empty">Nothing needs attention.</div>`}</div></div></details>`;
  const head = html`<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${opts.title}</title><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet"><link rel="stylesheet" href="${href("be/tokens.css")}"><link rel="stylesheet" href="${href("be/components.css")}"><link rel="stylesheet" href="${href("admin.css")}"></head>`;
  if (!menu.length) {
    return html`<!doctype html>
<html lang="en"${theme ? raw(` data-theme="${theme}"`) : ""}>
${head}
<body class="be">
<div class="app signed-out"><div class="main"><header class="topbar">${brand}</header><main class="content">${opts.body}</main></div></div>
${toast(ctx?.flash)}
${raw(SHELL_SCRIPT)}
</body>
</html>`.value;
  }
  return html`<!doctype html>
<html lang="en"${theme ? raw(` data-theme="${theme}"`) : ""}>
${head}
<body class="be">
<input type="checkbox" id="nav-open" class="nav-open" aria-label="menu">
<div class="app">
<aside class="sidebar">
${brand}
<nav class="be-nav nav" aria-label="admin">${menu}</nav>
<div class="spacer"></div>
<div class="user"><div class="avatar">${initials}</div><div class="whoami"><b>${actor?.name ?? ""}</b><span>${role}${ctx?.company ? ` · ${ctx.company}` : ""}</span></div>${actor && opts.csrf ? html`<form method="post" action="/admin/auth/logout"><input type="hidden" name="csrf" value="${opts.csrf}"><button class="out" type="submit" aria-label="sign out" title="sign out"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg></button></form>` : ""}</div>
</aside>
<div class="main">
<header class="topbar">
<label for="nav-open" class="icon-btn burger" title="menu" aria-label="menu"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></label>
<div class="crumb">${ctx?.company ? html`<span>${ctx.company}</span><span class="sep">/</span>` : ""}<b>${opts.title}</b></div>
<form class="search" method="get" action="/admin/activity" role="search"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><input type="search" name="q" placeholder="Search activity…" aria-label="Search activity"><kbd>⌘K</kbd></form>
${notif}
${themeForm}
</header>
<main class="content">${opts.body}</main>
</div>
</div>
${toast(ctx?.flash)}
${raw(SHELL_SCRIPT)}
</body>
</html>`.value;
}

/**
 * Two conveniences, both optional: a form marked data-autosave submits when a control changes (its save button hides),
 * and every table's cells learn their column name so a phone can show rows as cards. Without script the buttons stay.
 */
const SHELL_SCRIPT = `<script>
document.documentElement.classList.add("js");
document.addEventListener("change", function (e) { var f = e.target && e.target.closest && e.target.closest("form[data-autosave]"); if (f) f.requestSubmit(); });
document.addEventListener("keydown", function (e) {
  if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === "k") {
    var s = document.querySelector(".search input");
    if (s) { e.preventDefault(); s.focus(); s.select(); }
  }
});
document.querySelectorAll(".nav-item").forEach(function (a) {
  a.addEventListener("click", function () { var c = document.getElementById("nav-open"); if (c) c.checked = false; });
});
document.addEventListener("click", function (e) {
  var d = document.querySelector("details.notif[open]");
  if (d && !d.contains(e.target)) d.open = false;
});
document.querySelectorAll("table.be-table").forEach(function (t) {
  var heads = Array.from(t.querySelectorAll("thead th")).map(function (th) { return th.textContent.trim(); });
  if (!heads.length) return;
  t.querySelectorAll("tbody tr").forEach(function (tr) { Array.from(tr.children).forEach(function (td, i) { if (heads[i]) td.setAttribute("data-l", heads[i]); }); });
});
</script>`;

/** In a form marked data-autosave: the save button hides and a change submits it. */
export const AUTO = html`<input type="hidden" name="autosave" value="1">`;

const chipClass: Record<string, string> = { done: "g", pending: "w", denied: "b", failed: "b", changed: "c" };
/** A status always shows its word; colour only adds to it. */
export const chip = (status: string) => html`<span class="be-chip ${chipClass[status] ?? ""}">${status}</span>`;

export const pageHead = (title: string, act?: SafeHtml) =>
  html`<header class="be-pagehead"><div class="pt"><h1>${title}</h1></div>${act ? html`<div class="act">${act}</div>` : ""}</header>`;

/** A table in a box that scrolls sideways on a phone instead of the page. */
export const scroll = (table: SafeHtml) => html`<div class="scroll">${table}</div>`;
