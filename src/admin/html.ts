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
export type Shell = { theme?: string; path: string; company?: string };
export const shell = new AsyncLocalStorage<Shell>();

export const assetsDir = fileURLToPath(new URL("./assets/", import.meta.url));
const version = readFileSync(`${assetsDir}be/VERSION`, "utf8").trim();

export const themes = ["dark", "light"] as const;
export const themeOf = (cookieHeader: string | undefined) => {
  const v = /(?:^|;\s*)theme=(\w+)/.exec(cookieHeader ?? "")?.[1];
  return themes.find((t) => t === v);
};

const groups = [
  { name: "", items: [{ label: "Overview", path: "overview", head: true }] },
  { name: "Bots", items: [{ label: "Bots", path: "bots", head: false }, { label: "Assignments", path: "assignments", head: false }, { label: "Shared notes", path: "knowledge", head: true }] },
  { name: "People", items: [{ label: "People", path: "people", head: true }, { label: "Departments", path: "departments", head: true }] },
  { name: "Audit", items: [{ label: "Activity", path: "activity", head: true }, { label: "Settings", path: "settings", head: false }] },
];

const href = (file: string) => `/admin/assets/${file}?v=${version}`;

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
    html`<button class="be-btn sm" name="set" value="${v}" aria-pressed="${String((theme ?? "device") === v)}">${label}</button>`;
  return html`<!doctype html>
<html lang="en"${theme ? raw(` data-theme="${theme}"`) : ""}>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${opts.title}</title><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet"><link rel="stylesheet" href="${href("be/tokens.css")}"><link rel="stylesheet" href="${href("be/components.css")}"><link rel="stylesheet" href="${href("admin.css")}"></head>
<body class="be">
<header class="be-top"><div class="be-brand"><img class="be-mark-dark" src="${href("be/be-mark-cyan.png")}" alt=""><img class="be-mark-light" src="${href("be/be-mark-red.png")}" alt="">TEAM BOTTER<span class="by">by Binary Elements</span></div><div class="who">${
    ctx?.company ? html`<span>${ctx.company}</span>` : ""
  }${
    actor ? html`<span><b>${actor.name}</b> · ${isAdmin(actor) ? "admin" : "head"}</span>` : ""
  }<form method="get" action="/admin/theme" aria-label="theme"><input type="hidden" name="next" value="${ctx?.path ?? "/admin"}">${pick("device", "device")}${pick("light", "light")}${pick("dark", "dark")}</form>${
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
