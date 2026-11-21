# Workflows part 2: builder, status page, trace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins build, publish and watch workflows in the admin site: a Workflows tab on the bot, a canvas per workflow, a status page per workflow with per-run actions, and Trace a run.

**Architecture:** The canvas is a small React app (`canvas/`, copied in shape from BE Voice `adminui/canvas`) bundled by esbuild into `src/admin/assets/workflows/canvas.js` + `canvas.css`, committed like BE Voice's `static/canvas.js`. It mounts into a server-rendered admin page that embeds the draft as JSON and talks to JSON routes in a new `src/admin/workflows.ts`. Status and run pages are server-rendered with `html```, no React. Runtime additions (pause, end, versions, discard, stale-save guard) go in `src/workflows/`.

**Tech Stack:** TypeScript, Express, drizzle, vitest/PGlite (server); React 19.3.0, `@xyflow/react` 12.12.0, esbuild 0.28.2 (canvas, same pins as BE Voice).

**Spec:** `docs/superpowers/specs/2026-11-20-workflows-design.md` (sections Builder, Status page, Calls made after the builder check). Part 1 plan: `docs/superpowers/plans/2026-11-20-workflows-1-runtime.md`.

**Branch:** `feature/workflows-ui`, off `feature/workflows-design` (PR #50). Its PR targets `deploy/coolify-prod` after #50 merges; until then target `feature/workflows-design`.

## Global Constraints

- Copy rule: minimal words, lowercase buttons ("save", "publish", "discard", "pause", "end", "move"), quote every new visible string in the PR description.
- Canvas pins: `@xyflow/react` 12.12.0, `react` 19.3.0, `react-dom` 19.3.0, `esbuild` 0.28.2. No CDN; everything bundled.
- Only admins change workflows (create, save, publish, discard, restore, pause, end, move). Heads may view.
- Person (private) bots can't have workflows: no Workflows tab, every route answers 404 for them.
- One email-triggered workflow per bot (already enforced by `publish`).
- Publishing an email-triggered workflow sets the bot's `mailMode` to `notify`; the email tab can't choose "act on it" while one is published (spec: "blocked in the UI while a workflow is published, not just ignored").
- Tests: one file at a time (`npx vitest run <file>`), never the whole suite; `src/teams/handlers.test.ts` is not touched by this plan.
- No new migration: everything fits the part 1 tables.

## Review Focus

1. Two admins edit the same draft: the second save must not silently overwrite the first. Save sends the `base` hash it loaded; the server answers 409 "changed by someone else; reload" when the current draft hashes differently (Task 1 and Task 3 tests `save refuses a stale base`).
2. Publishing a draft that removed a step runs are on: the publish answers 409 with each removed step's label and run count, the canvas asks where they go, and re-publishes with `moves` (Task 3 test `publish asks where stranded runs go`, Task 5 staging check).
3. Labels, questions and instructions containing `<script>`: escaped on the server-rendered status/run pages and in the embedded JSON (`</script>` inside init JSON must not end the tag) (Task 3 test `canvas page escapes init json`, Task 4 test `run page escapes labels`).
4. An Ask step's `personId` from another tenant or a deleted person: publish refuses it (Task 1 test `checkPeople rejects a person outside the tenant`).
5. Pausing or ending a run while its AI step is running: refused with "wait for the step to finish", so a claimed step is never pulled out from under its lease (Task 1 test `pauseRun refuses a running step`, Task 4 test `end refuses a running run with a message`).

---

### Task 1: Runtime additions for the builder

**Files:**
- Modify: `src/workflows/runs.ts` (add `pauseRun`, `endRun`)
- Modify: `src/workflows/store.ts` (add `draftHash`, `StaleDraft`, base check in `saveDraft`, `discardDraft`, `listVersions`, `restoreVersion`; in `publish`: Ask person check and `mailMode` reset)
- Modify: `src/workflows/graph.ts` (dead-end check in `checkGraph`)
- Test: `src/workflows/runs.test.ts`, `src/workflows/store.test.ts`, `src/workflows/graph.test.ts`

**Interfaces:**
- Produces:
  - `pauseRun(db: Db, tenantId: string, runId: string, personId: string): Promise<void>`: `ready` or `waiting` → `needs_person`, `dueAt` null, event `kind: "move"`, `reason: "paused"`, `data: { from: nodeId, to: "needs_person", personId }`. Throws `DirectoryError("Wait for the step to finish")` when `running`; `DirectoryError("This run has ended")` when `done`/`failed`; no-op when already `needs_person`. A paused run is then moved on with the existing `moveRun`.
  - `endRun(db: Db, tenantId: string, runId: string, personId: string): Promise<void>`: any open status except `running` → `done`, `outcome: "ended by a person"`, `endedAt` now, pending approvals revoked (`revokeApprovals`), event `kind: "move"`, `reason: "ended"`. Same `running` and ended refusals.
  - `draftHash(graph: WorkflowGraph): string`: sha256 hex of `JSON.stringify(graph)`.
  - `class StaleDraft extends Error` (exported).
  - `saveDraft(db, tenantId, workflowId, graph: unknown, base?: string): Promise<string>`: when `base` is given and differs from `draftHash(current draft)`, throws `StaleDraft`; returns the new draft's hash. Existing callers pass no base and keep working.
  - `discardDraft(db, tenantId, workflowId): Promise<void>`: draft = published graph, or the empty graph if never published.
  - `listVersions(db, tenantId, workflowId): Promise<{ version: number; publishedAt: Date; publishedBy: string; live: boolean }[]>` newest first (`publishedBy` is the person's name).
  - `restoreVersion(db, tenantId, workflowId, version: number): Promise<void>`: draft = that version's graph.
  - `publish` also refuses an Ask `personId` not in the tenant with `DirectoryError("\"<label>\" asks someone who isn't in this company")`, and when the draft has an email trigger sets `botDefinitions.mailMode = "notify"` for that bot in the same transaction.
  - `checkGraph` adds: every non-End node needs at least one linked exit (`"<label>" leads nowhere`).

- [ ] **Step 1: Write failing tests**
  - `runs.test.ts`: `pauseRun parks a waiting run` (status `needs_person`, `dueAt` null, last event reason `paused`); `pauseRun refuses a running step` (rejects `/Wait for the step to finish/`); `endRun ends a waiting run and revokes approvals` (status `done`, outcome `ended by a person`, the run's pending approval row revoked); `moveRun takes a paused run to a chosen step`.
  - `store.test.ts`: `save refuses a stale base` (save with the loaded base, then again with that same old base → `StaleDraft`); `discard restores the published graph`; `listVersions lists newest first with live flag`; `restoreVersion copies a version into the draft`; `checkPeople rejects a person outside the tenant`; `publishing an email workflow turns act mode off` (bot `mailMode: "act"` → `"notify"`).
  - `graph.test.ts`: `a step with no linked exit leads nowhere` (AI node with no outgoing edge → `"x" leads nowhere`; End node with none → no problem).
- [ ] **Step 2: Run each file; the new tests fail**
  `npx vitest run src/workflows/runs.test.ts`, then `store.test.ts`, then `graph.test.ts`. Expected: new tests FAIL (missing exports / no problem reported).
- [ ] **Step 3: Implement** the signatures above. `pauseRun`/`endRun` use the existing `atomically(db, runId, ...)` and `addEvent` in `runs.ts`, as `moveRun` does. Graph fixtures in other tests that now trip "leads nowhere" get their missing edge added; the check is not weakened.
- [ ] **Step 4: Run** the three files, then `engine.test.ts`, `approvals.test.ts`, `match.test.ts`, `ask.test.ts`, `mcp.test.ts`, one at a time. Expected: all PASS. `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(workflows): pause, end, versions, discard and safe saves`

### Task 2: Canvas package and model

**Files:**
- Create: `canvas/package.json`, `canvas/build.mjs`, `canvas/src/model.js`, `canvas/test/model.test.js`
- Modify: `vitest.config.ts` (include `canvas/test/**/*.test.js`). Install the canvas's deps inside `canvas/` with its own lockfile so the server image's `pnpm install --frozen-lockfile` is unchanged; the Dockerfile copies only `src`, so the committed bundle is what ships.

**Interfaces:**
- Produces (`canvas/src/model.js`, pure, no React):
  - `EXITS(node) -> string[]`: same rules as `exitsOf` in `src/workflows/graph.ts` (trigger `next`; ai results + `needs_person` + `new_message`; wait `time_up` + `new_message`; ask choices + `no_answer` + `new_message`; end none).
  - `toFlow(graph) -> { nodes, edges }`: nodes `{ id, type: node.type, position: { x, y }, data: node }`; edges `{ id: from + ":" + exit, source: from, sourceHandle: exit, target: to }`.
  - `toGraph(nodes, edges, holidays) -> WorkflowGraph`: inverse; positions rounded to integers.
  - `openExits(graph) -> { nodeId, exit }[]`: exits with no edge (drawn as "a person"); open `new_message` exits are not listed (they go to a person by design and would be noise).
  - `whyNot(connection, nodes, edges) -> string | null`: refuses a link into a trigger ("nothing links into the trigger"), a second link from the same exit ("that exit is already linked"), and any link from End.
  - `newNode(type, position) -> node` with defaults: trigger `{ trigger: "email" }`; ai `{ instruction: "", success: "", results: [{ name: "done", meaning: "" }] }`; wait `{ minutes: 480, businessHours: true }`; ask `{ question: "", choices: ["yes", "no"], timeoutMinutes: 480 }`; end `{ outcome: "" }`; label = the palette name; id `uid(type)` as in BE Voice's `model.js`.
- `canvas/build.mjs`: esbuild `src/main.jsx` → `../src/admin/assets/workflows/canvas.js` (+ `canvas.css`), `bundle`, `format: "iife"`, `minify`, `jsx: "automatic"`, `target: "es2020"`, `define: { "process.env.NODE_ENV": '"production"' }` — BE Voice's `build.mjs` with the outfile changed.

- [ ] **Step 1: Write failing tests** in `canvas/test/model.test.js` (vitest): `toGraph(toFlow(g))` round-trips a 5-node graph exactly; `EXITS` per node type; `openExits` lists an unlinked AI result but not `new_message`; `whyNot` gives the three refusals; `newNode("ai", { x: 1, y: 2 })` has the defaults above.
- [ ] **Step 2: Run** `npx vitest run canvas/test/model.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `model.js`, `package.json` (pins above; `"build": "node build.mjs"`), `build.mjs`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(workflows): canvas model`

### Task 3: Canvas editor and its admin page

**Files:**
- Create: `canvas/src/main.jsx`, `canvas/src/Editor.jsx`, `canvas/src/nodes.jsx`, `canvas/src/Inspector.jsx`, `canvas/src/Versions.jsx`, `canvas/src/canvas.css`; built `src/admin/assets/workflows/canvas.js` + `canvas.css`
- Create: `src/admin/workflows.ts` (routes), `src/admin/workflows.test.ts`
- Modify: `src/admin/router.ts` (mount `workflowRoutes`; add `express.json({ limit: "1mb" })` beside `urlencoded`), `src/admin/bots.ts` (Workflows tab in `TABS`, hidden for person bots like `email`)

**Interfaces:**
- Consumes: Task 1 store functions; Task 2 `model.js`.
- Produces (all under the admin guard; JSON bodies carry `csrf`, which `csrfOk` already reads from `req.body`):
  - Bot tab `workflows`: table of the bot's workflows (name, "live v<N>" or "draft only", open runs, needs-a-person count) linking to canvas and status; admin form "new workflow" (name, chat select of the bot's chats) → `createWorkflow(..., runAsPersonId: actor.personId)` → 303 to the canvas.
  - `GET /admin/bots/:id/workflows/:wid` → canvas page: `<div id="wf-canvas">`, `<script type="application/json" id="wf-init">` with `{ workflowId, name, draft, base: draftHash(draft), published: boolean, people: [{ id, name }], csrf, readOnly: !admin, trace?: TracePath }` (JSON with `<` written as `<`), then the bundle's `<script>` and css link with the `?v=` cache-buster `html.ts` uses. `main.jsx` exposes `window.WFCanvas.mount(el, init)` and the page calls it, as BE Voice's `BECanvas.mount`.
  - `POST /admin/workflows/:wid/draft` `{ csrf, graph, base }` → `200 { base }` | `409 { error: "changed by someone else; reload" }` | `400 { error }` (from `parseGraph`).
  - `POST /admin/workflows/:wid/publish` `{ csrf, moves }` → `200 { version }` | `409 { stranded: [{ nodeId, label, runs }] }` (from `runsOnRemovedNodes` + the live graph's labels) | `400 { error }` (publish refusals).
  - `POST /admin/workflows/:wid/discard`, `GET /admin/workflows/:wid/versions`, `POST /admin/workflows/:wid/restore` `{ csrf, version }`.
  - Every route checks the workflow's tenant is the actor's and its bot isn't a person bot (404 otherwise); mutating routes require `isAdmin(actor)` (403 otherwise).
- Editor: BE Voice Editor's shell (palette left; canvas with `Background`, `Controls`, `MiniMap`; inspector right; bar with save, discard, publish, versions). Palette: trigger, ai step, wait, ask a person, end. One source handle per exit from `EXITS`; open exits drawn as a small "a person" stub. Publish refusals (400) shown in the bar as the server worded them. Inspector per type: label; ai instruction, success test, results (name + meaning, add/remove), saved fields (comma list → `saves`); wait length in hours or days (stored as minutes) + "business hours"; ask question, choices, person (select from `people`, or none = the bot's chat), timeout; trigger email/manual; end outcome. Publish 409 opens a dialog: each stranded step with a select of the draft's steps + "a person", then re-posts with `moves`. Save 409 shows "changed by someone else; reload". `readOnly` hides palette and buttons.

- [ ] **Step 1: Write failing route tests** in `src/admin/workflows.test.ts`, using `serve` and `sessionCookie` from `test-server.ts` as `bots.test.ts` does: `workflows tab lists and creates` (POST → 303 to the canvas URL; tab shows the name); `person bots have no workflows` (tab absent; canvas GET 404); `canvas page escapes init json` (workflow named `</script><b>x` → page contains `</script` and not `</script><b>`); `save refuses a stale base` (409); `publish asks where stranded runs go` (409 with `stranded[0].label`, then publish with `moves` → 200); `heads can view but not save` (GET 200, POST draft 403); `publishing an email workflow turns act mode off`.
- [ ] **Step 2: Run** `npx vitest run src/admin/workflows.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the routes and tab, then the canvas components; `cd canvas && pnpm install && pnpm build` writes the bundle.
- [ ] **Step 4: Run** `workflows.test.ts`, then `bots.test.ts`, then `router.test.ts`, one at a time; `npx tsc --noEmit`. Expected: PASS, clean. Manual (local app): open a bot's Workflows tab, build trigger → ai → wait → end, save, reload (layout kept), publish, open versions.
- [ ] **Step 5: Commit** `feat(workflows): canvas builder and workflows tab` (bundle included).

### Task 4: Status page, run page, Trace a run

**Files:**
- Create: `src/workflows/trace.ts`, `src/workflows/trace.test.ts`
- Modify: `src/admin/workflows.ts`, `src/admin/workflows.test.ts`, `canvas/src/Editor.jsx` (trace overlay), rebuilt bundle; `src/admin/router.ts` / `src/index.ts` (pass the scheduler's `Notify` into `workflowRoutes`)

**Interfaces:**
- Produces:
  - `type TracePath = { runId: string; title: string; status: string; steps: { nodeId: string; at: string; result: string | null; reason: string | null }[] }`.
  - `tracePath(db: Db, tenantId: string, runId: string): Promise<TracePath>`: from `workflow_run_events` in `at` order, one entry per `step`/`wait`/`ask` event (the node entered), each filled with the next `result` event's `result` and `reason` for that node.
  - `GET /admin/bots/:id/workflows/:wid/runs?show=needs_person|open|all` (default `open`): runs newest first, 50 per page (`?page=`): title, current step label, status chip, next due time in the tenant time zone, last result reason.
  - `GET /admin/workflow-runs/:runId`: header, event history (time, step label, kind, result, reason), admin buttons "pause" (ready/waiting), "end" (open, not running), "move" with a step select (needs_person only), and a "trace" link to the canvas with `?trace=<runId>`.
  - `POST /admin/workflow-runs/:runId/pause|end|move` (form posts; `nodeId` for move) → Task 1 functions / `moveRun` → 303 to the run page; `DirectoryError` text shown as the page's error notice.
  - Canvas with `init.trace`: path nodes numbered in order, others dimmed; clicking one shows its result and reason; bar shows "tracing <title>" and "stop".

- [ ] **Step 1: Write failing tests**: `trace.test.ts` `tracePath follows a run through two steps with results`; `workflows.test.ts` `status page shows open runs and filters needs_person`, `run page escapes labels`, `pause then move a run from the run page`, `end refuses a running run with a message`.
- [ ] **Step 2: Run** each file. Expected: FAIL.
- [ ] **Step 3: Implement**; rebuild the bundle.
- [ ] **Step 4: Run** `trace.test.ts`, `workflows.test.ts`, `runs.test.ts`, one at a time. Expected: PASS. `tsc` clean.
- [ ] **Step 5: Commit** `feat(workflows): status page, run actions and trace`

### Task 5: Email tab hands over to the workflow; staging check; PR

**Files:**
- Modify: `src/admin/bots.ts` (email tab and its POST), `src/admin/bots.test.ts`

**Interfaces:**
- Consumes: `emailWorkflowFor(db, definitionId)` from `src/workflows/store.ts`.
- Email tab: when `emailWorkflowFor` returns a workflow, the mode select is replaced by the notice "emails go to the workflow <name>" linking to it; the POST rejects `mailMode=act` with `DirectoryError("This bot's emails go to a workflow")`. Unpublishing isn't in v1; the notice is the whole UI.

- [ ] **Step 1: Write failing tests** in `bots.test.ts`: `email tab shows the workflow instead of act mode`; `act mode is refused while an email workflow is published`.
- [ ] **Step 2: Run** `npx vitest run src/admin/bots.test.ts`. Expected: the two FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bots.test.ts`, then `workflows.test.ts`; `tsc` clean.
- [ ] **Step 5: Commit** `feat(workflows): email tab hands over to the workflow`
- [ ] **Step 6: Staging.** Push `feature/workflows-ui`; fast-forward `deploy/coolify-test` to it only if that branch is an ancestor (never force); wait for `workflows started` in the staging logs. On the staging it-support bot: open Workflows, open "test: reply and follow up", check it draws, publish it from the canvas, have Martin send one email from outside, follow the run on the status page, trace it, end a second run from the run page. Afterwards set its `published_version` back to null on staging and say so.
- [ ] **Step 7: PR** "Workflows part 2: builder, status page, trace" with screenshots, the new copy quoted, tests run, and "merging deploys production; waits for Martin's OK".
