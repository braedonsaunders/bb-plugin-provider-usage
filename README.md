# Provider Usage

A BB panel for **what you are burning right now**, **how much of your plan is
left**, and **how many tokens you have spent** — across every provider you are
signed in to, on every machine BB knows about.

<!-- screenshot: docs/panel.png -->

## What it shows

**Live throughput.** A 15-minute chart of tokens as they are reported, binned
per 10 seconds and stacked by provider, with the current rate over the trailing
60 seconds, the best rate seen in the window, and the threads doing the work. It
updates every couple of seconds while a turn is running and settles when the
machine goes quiet.

**Provider limits.** One pane, one row per signed-in provider: its plan, each
rate-limit window (5-hour, weekly, monthly — whatever the provider reports), how
much is left, and when it comes back. Every meter counts **down** — the ring,
the bar, and the number all show what remains, the way each provider states its
own limits.

**Token usage, for every provider.** A 7 / 30 / 90-day multi-series chart of
real token volume, broken out into total, uncached input, output, and cached,
per provider. Total follows the provider's canonical count where one is
available and includes cached input; the cached field is also retained as a
breakdown. Cursor's ACP stores do not include token counters, so its series is
estimated from the recorded conversation text. The data reads from two tiers:

- **Transcript scanners** for the agents that keep detailed local records —
  Codex (`~/.codex`, or `$CODEX_HOME`), Claude Code (`~/.claude`, or
  `$CLAUDE_CONFIG_DIR`), Cursor's ACP session stores, and opencode
  (`~/.local/share/opencode`, or `$XDG_DATA_HOME/opencode`). These give full
  history and exact per-day attribution, back to before you installed BB.
- **BB's own usage events** for everything else. `thread/tokenUsage/updated` is
  part of the provider-bridge contract every provider plugin implements, so an
  agent this plugin has never heard of — a new ACP agent, one you wrote
  yourself — lands in the chart automatically as soon as it reports usage, with
  a name and a colour of its own. No release here required.

Providers with a dedicated scanner are excluded from the second tier, so
nothing is counted twice.

**Multi-machine.** If you have more than one host paired, a machine picker
switches the whole view between them.

It also contributes a homepage section and a sidebar accessory, so the tightest
window follows you around without opening the panel.

## Install

From the BB marketplace:

```bash
bb plugin install provider-usage
```

Or from a local checkout:

```bash
git clone https://github.com/braedonsaunders/bb-plugin-provider-usage.git
cd bb-plugin-provider-usage
npm install --include=dev
bb plugin install . --yes
```

Open **Usage** in the left sidebar.

## CLI

```bash
bb usage                          # remaining quota, plans, reset windows
bb usage --json                   # same, machine-readable
bb usage live                     # what is being burned right now, by thread
bb usage tokens --days 30         # global token volume across providers
bb usage --machine <id-or-name>   # read another paired host
```

Agents get the same data through the bundled `usage` skill, which is how a
long-running thread can decide whether to keep going or wait for a reset.

## How it works

Subscription windows come from BB's own `system.usageLimits` for each signed-in
provider, so there are no vendor API keys and no network calls of the plugin's
own.

Token totals come from a background `token-scan` service that walks local
transcript files, caches per-file results in the plugin's SQLite database, and
re-syncs every 15 minutes. Only sources whose size or mtime changed are re-read,
so a large history stays cheap. Nothing is uploaded anywhere.

The same pass asks BB for `thread/tokenUsage/updated` on any thread whose
provider has no dedicated scanner. Those events carry the thread's *running*
total rather than the turn's, so consecutive events are differenced; a total
that goes backwards means the thread was compacted or restarted upstream and is
read as a fresh total rather than a negative one.

Live throughput is a separate, deliberately different source: a `throughput-scan`
service that follows `thread/tokenUsage/updated` for **every** provider, polling
every two seconds while a thread is working and every ten when none is. Because
it is the only source there, no provider is excluded and nothing is double
counted — the trade is that work run outside BB, such as an agent CLI in a bare
terminal, reports no events and does not appear.

Attribution is the subtle part. Those events carry the thread's *running* total,
so consecutive events are differenced. The first event seen for a thread has
nothing to difference against, and providers report it very differently: BB's
Claude Code bridge has been seen emitting a single event whose running total is
98.7M and whose `last` is 55.9M — usage since the session resumed, hours of it,
not one step. Charting either figure raw drops tens of millions of tokens onto
one instant. So a thread's first event is charted only when the thread itself is
younger than the window, because then its whole history is inside the window by
definition; otherwise it becomes the baseline and every event after it
differences correctly. The cost is one uncharted turn per thread when the
service starts.

The two charts share one palette, seated per provider rather than per rank, so a
provider is the same colour in both and keeps that colour as other series come
and go. The slots are checked rather than eyeballed: each sits in its mode's
lightness band, clears the chroma floor, holds 3:1 against the surface, and keeps
neighbouring slots apart under simulated protanopia and deuteranopia.

A caveat worth stating plainly: the daily chart's second tier only sees what a
provider actually reports. Providers that never emit `thread/tokenUsage/updated` will
show subscription windows but no token series, and some agents (Factory Droid,
Hermes) keep no usable per-turn token record on disk at all.

## Develop

```bash
npm install --include=dev
bb plugin install .
bb plugin dev
```

## Upgrading from `bb-plugin-dashboard`

This plugin was previously called `dashboard` and its CLI was `bb dashboard`.
The panel, data, and layout are unchanged — the id is now `provider-usage` and
the command is `bb usage`. If you installed the old one from a path, remove it
before installing this one:

```bash
bb plugin remove dashboard
bb plugin install provider-usage
```

To keep your token history, copy the old plugin's database across before
installing:

```bash
cp ~/.bb/plugins/dashboard/data.db ~/.bb/plugins/provider-usage/data.db
```

It is not the same plugin as the marketplace's `usage`, `usage-page`, or
`usage-tracker` entries, which track token spend and estimated API cost. This
one leads with **remaining plan quota and reset windows**, and reads token
volume off local transcripts rather than pricing it.

## Licence

MIT © Braedon Saunders
