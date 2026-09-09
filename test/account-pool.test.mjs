import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { normalizeAccountPool } = await import("../lib/account-pool.ts");
const { assembleDashboard, formatDashboardText } = await import(
  "../lib/dashboard.ts"
);

const RESET_MS = Date.UTC(2026, 8, 15, 1, 46, 54);

/** A pool status payload shaped like `bb pool status --json`. */
const poolStatus = (overrides = {}) => ({
  routing: { claude: false, codex: true },
  accounts: [
    {
      id: "first",
      provider: "codex",
      label: "work@example.com",
      email: "work@example.com",
      enabled: true,
      priority: 100,
      status: "exhausted",
      heldUntil: null,
      error: null,
      limitWindows: [
        {
          slot: "primary",
          windowMinutes: 10080,
          utilization: 1,
          resetAt: RESET_MS,
          status: "rejected",
        },
      ],
    },
    {
      id: "second",
      provider: "codex",
      label: "personal@example.com",
      email: "personal@example.com",
      enabled: true,
      priority: 100,
      status: "ready",
      heldUntil: null,
      error: null,
      limitWindows: [
        {
          slot: "primary",
          windowMinutes: 10080,
          utilization: 0,
          resetAt: RESET_MS,
          status: "allowed",
        },
      ],
    },
  ],
  ...overrides,
});

test("pooled accounts become one meter each, in failover order", () => {
  const pool = normalizeAccountPool(poolStatus());
  assert.equal(pool.codex.length, 2);
  assert.deepEqual(
    pool.codex.map((account) => account.label),
    ["work@example.com", "personal@example.com"],
  );

  const [exhausted, ready] = pool.codex;
  assert.equal(exhausted.unavailable, true);
  assert.equal(ready.unavailable, false);
  // Utilization is a 0-1 fraction: the pool prints 7d=100% for a value of 1.
  assert.equal(exhausted.windows[0].usedPercent, 100);
  assert.equal(exhausted.windows[0].remainingPercent, 0);
  assert.equal(ready.windows[0].remainingPercent, 100);
  assert.equal(exhausted.windows[0].label, "Weekly limit");
  assert.equal(exhausted.windows[0].resetsAt, new Date(RESET_MS).toISOString());
});

test("a provider the pool is not routing keeps its own credentials", () => {
  const pool = normalizeAccountPool(
    poolStatus({ routing: { claude: false, codex: false } }),
  );
  assert.deepEqual(pool, {});
});

test("disabled accounts are left out of the pool meters", () => {
  const status = poolStatus();
  status.accounts[0].enabled = false;
  const pool = normalizeAccountPool(status);
  assert.equal(pool.codex.length, 1);
  assert.equal(pool.codex[0].label, "personal@example.com");
});

test("an account held by a temporary rate limit counts as unavailable", () => {
  const status = poolStatus();
  status.accounts[1].heldUntil = 5_000;
  const pool = normalizeAccountPool(status, 4_000);
  assert.equal(pool.codex[1].unavailable, true);

  const expired = normalizeAccountPool(status, 6_000);
  assert.equal(expired.codex[1].unavailable, false);
});

test("a slot the pool cannot name or time is not charted", () => {
  const status = poolStatus();
  // What the pool posts after a response header mentions a slot it knows
  // nothing else about: no length, no reset, and a zero that is not "empty".
  status.accounts[1].limitWindows.push({
    slot: "secondary",
    windowMinutes: null,
    utilization: 0,
    resetAt: 0,
    status: null,
    source: "header",
  });
  const pool = normalizeAccountPool(status);
  assert.equal(pool.codex[1].windows.length, 1);
  assert.equal(pool.codex[1].windows[0].label, "Weekly limit");

  // A slot with a real reset is still worth showing, even unnamed.
  status.accounts[1].limitWindows[1].resetAt = RESET_MS;
  const timed = normalizeAccountPool(status);
  assert.equal(timed.codex[1].windows.length, 2);
  assert.equal(timed.codex[1].windows[1].label, "Secondary limit");
});

test("the locally signed-in account keeps its named windows", () => {
  const snapshot = assembleDashboard({
    limits: {
      codex: {
        status: "ok",
        accountEmail: "work@example.com",
        windows: [
          { label: "Weekly limit", usedPercent: 100, resetsAt: null },
          {
            label: "GPT-5.3-Codex-Spark · 5-hour limit",
            usedPercent: 10,
            resetsAt: null,
          },
        ],
      },
      claudeCode: { status: "not_installed" },
      cursor: { status: "not_installed" },
      muse: { status: "not_installed" },
    },
    pool: normalizeAccountPool(poolStatus()),
    hosts: [],
    catalog: [{ id: "codex", displayName: "Codex", logoUrl: null }],
    hostId: null,
  });

  const codex = snapshot.providers.find((provider) => provider.key === "codex");
  const [local, remote] = codex.accounts;
  assert.equal(local.local, true);
  assert.equal(remote.local, false);
  // The host names the local account's buckets; the pool only knew one window.
  assert.deepEqual(
    local.windows.map((window) => window.label),
    ["Weekly limit", "GPT-5.3-Codex-Spark · 5-hour limit"],
  );
  assert.equal(remote.windows.length, 1);

  // Those windows belong to the account row now, not to the provider as well.
  const text = formatDashboardText(snapshot);
  assert.equal(text.match(/GPT-5\.3-Codex-Spark/g).length, 1);
  assert.match(text, /work@example\.com · exhausted · signed in here/);
});

