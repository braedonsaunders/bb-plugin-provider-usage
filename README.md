# Provider Usage

A BB panel for **how much of your plan is left** and **how many tokens you are
actually burning** — across every provider you are signed in to, on every
machine BB knows about.

<!-- screenshot: docs/panel.png -->

## What it shows

**Subscription windows.** One card per signed-in provider with its plan, each
rate-limit window (5-hour, weekly, monthly — whatever the provider reports),
percent used, percent left, and when it resets. Windows are colour-toned so a
nearly-exhausted one is obvious at a glance.

**Headline metrics.** Providers signed in, cumulative remaining across all of
them, the single tightest window right now, and the next reset — absolute and
relative.

**Token usage.** A 7 / 30 / 90-day multi-series chart of real token volume read
straight off local transcripts — Codex (`~/.codex`, or `$CODEX_HOME`), Claude
Code (`~/.claude`, or `$CLAUDE_CONFIG_DIR`), Cursor's ACP session stores, and
opencode (`~/.local/share/opencode`, or `$XDG_DATA_HOME/opencode`) — broken out
into total, input, output, and cached, per provider.

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
