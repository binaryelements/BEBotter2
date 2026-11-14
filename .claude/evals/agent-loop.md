# EVAL DEFINITION: agent-loop

How well a turn gets from a Teams message to an answer: step limit, loops, failures.
Walkthrough: `.tours/reviewer-chat-to-answer.tour`. Graders run read-only against production
`audit_events` (psql command in the BE Teammate servers memory), or as unit tests.

Baseline: production, deepseek/deepseek-flash, 2026-11-08 → 2026-11-14, 184 message turns
(chat turns and background jobs together; the audit row does not say which).

## Regression evals (must not get worse)

| id | metric | grader | baseline | target |
| --- | --- | --- | --- | --- |
| R1 | answer rate: message rows `done` / all | SQL G1 | 179/184 = 97.3% | ≥ 97% |
| R2 | median tool calls per turn | SQL G1 `p50_tools` | 2 | ≤ 3 |
| R3 | existing runner/engine tests | `pnpm vitest run src/engine/runner.test.ts` then `src/engine/openai.test.ts` (one at a time) | not run yet (this worktree has no node_modules) | pass^3 = 100% |

## Capability evals (fixes to make)

| id | behaviour | grader | baseline | target |
| --- | --- | --- | --- | --- |
| C1 | a turn that reaches its step limit answers with what it found, not `I couldn't finish that.` | SQL G1 `couldnt` with tools ≥ 40; unit test: fake client that always calls a tool → result text is not FAILED_TEXT | 0/3 | 3/3 |
| C2 | one tool called > 15 times in a turn is stopped (today only *failing* tools are, after 4) | SQL G2; unit test: fake client repeating one successful call → refused after N | 6/184 turns loop | 0 |
| C3 | a turn aborted by a newer message keeps the tool calls that ran in the session, so the retry does not repeat a write | unit test: abort after a `write` tool completes → session row holds the call and its result | fails (runner.ts:522 returns before saving) | pass |
| C4 | memory recall finds relevant items (OR query on the person's own words) | log FTS hits before the fill; human grader on 20 sampled turns | not measured | ≥ 1 real hit on ≥ 50% of turns that have a matching memory |

## Graders

G1: turns, failures, tool spread
```sql
select model, count(*) turns, count(*) filter (where status='failed') failed,
  count(*) filter (where summary like 'I couldn%') couldnt,
  percentile_cont(0.5) within group (order by (timings->>'tools')::int) p50_tools,
  percentile_cont(0.9) within group (order by (timings->>'tools')::int) p90_tools,
  max((timings->>'tools')::int) max_tools
from audit_events where kind='message' and timings ? 'tools' and started_at >= :since
group by model;
```

G2: turns where one tool ran more than 15 times (the time window over-counts when parallel jobs share a chat)
```sql
with m as (select id, chat_id, definition_id, started_at, finished_at from audit_events
  where kind='message' and timings ? 'tools' and started_at >= :since)
select count(*) filter (where worst > 15) loops, count(*) turns from (
  select m.id, coalesce((select max(n) from (select count(*) n from audit_events t
    where t.kind='tool' and t.chat_id=m.chat_id and t.definition_id=m.definition_id
      and t.started_at between m.started_at and m.finished_at group by t.tool_name) x), 0) worst from m) y;
```

## Baseline run, 2026-11-14

```
turns 184 · failed 5 · "I couldn't finish that." 5
tool calls per turn: p50 2 · p90 11 · p99 102 · max 122 · turns with ≥ 40: 5
failed turns by tool calls: 2, 2, 63, 102, 103
  63  tools · 13 min · connections ssh_change ×52   (step limit, a loop)
  102 tools · 8 min  · browser navigate ×49, evaluate ×47   (background job, 100-step limit)
  103 tools · 12 min · browser navigate/evaluate   (background job, 100-step limit)
  2 tools ×2: engine errors, not the limit
looping turns (one tool > 15 calls): 6 of 184
```

Status: BASELINE RECORDED. C1–C3 fail today; R1–R2 pass; R3 not run.
