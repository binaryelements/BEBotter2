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

const screens = [
  { label: "Bots", path: "bots", head: false },
  { label: "People", path: "people", head: true },
  { label: "Departments", path: "departments", head: true },
  { label: "Assignments", path: "assignments", head: false },
  { label: "Activity", path: "activity", head: true },
  { label: "Knowledge", path: "knowledge", head: true },
  { label: "Settings", path: "settings", head: false },
];

const css = `
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;color:#111;background:#fff;line-height:1.45}
header{display:flex;flex-wrap:wrap;gap:1rem;align-items:center;padding:.75rem 1rem;border-bottom:1px solid #ddd}
header nav{display:flex;flex-wrap:wrap;gap:1rem;flex:1}
a{color:#111}
header nav a{text-decoration:none}
header nav a:hover{text-decoration:underline}
main{padding:1rem;max-width:960px}
h1{font-size:1.3rem;margin:0 0 1rem}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid #eee;vertical-align:top}
th{font-weight:600;color:#555}
input,select,textarea,button{font:inherit}
input,select,textarea{border:1px solid #bbb;border-radius:4px;padding:.25rem .4rem}
textarea{width:100%;min-height:8rem}
button{border:1px solid #111;background:#111;color:#fff;border-radius:4px;padding:.25rem .75rem;cursor:pointer}
button.secondary{background:#fff;color:#111}
form.inline{display:inline}
.muted{color:#666}
.error{border:1px solid #111;padding:.5rem;margin-bottom:1rem}
`;

export function layout(opts: { title: string; body: SafeHtml; actor?: Actor; csrf?: string }): string {
  const { actor } = opts;
  const nav = actor ? screens.filter((s) => isAdmin(actor) || (s.head && actor.headOf.length > 0)) : [];
  return html`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${opts.title}</title><style>${raw(css)}</style></head>
<body>
<header><nav>${nav.map((s) => html`<a href="/admin/${s.path}">${s.label}</a>`)}</nav>${
    actor ? html`<span class="muted">${actor.name}</span>` : ""
  }${
    actor && opts.csrf
      ? html`<form class="inline" method="post" action="/admin/auth/logout"><input type="hidden" name="csrf" value="${opts.csrf}"><button class="secondary">Sign out</button></form>`
      : ""
  }</header>
<main>${opts.body}</main>
</body>
</html>`.value;
}
