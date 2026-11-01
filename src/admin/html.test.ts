import { describe, expect, it } from "vitest";
import { html, layout, raw, shell } from "./html.js";
import type { Actor } from "./access.js";

const actor = (over: Partial<Actor>): Actor => ({ personId: "p", tenantId: "t", name: "Ann", role: "user", headOf: [], ...over });

describe("html", () => {
  it("escapes interpolated strings and leaves raw markup alone", () => {
    const v = `<script>alert("x")</script>&'`;
    expect(html`<p title="${v}">${v}</p>${raw("<b>ok</b>")}`.value).toBe(
      `<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;</p><b>ok</b>`,
    );
  });

  it("joins arrays and nested templates", () => {
    expect(html`<ul>${["<a>", "b"].map((s) => html`<li>${s}</li>`)}</ul>`.value).toBe("<ul><li>&lt;a&gt;</li><li>b</li></ul>");
  });

  it("layout shows the admin every screen and a head only theirs", () => {
    const all = layout({ title: "T", body: html`x`, actor: actor({ role: "admin" }), csrf: "tok" });
    for (const s of ["Bots", "People", "Departments", "Assignments", "Activity", "Settings"]) expect(all).toContain(`>${s}</a>`);
    expect(all).toContain(`name="csrf" value="tok"`);
    expect(all).toContain("Ann");
    const head = layout({ title: "T", body: html`x`, actor: actor({ headOf: ["d"] }) });
    expect(head).toContain(">Departments</a>");
    expect(head).toContain(">People</a>");
    expect(head).toContain(">Activity</a>");
    for (const s of ["Bots", "Assignments", "Settings"]) expect(head).not.toContain(`>${s}</a>`);
  });

  it("layout wears the design system: brand, stylesheets, grouped menu, theme", () => {
    const page = layout({ title: "T", body: html`x`, actor: actor({ role: "admin" }), csrf: "tok" });
    expect(page).toContain('<body class="be">');
    for (const f of ["be/tokens.css", "be/components.css", "admin.css"]) expect(page).toMatch(new RegExp(`href="/admin/assets/${f}\\?v=\\w+"`));
    expect(page).toContain("TEAMMATE");
    expect(page).toContain("by Binary Elements");
    expect(page).toContain("be-mark-dark");
    expect(page).toContain("be-mark-light");
    for (const g of ["Bots", "People", "Audit"]) expect(page).toContain(`<div class="nh">${g}</div>`);
    expect(page).toContain(">Shared notes</a>");
    expect(page).not.toContain("data-theme");
    const head = layout({ title: "T", body: html`x`, actor: actor({ headOf: ["d"] }) });
    for (const s of ["Bots", "Assignments", "Settings"]) expect(head).not.toContain(`>${s}</a>`);
    expect(head).toContain(">Shared notes</a>");
    const signedOut = layout({ title: "T", body: html`x` });
    expect(signedOut).not.toContain("be-nav");
    const themed = shell.run({ theme: "light", path: "/admin/bots/b1", company: "Acme <b>" }, () => layout({ title: "T", body: html`x`, actor: actor({ role: "admin" }) }));
    expect(themed).toContain('<html lang="en" data-theme="light">');
    expect(themed).toContain('class="active" aria-current="page">Bots</a>');
    expect(themed).toContain("Acme &lt;b&gt;");
    expect(themed).toMatch(/aria-label="light" title="light" aria-pressed="true"><svg/);
    expect(themed).toMatch(/aria-label="follow device" title="follow device" aria-pressed="false"><svg/);
  });

  it("layout escapes the title and the name", () => {
    const page = layout({ title: "<x>", body: html``, actor: actor({ name: "<img>" }) });
    expect(page).not.toContain("<x>");
    expect(page).not.toContain("<img>");
  });
});
