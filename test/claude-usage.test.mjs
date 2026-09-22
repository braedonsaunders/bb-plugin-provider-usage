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

const { normalizeClaudeUsage } = await import("../lib/claude-usage.ts");
const { assembleDashboard, formatDashboardText } = await import(
  "../lib/dashboard.ts"
);

function emptyLimits() {
  return {
    codex: { status: "not_installed" },
    claudeCode: {
      status: "ok",
      accountEmail: "person@example.com",
      planLabel: "Max (20x)",
      windows: [
        {
          label: "Current session",
          usedPercent: 28,
          resetsAt: "2026-09-22T22:30:00.000Z",
        },
        {
          label: "Weekly limit",
          usedPercent: 0,
          resetsAt: "2026-09-26T09:00:00.000Z",
        },
      ],
    },
    cursor: { status: "not_installed" },
    muse: { status: "not_installed" },
  };
}

test("Claude cedar_ember grants become banked resets like Codex", () => {
  const supplement = normalizeClaudeUsage({
    cedar_ember: {
      eligible: true,
      grants: [
        {
          id: "grant_1",
          label: "Full reset",
          resets_total: 1,
          resets_left: 1,
          ends_at: "2026-10-06T12:00:00+00:00",
          paused: false,
        },
      ],
    },
    juniper_tide: null,
  });
  assert.deepEqual(supplement?.resetCredits, {
    availableCount: 1,
    nextExpiresAt: "2026-10-06T12:00:00.000Z",
    title: "Full reset",
    description: "Full reset",
  });
});

test("Claude weekly session reset counts as one available banked reset", () => {
  const supplement = normalizeClaudeUsage({
    cedar_ember: { eligible: true, grants: [] },
    juniper_tide: {
      eligible: true,
      available: true,
      resets_per_week: 1,
      next_available_at: null,
    },
  });
  assert.equal(supplement?.resetCredits?.availableCount, 1);
  assert.equal(supplement?.resetCredits?.title, "Session reset");
});

test("a surface-ineligible unused weekly reset is still banked on the account", () => {
  const supplement = normalizeClaudeUsage({
    cedar_ember: {
      eligible: false,
      ineligible_reason: "surface",
      grants: [],
    },
    juniper_tide: {
      eligible: false,
      ineligible_reason: "surface",
      available: false,
      next_available_at: null,
      weekly_resets_at: null,
      resets_per_week: 1,
    },
  });
  assert.deepEqual(supplement?.resetCredits, {
    availableCount: 1,
    nextExpiresAt: null,
    title: "Session reset",
    description: "Uses weekly limit · 1/week",
  });
});

test("a spent weekly reset reports zero with the next-available time", () => {
  const supplement = normalizeClaudeUsage({
    cedar_ember: { eligible: true, grants: [] },
    juniper_tide: {
      eligible: true,
      available: false,
      next_available_at: "2026-09-29T09:00:00+00:00",
      resets_per_week: 1,
    },
  });
  assert.deepEqual(supplement?.resetCredits, {
    availableCount: 0,
    nextExpiresAt: "2026-09-29T09:00:00.000Z",
    title: "Session reset",
    description: "Uses weekly limit · 1/week",
  });
});

test("paused grants and empty payloads disappear instead of faking a zero", () => {
  assert.equal(
    normalizeClaudeUsage({
      cedar_ember: {
        grants: [{ id: "x", resets_left: 1, paused: true }],
      },
    }),
    null,
  );
  assert.equal(normalizeClaudeUsage({ five_hour: { utilization: 10 } }), null);
  assert.equal(normalizeClaudeUsage(null), null);
});

test("dashboard prints Claude banked resets the way it prints Codex", () => {
  const supplement = normalizeClaudeUsage({
    juniper_tide: {
      eligible: false,
      ineligible_reason: "surface",
      available: false,
      resets_per_week: 1,
    },
  });
  assert.ok(supplement);
  const dashboard = assembleDashboard({
    limits: emptyLimits(),
    supplements: { claudeCode: supplement },
    hosts: [{ id: "local", name: "Local", status: "connected" }],
    catalog: [],
    hostId: null,
    fetchedAt: "2026-09-22T17:00:00.000Z",
  });
  const claude = dashboard.providers.find((row) => row.key === "claudeCode");
  assert.equal(claude?.resetCredits?.availableCount, 1);
  assert.match(formatDashboardText(dashboard), /Banked resets\s+1 available/);
});
