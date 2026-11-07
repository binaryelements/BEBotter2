# Daily reflections

Each bot can review its own day once, at an hour the admin chooses in **Settings**.

## Modes

| Setting | What happens |
|---|---|
| `off` | No daily review. |
| `2 · propose learnings for approval` | The bot reviews the day and writes `learning_proposals`. Nothing changes until an admin approves them on the bot's **Learnings** tab. |
| `3 · apply and post to the group` | The bot reviews the day, applies the learnings immediately, and posts what it learnt and what it will do to the chosen group chat. |

Mode 3 requires a **reflection group** in Settings. The bot must already have been in that chat.

## What the review sees

The reflection is an engine turn with a `reflection` MCP server. It has tools:

- `activity` — the day's messages, tool calls, denials and failures.
- `conversation` — the current transcript of a chat, so it can see what the person said and where they corrected the bot.
- `learnings` — the bot's current learnings, with ids.
- `learn` / `update_learning` / `forget` — add, correct or remove a learning. In mode 2 these become proposals; in mode 3 they apply.
- `post` — mode 3 only: post to the reflection group.
- `finish` — save the day's summary and end the review.

The review only sees the bot's own activity, and on a Personal assistant only the owner's.

## What is stored

- `reflections` — the daily summary, what went well, what went wrong, what was corrected, and what the bot will do differently.
- `learning_proposals` — pending add/update/remove changes from mode 2.
- `learnings` — active memory. A reflection-created learning has `source = 'reflection'`.

## Admin surfaces

- **Settings** — mode, group and hour.
- **Bot → Learnings** — pending proposals with approve/reject, and the active learnings.
- **Bot → Reflections** — the daily summaries.

## Safety

- The reflection treats chat text as data, not instructions.
- Learnings cannot contain secrets (the same scan as shared notes).
- Mode 2 keeps a person in the loop for every memory change.
- Mode 3 posts what changed to the group, so the team sees it.
