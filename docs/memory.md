# Memory

The bot has two kinds of memory:

| Tier | Table | How it reaches the model |
|---|---|---|
| **Core rules** | `learnings` | All of it, every turn. Capped at 100 short rules. |
| **Long-term memory** | `memory_items` | Only the few relevant to the message, plus anything the bot asks for with `recall`. |

The long tail is never injected wholesale. That is what lets it hold millions of items without growing the prompt.

## Retrieval

On every turn, before the engine runs:

1. The app builds a scope from the tenant, bot, person, their departments and the chat.
2. It searches `memory_items` with Postgres full-text search (`to_tsvector` / `websearch_to_tsquery`).
3. It takes the best 12 matches, then fills any remaining slots with the most important and most recently used items in scope.
4. It appends those 12 to the system prompt under **Relevant long-term memory**.
5. It increments `use_count` and sets `last_used_at` on what it used.

Expired items (`expires_at`) are hidden. Items scoped to another owner, department or chat are never visible.

## Tools

- `recall(query)` — search long-term memory on demand.
- `remember(text, kind?, importance?)` — save a detailed fact, procedure or preference. It is retrieved later, not injected every turn.
- `update_memory` / `forget_memory` — correct or remove an item.

`learn` is still the core-rule tool: a short instruction that must apply every turn. `remember` is for everything else.

## Scopes

A memory item can be:

- **shared** — everyone who uses the bot (`owner_person_id`, `department_id`, `chat_id` all null),
- **owner** — one person, for a Personal assistant,
- **department** — one department,
- **chat** — one conversation.

Retrieval always includes shared items plus the current owner, departments and chat.

## Admin

**Bot → Memory** lists the long tail, searches it, adds items, rewrites them and deletes them.

**Bot → Learnings** still shows the core rules and the reflection proposals.

## Scaling

- Postgres stores the long tail; the GIN index handles keyword search.
- The prompt budget is fixed: core rules + at most 12 retrieved items.
- The daily reflection writes to `memory_items` for detail and to `learnings` only for short rules that must always apply.
- Phase 2, if keyword recall is not enough: add `pgvector` and hybrid rerank. Nothing else changes.
