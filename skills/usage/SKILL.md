---
name: usage
description: Inspect remaining provider subscription usage, plans, reset windows, live token throughput, and global token totals. Use when the user asks about usage, quota, remaining limits, what is burning tokens right now, token spend over time, Codex/Claude/Cursor/Muse plan usage, or when to wait for a reset.
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
availability/expiry, and any backend-reported on-demand period. Claude
`resetCredits` is the same shape: saved grant count plus the unused weekly
session reset when one is still sitting on the account. Muse Code reports a
`5-hour limit` and a `Weekly limit` window as of the last Muse turn on that
machine; an `ok` Muse row with no windows means no Muse turn has run there yet,
so its quota is unknown rather than full. A window's
`cost` gives exact used/limit dollars when the provider reports them. Use
`tokens.totals` and `tokens.providers` for global Codex/Claude transcript token
volume across Codex, Claude Code, Cursor, opencode, and Muse Code.

When a provider row has `pooled: true`, the Account Pooler is routing it across
the logins in `accounts[]`, listed in failover order. Judge whether to wait for
a reset from eligible accounts with `unavailable: false`. Pool observations
are authoritative: matching emails do not identify the same credentials or
quota tier. The row's own `windows[]` describe an eligible pooled account, or
an exhausted account when none is eligible. Do not report a pooled provider
as out of quota unless every entry in `accounts[]` is unavailable. Local
credit balances and reset grants are not attributed to pooled accounts
without verified credential identity.

`bb usage live` answers "what is being burned right now": `tokensPerMinute` is
the trailing-60-second rate, `peakTokensPerMinute` the best rate in the last 15
minutes, and `threads[]` attributes it to the threads doing the work. Archived
and deleted threads are omitted. It counts only what BB drives, so an agent
run outside BB does not appear.

Google Gemini subscriptions use `acp-antigravity` (Google Antigravity). On the primary machine, Provider Usage reads the official CLI’s read-only `/usage` JSON report and shows separate Gemini and Claude/GPT five-hour and weekly windows. The CLI manages Google login and refresh; this plugin never reads its credentials. Remote quota collection requires a collector on that host.

Provider headlines and `totals.cumulativeRemainingPercent` use the most restrictive subscription window per provider, rather than the first window. An exhausted weekly quota therefore shows zero even when the five-hour quota is full. The rail averages these provider figures once per provider; separate paid spending budgets do not replace subscription windows.
