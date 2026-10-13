# Message Batches API — how and where it is used

> **Status: superseded — not implemented.** LLM calls go through the Claude Code subscription ([ADR 0005](adr/0005-llm-calls-through-claude-code-subscription.md)), where the Batches API does not exist, and scoring no longer uses an LLM. Kept only as a record of the design.
> Decision record: [ADR 0004](adr/0004-batches-api-for-scoring.md).

## Where

Only in **scoring** (`src/scoring.ts`), triggered by `jobpipe score` and `jobpipe run`.
Tailoring (`jobpipe generate`) never uses batches.

## When

| Jobs waiting for scoring | Mode |
|---|---|
| ≤ `limits.batch_min_jobs` (default 20) | direct calls, sequential |
| > `limits.batch_min_jobs` | one Message Batch with all of them |
| `jobpipe score --no-batch` | direct calls regardless of count |

Both modes use prompt caching on the Profile Summary + instructions block.

## Flow

1. **Resume first.** Any batch recorded as pending in the database is checked. If it has ended, its results are applied before anything new is submitted.
2. **Submit.** Each Job becomes one request in the batch, with `custom_id` = Job id. The batch id is stored in the `batches` table; the Jobs move to status `scoring`.
3. **Poll.** Every `limits.batch_poll_seconds` (default 30) for up to `limits.batch_max_wait_minutes` (default 15).
4. **Apply results.** Each result is validated with zod. Success → score saved, Job moves to `scored` (or onward). Errored/expired/invalid → Job goes back to `new` and is retried on the next run (direct or in the next batch).
5. **Timeout.** If the batch has not ended, the command exits with a message ("batch <id> pending, N jobs") and leaves the Jobs in `scoring`. The next `score`/`run` picks it up at step 1.

## Cost logging

Every batch result is logged to `data/logs/<date>_usage.log` like a direct call, marked `batch=yes`, with the batch discount applied to the estimated cost. The end-of-stage summary reports how many calls went through a batch.

## Config

```yaml
limits:
  batch_min_jobs: 20
  batch_poll_seconds: 30
  batch_max_wait_minutes: 15
```

## Inspecting

`jobpipe stats` lists pending batches (id, submitted at, job count).