test("one limit read twice, seconds apart, is listed once", () => {
  const snapshot = assembleDashboard({
    limits: {
      codex: {
        status: "ok",
        accountEmail: "work@example.com",
        // The host's reading of the weekly window.
        windows: [
          {
            label: "Weekly limit",
            usedPercent: 100,
            resetsAt: "2026-09-15T01:46:56.000Z",
          },
        ],
      },
      claudeCode: { status: "not_installed" },
      cursor: { status: "not_installed" },
      muse: { status: "not_installed" },
    },
    supplements: {
      codex: {
        // The same window from the provider's CLI, read two seconds earlier.
        windows: [
          {
            label: "Weekly limit",
            usedPercent: 100,
            resetsAt: "2026-09-15T01:46:54.000Z",
          },
          {
            label: "GPT-5.3-Codex-Spark · 5-hour limit",
            usedPercent: 0,
            resetsAt: "2026-09-09T06:03:02.000Z",
          },
        ],
        credits: null,
        spendControl: null,
        resetCredits: null,
      },
    },
    pool: normalizeAccountPool(poolStatus()),
    hosts: [],
    catalog: [{ id: "codex", displayName: "Codex", logoUrl: null }],
    hostId: null,
  });

  const codex = snapshot.providers.find((provider) => provider.key === "codex");
  assert.deepEqual(
    codex.windows.map((window) => window.label),
    ["Weekly limit", "GPT-5.3-Codex-Spark · 5-hour limit"],
  );
  assert.deepEqual(
    codex.accounts[0].windows.map((window) => window.label),
    ["Weekly limit", "GPT-5.3-Codex-Spark · 5-hour limit"],
  );
});

test("a genuinely different window of the same name still lists", () => {
  const snapshot = assembleDashboard({
    limits: {
      codex: {
        status: "ok",
        windows: [
          {
            label: "Weekly limit",
            usedPercent: 100,
            resetsAt: "2026-09-15T01:46:56.000Z",
          },
        ],
      },
      claudeCode: { status: "not_installed" },
      cursor: { status: "not_installed" },
      muse: { status: "not_installed" },
    },
    supplements: {
      codex: {
        // A week away: a different window that happens to share a name.
        windows: [
          {
            label: "Weekly limit",
            usedPercent: 0,
            resetsAt: "2026-09-22T01:46:56.000Z",
          },
        ],
        credits: null,
        spendControl: null,
        resetCredits: null,
      },
    },
    hosts: [],
    catalog: [{ id: "codex", displayName: "Codex", logoUrl: null }],
    hostId: null,
  });

  const codex = snapshot.providers.find((provider) => provider.key === "codex");
  assert.equal(codex.windows.length, 2);
});

test("flat window fields are read only when limitWindows is absent", () => {
  const status = poolStatus();
  status.accounts[1].fiveHourUtilization = 0.5;
  status.accounts[1].fiveHourResetAt = RESET_MS;
  const withRows = normalizeAccountPool(status);
  assert.equal(withRows.codex[1].windows.length, 1);

  delete status.accounts[1].limitWindows;
  const withoutRows = normalizeAccountPool(status);
  assert.equal(withoutRows.codex[1].windows.length, 1);
  assert.equal(withoutRows.codex[1].windows[0].label, "5-hour limit");
  assert.equal(withoutRows.codex[1].windows[0].usedPercent, 50);
});

test("a pool that cannot be read leaves the dashboard untouched", () => {
  assert.deepEqual(normalizeAccountPool(null), {});
  assert.deepEqual(normalizeAccountPool({ accounts: "nonsense" }), {});
  assert.deepEqual(normalizeAccountPool({}), {});
});

test("a pooled provider survives a host that reports nothing for it", () => {
  const snapshot = assembleDashboard({
    limits: {
      codex: { status: "unauthenticated" },
      claudeCode: { status: "not_installed" },
      cursor: { status: "not_installed" },
      muse: { status: "not_installed" },
    },
    pool: normalizeAccountPool(poolStatus()),
    hosts: [],
    catalog: [],
    hostId: null,
  });

  const codex = snapshot.providers.find((provider) => provider.key === "codex");
  assert.ok(codex, "a pooled provider stays on the dashboard");
  assert.equal(codex.pooled, true);
  assert.equal(codex.accounts.length, 2);

  // Providers that are neither pooled nor registered still drop out.
  assert.equal(snapshot.providers.length, 1);

  const text = formatDashboardText(snapshot);
  assert.match(text, /pooled · 2 accounts/);
  assert.match(text, /personal@example\.com/);
  // The exhausted account reports its state even though the row is not "ok".
  assert.match(text, /work@example\.com · exhausted/);
});

test("an unpooled dashboard reports no accounts", () => {
  const snapshot = assembleDashboard({
    limits: {
      codex: { status: "ok", windows: [] },
      claudeCode: { status: "not_installed" },
      cursor: { status: "not_installed" },
      muse: { status: "not_installed" },
    },
    hosts: [],
    catalog: [{ id: "codex", displayName: "Codex", logoUrl: null }],
    hostId: null,
  });
  const codex = snapshot.providers.find((provider) => provider.key === "codex");
  assert.equal(codex.pooled, false);
  assert.deepEqual(codex.accounts, []);
});
