import express from "express";
import type { Request, Response, Router } from "express";
import type { Db } from "../db/client.js";
import {
  DirectoryError, createDepartment, deleteDepartment, listDepartments, listPeople, renameDepartment, setMembership, setPersonalBot, setRole,
} from "../org/directory.js";
import { isAdmin, loadActor, mayManageDepartment, mayManagePerson } from "./access.js";
import { html, layout } from "./html.js";
import type { SafeHtml } from "./html.js";
import { adminOf, wrap } from "./http.js";
import { page } from "./oidc.js";

const ROLES = ["user", "admin"] as const;
const STATES = ["none", "member", "head"] as const;

const field = (req: Request, name: string) => {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === "string" ? v : "";
};
const oneOf = <T extends string>(allowed: readonly T[], v: string): T => {
  if (!(allowed as readonly string[]).includes(v)) throw new DirectoryError("Invalid value");
  return v as T;
};
const nameOf = (req: Request) => {
  const name = field(req, "name").trim();
  if (!name) throw new DirectoryError("Name required");
  return name;
};
const options = (values: readonly string[], current?: string) =>
  values.map((v) => html`<option value="${v}" ${v === current ? "selected" : ""}>${v}</option>`);
const deny = (res: Response) => page(res, 403, "Not allowed.");

export function peopleRoutes(db: Db): Router {
  const router = express.Router();
  const render = (res: Response, title: string, body: SafeHtml) => {
    const { actor, csrf } = adminOf(res);
    res.type("html").send(layout({ title, body, actor, csrf }));
  };
  const csrfField = (res: Response) => html`<input type="hidden" name="csrf" value="${adminOf(res).csrf}">`;

  router.get(
    "/people",
    wrap(async (_req, res) => {
      const { actor } = adminOf(res);
      const admin = isAdmin(actor);
      const all = await listPeople(db, actor.tenantId);
      const rows = admin ? all : all.filter((p) => p.memberships.some((m) => actor.headOf.includes(m.departmentId)));
      const csrf = csrfField(res);
      render(
        res,
        "People",
        html`<h1>People</h1>
<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Personal bot</th><th>Departments</th></tr></thead><tbody>${rows.map((p) => {
          // Heads see only their own departments' people; none may edit their own row.
          const editable = admin || p.id !== actor.personId;
          return html`<tr><td>${p.name}</td><td>${p.email ?? ""}</td><td>${
            admin
              ? html`<form method="post" action="/admin/people/${p.id}/role">${csrf}<select name="role" aria-label="Role">${options(ROLES, p.role)}</select> <button>Save</button></form>`
              : p.role
          }</td><td>${
            editable
              ? html`<form method="post" action="/admin/people/${p.id}/personal-bot">${csrf}<input type="checkbox" name="personalBot" aria-label="Personal bot" ${p.personalBot ? "checked" : ""}> <button>Save</button></form>`
              : p.personalBot ? "On" : "Off"
          }</td><td>${p.memberships.map((m) => `${m.departmentName}${m.isHead ? " (head)" : ""}`).join(", ")}</td></tr>`;
        })}</tbody></table>`,
      );
    }),
  );

  router.post(
    "/people/:id/role",
    wrap(async (req, res) => {
      if (!isAdmin(adminOf(res).actor)) return deny(res);
      await setRole(db, adminOf(res).actor.tenantId, req.params.id, oneOf(ROLES, field(req, "role")));
      res.redirect(303, "/admin/people");
    }),
  );

  router.post(
    "/people/:id/personal-bot",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if ((!isAdmin(actor) && req.params.id === actor.personId) || !(await mayManagePerson(db, actor, req.params.id))) return deny(res);
      await setPersonalBot(db, actor.tenantId, req.params.id, field(req, "personalBot") === "on");
      res.redirect(303, "/admin/people");
    }),
  );

  router.get(
    "/departments",
    wrap(async (_req, res) => {
      const { actor } = adminOf(res);
      const admin = isAdmin(actor);
      const depts = (await listDepartments(db, actor.tenantId)).filter((d) => mayManageDepartment(actor, d.id));
      // Heads add people from across the tenant, so the select lists everyone.
      const everyone = await listPeople(db, actor.tenantId);
      const csrf = csrfField(res);
      const states = admin ? STATES : STATES.filter((s) => s !== "head");
      render(
        res,
        "Departments",
        html`<h1>Departments</h1>
<table><thead><tr><th>Name</th><th>Members</th><th></th></tr></thead><tbody>${depts.map(
          (d) => html`<tr><td>${
            admin
              ? html`<form method="post" action="/admin/departments/${d.id}/rename">${csrf}<input name="name" aria-label="Name" value="${d.name}" required> <button>Rename</button></form>
<form method="post" action="/admin/departments/${d.id}/delete">${csrf}<button class="secondary">Delete</button></form>`
              : d.name
          }</td><td>${d.members.map((m) => `${m.name}${m.isHead ? " (head)" : ""}`).join(", ")}</td><td><form method="post" action="/admin/departments/${d.id}/members">${csrf}<select name="personId" aria-label="Person">${everyone.map(
            (p) => html`<option value="${p.id}">${p.name}</option>`,
          )}</select> <select name="state" aria-label="Membership">${options(states, "member")}</select> <button>Save</button></form></td></tr>`,
        )}</tbody></table>${
          admin
            ? html`<form method="post" action="/admin/departments">${csrf}<input name="name" aria-label="Name" required> <button>Create</button></form>`
            : ""
        }`,
      );
    }),
  );

  router.post(
    "/departments",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      await createDepartment(db, actor.tenantId, nameOf(req));
      res.redirect(303, "/admin/departments");
    }),
  );

  router.post(
    "/departments/:id/rename",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      await renameDepartment(db, actor.tenantId, req.params.id, nameOf(req));
      res.redirect(303, "/admin/departments");
    }),
  );

  router.post(
    "/departments/:id/delete",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      await deleteDepartment(db, actor.tenantId, req.params.id);
      res.redirect(303, "/admin/departments");
    }),
  );

  router.post(
    "/departments/:id/members",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      const departmentId = req.params.id;
      const personId = field(req, "personId");
      const state = oneOf(STATES, field(req, "state"));
      if (!mayManageDepartment(actor, departmentId)) return deny(res);
      if (!isAdmin(actor)) {
        // A head adds and removes members; heads themselves, including their own row, are for admins.
        if (state === "head" || personId === actor.personId) return deny(res);
        if ((await loadActor(db, actor.tenantId, personId))?.headOf.includes(departmentId)) return deny(res);
      }
      await setMembership(db, actor.tenantId, departmentId, personId, state);
      res.redirect(303, "/admin/departments");
    }),
  );

  return router;
}
