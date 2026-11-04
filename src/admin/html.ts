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
export type Shell = { theme?: string; path: string; url?: string; company?: string };
export const shell = new AsyncLocalStorage<Shell>();

export const assetsDir = fileURLToPath(new URL("./assets/", import.meta.url));
const version = readFileSync(`${assetsDir}be/VERSION`, "utf8").trim();

export const themes = ["dark", "light"] as const;
export const themeOf = (cookieHeader: string | undefined) => {
  const v = /(?:^|;\s*)theme=(\w+)/.exec(cookieHeader ?? "")?.[1];
  return themes.find((t) => t === v);
};

const groups = [
  { name: "", items: [{ label: "Dashboard", path: "overview", head: true }] },
  { name: "Bots", items: [{ label: "Bots", path: "bots", head: false }, { label: "Assignments", path: "assignments", head: false }, { label: "Connections", path: "connections", head: false }, { label: "Shared notes", path: "knowledge", head: true }] },
  { name: "People", items: [{ label: "People", path: "people", head: true }, { label: "Departments", path: "departments", head: true }] },
  { name: "Audit", items: [{ label: "Activity", path: "activity", head: true }, { label: "Settings", path: "settings", head: false }] },
];

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

export function layout(opts: { title: string; body: SafeHtml; actor?: Actor; csrf?: string }): string {
  const { actor } = opts;
  const ctx = shell.getStore();
  const theme = ctx?.theme;
  const visible = (s: { head: boolean }) => !!actor && (isAdmin(actor) || (s.head && actor.headOf.length > 0));
  const menu = groups
    .map((g) => ({ ...g, items: g.items.filter(visible) }))
    .filter((g) => g.items.length > 0)
    .map(
      (g) => html`<div class="ng">${g.name ? html`<div class="nh">${g.name}</div>` : ""}${g.items.map((s) => {
        const on = ctx?.path === `/admin/${s.path}` || (s.path === "overview" && ctx?.path === "/admin") || ctx?.path.startsWith(`/admin/${s.path}/`);
        return html`<a href="/admin/${s.path}"${on ? raw(' class="active" aria-current="page"') : ""}>${s.label}</a>`;
      })}</div>`,
    );
  const pick = (v: string, label: string) =>
    html`<button class="be-btn sm icon" name="set" value="${v}" aria-label="${label}" title="${label}" aria-pressed="${String((theme ?? "device") === v)}">${raw(themeIcons[v])}</button>`;
  return html`<!doctype html>
<html lang="en"${theme ? raw(` data-theme="${theme}"`) : ""}>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${opts.title}</title><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet"><link rel="stylesheet" href="${href("be/tokens.css")}"><link rel="stylesheet" href="${href("be/components.css")}"><link rel="stylesheet" href="${href("admin.css")}"></head>
<body class="be">
<input type="checkbox" id="nav-open" class="nav-open" aria-label="menu">
<header class="be-top">${menu.length ? raw('<label for="nav-open" class="be-btn sm icon burger" title="menu"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></label>') : ""}<div class="be-brand"><img class="be-mark-dark" src="${href("be/be-mark-cyan.png")}" alt=""><img class="be-mark-light" src="${href("be/be-mark-red.png")}" alt="">TEAMMATE<span class="by">by Binary Elements</span></div><div class="who">${
    ctx?.company ? html`<span class="co">${ctx.company}</span>` : ""
  }${
    actor ? html`<span class="me"><b>${actor.name}</b> · ${isAdmin(actor) ? "admin" : "head"}</span>` : ""
  }<form method="get" action="/admin/theme" aria-label="theme"><input type="hidden" name="next" value="${ctx?.url ?? ctx?.path ?? "/admin"}">${pick("device", "follow device")}${pick("light", "light")}${pick("dark", "dark")}</form>${
    actor && opts.csrf
      ? html`<form method="post" action="/admin/auth/logout"><input type="hidden" name="csrf" value="${opts.csrf}"><button class="be-btn sm">sign out</button></form>`
      : ""
  }</div></header>
<div class="be-body">${menu.length ? html`<nav class="be-nav" aria-label="admin">${menu}</nav>` : ""}<main>${opts.body}</main></div>
</body>
</html>`.value;
}

const chipClass: Record<string, string> = { done: "g", pending: "w", denied: "b", failed: "b", changed: "c" };
/** A status always shows its word; colour only adds to it. */
export const chip = (status: string) => html`<span class="be-chip ${chipClass[status] ?? ""}">${status}</span>`;

export const pageHead = (title: string, act?: SafeHtml) =>
  html`<header class="be-pagehead"><div class="pt"><h1>${title}</h1></div>${act ? html`<div class="act">${act}</div>` : ""}</header>`;

/** A table in a box that scrolls sideways on a phone instead of the page. */
export const scroll = (table: SafeHtml) => html`<div class="scroll">${table}</div>`;
