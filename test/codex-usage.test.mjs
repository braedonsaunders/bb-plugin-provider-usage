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

const { normalizeCodexRateLimits } = await import("../lib/codex-usage.ts");
const { assembleDashboard, formatDashboardText } = await import(
  "../lib/dashboard.ts"
);

const resetAt = 1_788_137_121;
const expiryAt = 1_789_948_554;

function codexResponse() {
  return {
    rateLimits: {
      limitId: "codex",
      limitName: null,
      primary: {
        usedPercent: 24,
        windowDurationMins: 10_080,
        resetsAt: resetAt,
      },
      secondary: null,
      credits: {
        hasCredits: true,
        unlimited: false,
        balance: "1340.8487690000",
      },
      individualLimit: null,
      spendControlReached: false,
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: null,
        primary: {
          usedPercent: 24,
          windowDurationMins: 10_080,
          resetsAt: resetAt,
        },
        secondary: null,
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: "1340.8487690000",
        },
        individualLimit: {
          used: "12.50",
          limit: "100.00",
          remainingPercent: 87.5,
          resetsAt: resetAt,
        },
        spendControlReached: false,
      },
      codex_bengalfox: {
        limitId: "codex_bengalfox",
        limitName: "GPT-5.3-Codex-Spark",
        primary: {
          usedPercent: 0,
          windowDurationMins: 300,
          resetsAt: resetAt + 3_600,
        },
        secondary: {
          usedPercent: 0,
          windowDurationMins: 10_080,
          resetsAt: resetAt + 86_400,
        },
        credits: null,
        individualLimit: null,
      },
    },
    rateLimitResetCredits: {
      availableCount: 1,
      credits: [
        {
          id: "reset_1",
          status: "available",
          expiresAt: expiryAt,
          title: "Full reset",
          description: "One free rate limit reset.",
        },
      ],
    },
  };
}

test("Codex rate-limit response exposes credits, banked resets and spend control", () => {
  const supplement = normalizeCodexRateLimits(codexResponse());
  assert.ok(supplement);
  assert.deepEqual(
    supplement.windows.map((window) => window.label),
    [
      "Weekly limit",
      "GPT-5.3-Codex-Spark · 5-hour limit",
      "GPT-5.3-Codex-Spark · Weekly limit",
    ],
  );
  assert.deepEqual(supplement.credits, {
    hasCredits: true,
    unlimited: false,
    balance: "1340.8487690000",
  });
  assert.deepEqual(supplement.spendControl, {
    used: "12.50",
    limit: "100.00",
    remainingPercent: 87.5,
    resetsAt: new Date(resetAt * 1_000).toISOString(),
    reached: false,
  });
  assert.deepEqual(supplement.resetCredits, {
    availableCount: 1,
    nextExpiresAt: new Date(expiryAt * 1_000).toISOString(),
    title: "Full reset",
    description: "One free rate limit reset.",
  });
});

test("dashboard merges Codex additions without duplicating BB's weekly window", () => {
  const supplement = normalizeCodexRateLimits(codexResponse());
  assert.ok(supplement);
  const dashboard = assembleDashboard({
    limits: {
      codex: {
        status: "ok",
        accountEmail: "person@example.com",
        planLabel: "Pro",
        windows: [
          {
            label: "Weekly limit",
            usedPercent: 24,
            resetsAt: new Date(resetAt * 1_000).toISOString(),
          },
        ],
      },
      claudeCode: { status: "not_installed" },
      cursor: { status: "not_installed" },
    },
    supplements: { codex: supplement },
    hosts: [{ id: "local", name: "Local", status: "connected" }],
    catalog: [],
    hostId: null,
    fetchedAt: "2026-08-24T12:00:00.000Z",
  });

  const codex = dashboard.providers[0];
  assert.equal(codex.windows.length, 3);
  assert.equal(codex.resetCredits?.availableCount, 1);
  assert.equal(codex.spendControl?.used, "12.50");

  const text = formatDashboardText(dashboard);
  assert.match(text, /Credit balance\s+1,340\.85 credits/);
  assert.match(text, /Banked resets\s+1 available/);
  assert.match(text, /On-demand period\s+12\.50 of 100\.00 used/);
});

const {
  hasRateLimitedProvider,
  overlayLastGoodLimits,
  rememberGoodLimits,
  shouldReuseCachedLimits,
} = await import("../lib/limits-cache.ts");

test("a Claude 429 reuses the last good windows instead of blanking the meter", () => {
  const lastGood = rememberGoodLimits({
    codex: { status: "ok", windows: [{ label: "Weekly", usedPercent: 10, resetsAt: null }] },
    claudeCode: {
      status: "ok",
      planLabel: "Max (20x)",
      accountEmail: "person@example.com",
      windows: [
        { label: "Current session", usedPercent: 41, resetsAt: "2026-08-27T00:00:00.000Z" },
        { label: "Weekly limit", usedPercent: 62, resetsAt: "2026-09-01T00:00:00.000Z" },
      ],
    },
    cursor: { status: "ok", windows: [] },
  });

  const fresh = overlayLastGoodLimits(
    {
      codex: { status: "ok", windows: [{ label: "Weekly", usedPercent: 12, resetsAt: null }] },
      claudeCode: {
        status: "error",
        message: "Claude usage is rate limited right now. Try again shortly.",
        planLabel: "Max (20x)",
        accountEmail: "person@example.com",
      },
      cursor: { status: "ok", windows: [] },
    },
    lastGood,
  );

  assert.equal(hasRateLimitedProvider({
    ...fresh,
    claudeCode: {
      status: "error",
      message: "Claude usage is rate limited right now. Try again shortly.",
    },
  }), true);
  assert.equal(fresh.claudeCode.status, "ok");
  assert.equal(fresh.claudeCode.windows?.[0]?.usedPercent, 41);
  assert.equal(fresh.codex.windows?.[0]?.usedPercent, 12);
});

test("limits cache is reused inside the TTL and after a rate-limit backoff", () => {
  assert.equal(
    shouldReuseCachedLimits({
      nowMs: 10_000,
      fetchedAtMs: 1_000,
      rateLimitedAtMs: null,
    }),
    true,
  );
  assert.equal(
    shouldReuseCachedLimits({
      nowMs: 10 * 60_000,
      fetchedAtMs: 1_000,
      rateLimitedAtMs: null,
    }),
    false,
  );
  assert.equal(
    shouldReuseCachedLimits({
      nowMs: 10 * 60_000,
      fetchedAtMs: 1_000,
      rateLimitedAtMs: 8 * 60_000,
    }),
    true,
  );
  assert.equal(
    shouldReuseCachedLimits({
      nowMs: 10 * 60_000,
      fetchedAtMs: 1_000,
      rateLimitedAtMs: 8 * 60_000,
      force: true,
    }),
    false,
  );
});
