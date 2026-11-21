# Workflows: defined steps with AI doing each one

Date: 20 Nov 2026. Status: decisions settled, awaiting Martin's approval of this document. Session: dev2-remote BE Teammate.

## Why

Today a bot's process lives in one prose runbook (Jimmy's `troubleshooting/enquiry-follow-up.md`). The bot rereads the
whole thing and the email thread on every turn, works out which step a lead is on, and sets its own reminders whose
text names the step to resume. In the 19 Nov sales test this produced guesses about state: Jimmy said staff would send
the proposal, said a text edit unpublished the link, and changed a sent quote without re-sending it (no accept button).

Martin's goals: **consistency, scalability, clearer instructions, fewer hallucinations.** The system, not the AI, owns
where each item is and what comes next. The AI does one small step at a time and reports how it went.

## Goals

- A general feature any bot can use: a **workflow** of steps, started by a trigger, run once per item (a lead, a ticket).
- Built in a graphical canvas in the admin, like BE Voice's Call routing page.
- Each AI step has its own instruction, success test and named results; the result picks the next step.
- A person is pulled in when a step says it needs one or can't decide.
- Replies continue the run they belong to; they never start a second one.
- Publishing a change moves runs in flight onto the new version.
- Every run's status and history is visible.

## Non-goals (v1)

- Triggers other than inbound email and manual start. The trigger is a node type so schedule, webhook and Teams-message
  triggers can be added later without a redesign. (My call: Jimmy only needs email.)
- Parallel branches inside one run, sub-workflows, loops with counters beyond what Wait + results give.
- Non-admin editing. Only people who can edit the bot can edit its workflows.

## Anti-goals

- A workflow must never get around the bot's action rules. If `send_proposal` asks for approval today, it still asks.
- No second reply path: a mailbox driven by a workflow is not also answered by the bot's "act on every email" mode.
- No silent stalls: a run that can't move on lands in "needs a person", visible on the status page and in Teams.

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| A | Stricter markdown runbook the system parses into steps | Reuses the runbook editor, but step links are still text and break on renumbering (the 19 Nov problem). |
| **B** | **Workflows stored as data, graphical builder, AI import from a runbook** | Most new code; links are ids, status page is natural. **Picked by Martin**, with a canvas like BE Voice. |
| C | Workflows as code files in the repo | Strict and testable, but only a developer can change them. |

## Concepts

- **Workflow**: belongs to one bot. Has a draft and published versions (as BE Voice routing).
- **Version**: a graph of nodes and edges, saved whole. Node ids are stable across versions.
- **Run**: one item going through a workflow. Holds: workflow, current node, status
  (`running | waiting | needs_person | done | failed`), match keys, saved fields, outcome when ended.
- **Run event**: append-only history row per step: node, result, reason line, saved-field changes, audit link, times.

## Node types

