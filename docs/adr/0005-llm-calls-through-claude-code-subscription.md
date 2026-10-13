# LLM calls go through the Claude Code subscription, and scoring is deterministic

I don't want to pay for LLM usage beyond my Claude subscription, and the Anthropic API is billed per token separately from it. So every model call spawns the installed, unmodified Claude Code CLI (`claude -p`) signed in with my subscription — ordinary individual use, which Anthropic's terms allow — with `ANTHROPIC_API_KEY` stripped from its environment and an abort if the run reports any API key source. Since this draws from the same 5-hour/7-day quota I use interactively, scoring no longer calls a model: it is a deterministic match of the Job's technologies against the Base CV, and only tailoring (at most `generate_per_run` Jobs per run) uses the LLM. When the quota runs out, generation stops; it never falls back to the API.

## Consequences

- No Message Batches API and no explicit prompt caching (both are API-only); ADR 0004 is superseded.
- Logged cost is Claude Code's *equivalent* API cost, not a charge; the quota is reported as percentages of the 5h/7d windows, because the subscription exposes no token balance.
- Each call carries Claude Code's fixed context overhead, which matters on a Pro plan.
- Deterministic scoring misses requirements phrased without named technologies; an LLM refinement for the top Jobs is a future improvement.
