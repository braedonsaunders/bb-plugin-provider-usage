---
name: usage
description: Inspect remaining provider subscription usage, plans, reset windows, and global token totals. Use when the user asks about usage, quota, remaining limits, token spend over time, Codex/Claude/Cursor plan usage, or when to wait for a reset.
---

# Usage dashboard

Run `bb usage` (or `bb usage --json`) to read live subscription windows
and token totals from this machine.

```bash
bb usage
bb usage --json
bb usage tokens --days 30
bb usage --machine <id-or-name>
```

Use `totals.cumulativeRemainingPercent` for remaining quota across signed-in
providers, `totals.tightest` for the most exhausted window, and each provider
`windows[].remainingPercent` when deciding whether a thread should wait for a
reset. Use `tokens.totals` and `tokens.providers` for global Codex/Claude
transcript token volume across Codex, Claude Code, and Cursor.