| Node | Settings | Exits (dots) |
|---|---|---|
| Trigger: email | the bot's mailbox | one: next |
| Trigger: manual | fields to fill when a person starts a run | one: next |
| AI step | instruction, success test, named results (each with a one-line meaning), fields it may save, optional tool limit | one per named result, plus **needs a person** (always present) |
| Wait | duration; "business hours" option; ends early on a new message | **time's up**, **new message** |
| Ask a person | who (a person or the bot's approvers), question, buttons | one per button, plus **no answer** after a set time |
| End | outcome label (won, lost, closed…) | none |

AI step and Ask a person nodes that are waiting also get a **new message** exit (the item replied while waiting).

## Running an AI step

- It runs as the bot itself: a background turn (as `background` jobs do today) in the workflow's chat, with the bot's
  tools, connections and action rules.
- The prompt holds only: this step's instruction and success test, the list of named results, the run's saved fields,
  and the event that woke it (e.g. "new email in thread X from Y", never the email body pasted in: the bot reads it
  with its mail tools, as inbound mail does today, and the content is data, not instruction).
- The step ends with a required tool call `report_result(result, reason, fields)`. `result` must be one of the node's
  named results or `needs_person`. No call, or an unknown result: retry once, then take **needs a person**.
- **Approvals (Martin: option A):** there is no separate approval step before a send. The AI step that sends raises
  the bot's normal approval card. For workflow steps the card is **durable**: stored, survives restarts, never expires
  (today's cards live in memory in `src/engine/confirm.ts` and expire after 10 minutes). The step waits on it.
  If a new message for the run arrives while a card is waiting, the card is cancelled and the step takes its
  **new message** exit, so nothing is sent after the customer asked for changes.
- Business hours: the tenant's time zone and a holiday region setting (Jimmy: Melbourne, VIC holidays).

## Continuing, not restarting

Each run keeps match keys. For email: thread id, sender address, sender domain. When an email reaches a mailbox that
has an email-trigger workflow:

1. An open run with the same **thread id**: wake it.
2. Else an open run with the same **sender address**: wake it.
3. Else an open run with the same **sender domain** (free-mail domains like gmail.com excluded): don't attach; post an
   Ask-a-person card in Teams: "This looks like <run>. Attach or start new?"
4. Else an **ended** run with the same thread id or sender address (Martin: ask): post an Ask-a-person card in Teams:
   "This is from <run>, which ended as <outcome>. Reopen or start new?" Reopen puts the run on the End node's
   **new message** handling: it goes to a node the person picks, default needs a person.
5. Else start a new run.

"Wake" means: the run takes the **new message** exit of the node it is waiting on. If it is busy in an AI step, the
event is queued and delivered when the step reports (one step at a time per run). Inbound mail must start reading
AgentMail's `thread_id` (today it reads only sender, subject and message id).

## Publishing moves runs to the new version

- A run whose current node id still exists continues there on the new version.
- A run on a node that was removed: publish shows these runs and requires choosing a node for each removed node
  (default: needs a person). Publish is blocked until chosen.
- A run waiting in a Wait node keeps its due time, unless the wait's duration changed; then the due time is
  recalculated from when the wait started.
- Saved fields carry over unchanged; a field no step uses any more is kept but ignored.

## Builder (admin)

- A **Workflows** tab on the bot, and a canvas page per workflow, built like BE Voice's Call routing canvas:
  `@xyflow/react` 12 with React 19, bundled by esbuild into one `canvas.js` and mounted in the server-rendered admin
  page. Copy BE Voice's `adminui/canvas` Editor, Inspector, nodes, model and Versions (about 1,700 lines) and replace
  its node types with ours.
- Palette on the left, inspector on the right, "what connects to what" help, Versions, Discard, Save, Publish.
- Checks on save: every exit connected or explicitly left open (open exit = needs a person), exactly one trigger,
  every path reaches an End or a Wait.
- **Import from a runbook**: pick a runbook; the AI drafts nodes and edges into the draft for a person to fix. Never
  publishes by itself.
- **Trace a run**: like "Trace a call": a run's path highlighted on the canvas with each step's result and reason.

## Status page

Per workflow: open runs with item (subject / lead), current step, status, next due time, last result; filters for
`needs_person`. Per run: the event history and buttons to move it to a node, pause, or end it.

## Data (sketch, builder decides details)

`workflows`, `workflow_versions` (graph JSON, published flag), `workflow_runs`, `workflow_run_events`. Runs are
claimed by the existing scheduler loop (as routines are): a due Wait, a queued event, or a ready step.

## Jimmy's first workflow

Import `enquiry-follow-up.md` (v25) and fix by hand: reply, wait 1 business day, call reminder, call, draft proposal,
approval, send, follow-ups at 2, 5, 10 and 20 business days, accepted, declined. Re-send after a price change becomes
its own AI step after any quote edit, with the success test "the customer has the latest revision".

## Calls made after the builder check (Claude's, for Martin to veto)

- **Cutover for Jimmy:** publishing an email-triggered workflow turns off the bot's "act on every email" mode for that
  mailbox (blocked in the UI while a workflow is published, not just ignored) and detaches the runbook it replaces.
  Jimmy has no reminders waiting and only test leads, so no in-flight leads are imported; runs start fresh.
- **Restarts:** an AI step records whether any write tool completed. On restart, a step with no completed write is
  re-run; a step with a completed write goes to **needs a person** with that fact shown. Deploys then only flag steps
  that really were half done.
- **Match keys without an inbound email:** a manual start asks for the customer's email address; `report_result` may
  save `thread_id` and `email` fields, which become match keys.
- **Chat and authority:** each workflow stores a chat and a "runs as" person (the publisher), as `mailChatId` and
  `mailBy` do today, and the scheduler checks them the same way. Person (private) bots can't have workflows in v1.
- **Which emails start runs:** the same filters as today (own domain, bounces, no-reply, the hourly cap). One
  email-triggered workflow per bot. Teams notices for each email stay.

## Left to the builder

Table and column names; how the canvas talks to the server (JSON routes like BE Voice's); how the AI-step prompt is
worded; retry timing; pagination on the status page; test layout.
