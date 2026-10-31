import type { Request, Response } from "express";
import { html, layout } from "./html.js";
import { adminOf } from "./http.js";

/** A destructive action arms on the first press (this page) and acts on the second (confirm=yes); no script, no pop-up. */
export const isArmed = (req: Request) => (req.body as Record<string, unknown> | undefined)?.confirm === "yes";

export function armedPage(req: Request, res: Response, opts: { title: string; button: string; back: string }) {
  const { actor, csrf } = adminOf(res);
  // the second press re-posts what the first one carried
  const carried = Object.entries((req.body ?? {}) as Record<string, unknown>).filter(([k, v]) => k !== "csrf" && k !== "confirm" && typeof v === "string");
  const body = html`<header class="be-pagehead"><div class="pt"><h1>${opts.title}</h1></div></header><form method="post" action="${req.originalUrl}"><input type="hidden" name="csrf" value="${csrf}">${
    carried.map(([k, v]) => html`<input type="hidden" name="${k}" value="${String(v)}">`)
  }<input type="hidden" name="confirm" value="yes"><button class="be-btn armed">${opts.button}</button> <a href="${opts.back}">cancel</a></form>`;
  res.type("html").send(layout({ title: opts.title, body, actor, csrf }));
}
