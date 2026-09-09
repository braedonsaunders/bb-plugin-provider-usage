---
name: usage
description: Inspect remaining provider subscription usage, plans, reset windows, live token throughput, and global token totals. Use when the user asks about usage, quota, remaining limits, what is burning tokens right now, token spend over time, Codex/Claude/Cursor plan usage, or when to wait for a reset.
---

# Usage dashboard

Run `bb usage` (or `bb usage --json`) to read live subscription windows
and token totals from this machine.

```bash
bb usage
bb usage --json
bb usage live                 # tokens per minute right now, by provider and thread
bb usage tokens --days 30
bb usage --machine <id-or-name>
```

Use `totals.cumulativeRemainingPercent` for remaining quota across signed-in
providers, `totals.tightest` for the most exhausted window, and each provider
`windows[].remainingPercent` when deciding whether a thread should wait for a
reset. Provider rows may also include `credits`, `resetCredits`, and
`spendControl`; for Codex these expose purchased-credit balance, banked reset
availability/expiry, and any backend-reported on-demand period. A window's
`cost` gives exact used/limit dollars when the provider reports them. Use
`tokens.totals` and `tokens.providers` for global Codex/Claude transcript token
volume across Codex, Claude Code, Cursor, and opencode.

When a provider row has `pooled: true`, the Account Pooler is routing it across
the logins in `accounts[]`, listed in failover order. Judge whether to wait for
a reset from the first account with `unavailable: false` — that is the one that
will serve the next request. The row's own `windows[]` describe only the local
credentials, which are routinely exhausted or unauthenticated while the pool
keeps working, so do not report a pooled provider as out of quota unless every
entry in `accounts[]` is unavailable.

`bb usage live` answers "what is being burned right now": `tokensPerMinute` is
the trailing-60-second rate, `peakTokensPerMinute` the best rate in the last 15
minutes, and `threads[]` attributes it to the threads doing the work. Archived
and deleted threads are omitted. It counts only what BB drives, so an agent
run outside BB does not appear.
