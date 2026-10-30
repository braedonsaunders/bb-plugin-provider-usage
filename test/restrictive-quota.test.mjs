import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
registerHooks({ resolve(s, c, next) {
  try { return next(s, c); } catch (e) {
    if (s.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(s)) return next(`${s}.ts`, c);
    throw e;
  }
} });
const { assembleDashboard, heroWindow } = await import("../lib/dashboard.ts");
const { normalizeProviderLimits } = await import("../lib/provider-limits.ts");
const snapshot = (windows, extra = {}) => assembleDashboard({
  limits: normalizeProviderLimits({ muse: { status: "ok", windows }, ...extra }),
  hosts: [], catalog: [{ id: "muse", displayName: "Muse Code", logoUrl: null }], hostId: null,
});
const window = (label, usedPercent) => ({ label, usedPercent, resetsAt: null });

test("an exhausted weekly quota controls Muse's headline and navigation total", () => {
  for (const windows of [
    [window("5-hour limit", 0), window("Weekly limit", 100)],
    [window("Weekly limit", 100), window("5-hour limit", 0)],
  ]) {
    const result = snapshot(windows);
    assert.equal(heroWindow(result.providers.find(p => p.key === "muse")).remainingPercent, 0);
    assert.equal(heroWindow(result.providers.find(p => p.key === "muse")).label, "Weekly limit");
    assert.equal(result.totals.cumulativeRemainingPercent, 0);
  }
});

test("rail totals average the restrictive quota of each provider once", () => {
  const result = snapshot([window("5-hour limit", 0), window("Weekly limit", 99)], {
    codex: { status: "ok", windows: [window("5-hour limit", 10), window("Weekly limit", 80)] },
  });
  assert.equal(heroWindow(result.providers.find(p => p.key === "muse")).remainingPercent, 1);
  assert.equal(result.totals.cumulativeRemainingPercent, 10.5); // Muse 1 + Codex 20.
});

test("shorter windows can also constrain quota and unknown usage stays unknown", () => {
  const result = snapshot([window("5-hour limit", 95), window("Weekly limit", 10)]);
  assert.equal(heroWindow(result.providers.find(p => p.key === "muse")).remainingPercent, 5);
  assert.equal(result.totals.cumulativeRemainingPercent, 5);
  assert.equal(snapshot([]).totals.cumulativeRemainingPercent, null);
});

test("separate paid spending budgets do not replace a subscription quota headline", () => {
  const result = snapshot([window("Weekly limit", 50), {
    ...window("Extra spend", 100), cost: { usedUsdCents: 100, limitUsdCents: 100 },
  }]);
  assert.equal(heroWindow(result.providers.find(p => p.key === "muse")).remainingPercent, 50);
  assert.equal(result.totals.cumulativeRemainingPercent, 50);
});
