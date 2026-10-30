import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
registerHooks({ resolve(s, c, next) {
  try { return next(s, c); } catch (e) {
    if (s.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(s)) return next(`${s}.ts`, c);
    throw e;
  }
} });
const { normalizeAntigravityUsage, readAntigravityUsage } = await import("../lib/antigravity-usage.ts");
const { normalizeProviderLimits } = await import("../lib/provider-limits.ts");
const { assembleDashboard } = await import("../lib/dashboard.ts");
const reset = "2026-11-01T00:00:00Z";
const report = (buckets) => ({ status: "SUCCESS", command: { name: "usage", data: { groups: [
  { name: "Gemini Models", buckets: buckets ?? [
    { window: "weekly", remaining_fraction: 0.8, reset_time: reset },
    { window: "5h", remaining_fraction: 0, reset_time: reset },
  ] },
  { name: "Claude and GPT models", buckets: [{ window: "weekly", remaining_fraction: 1, reset_time: reset }] },
] } } });

test("Antigravity shows separate model families and puts the short Gemini limit first", () => {
  const result = normalizeAntigravityUsage(report());
  assert.equal(result.status, "ok");
  assert.equal(result.windows.length, 3);
  assert.equal(result.windows[0].label, "Gemini Models · 5-hour limit");
  assert.equal(result.windows[0].usedPercent, 100);
  assert.equal(Math.round(result.windows[1].usedPercent), 20);
  assert.equal(result.windows[2].usedPercent, 0);
  assert.equal(result.windows[0].resetsAt, "2026-11-01T00:00:00.000Z");
});

test("invalid quota values never invent full remaining usage", () => {
  for (const value of [null, NaN, "0.5", 2, -1]) {
    const result = normalizeAntigravityUsage(report([{ remaining_fraction: value }]));
    assert.equal(result.windows.length, 1); // Only the valid Claude/GPT bucket.
  }
  const result = normalizeAntigravityUsage({ status: "SUCCESS", command: { name: "usage", data: { groups: [] } } });
  assert.deepEqual(result.windows, []);
  assert.match(result.message, /unknown/);
  assert.equal(normalizeAntigravityUsage({ response: "100%" }).status, "error");
});

test("optional Antigravity appears with real windows and participates in dashboard totals", () => {
  assert.equal(normalizeProviderLimits({}).antigravity.status, "not_installed");
  const result = assembleDashboard({ limits: normalizeProviderLimits({ "acp-antigravity": normalizeAntigravityUsage(report()) }),
    hosts: [], hostId: null, catalog: [{ id: "acp-antigravity", displayName: "Google Antigravity", logoUrl: null }] });
  const provider = result.providers.find((p) => p.key === "antigravity");
  assert.equal(provider.id, "acp-antigravity");
  assert.equal(provider.windows[0].remainingPercent, 0);
  assert.equal(result.totals.windowCount, 3);
});

test("CLI errors and malformed output never expose subprocess credentials", async () => {
  assert.equal((await readAntigravityUsage({ run: async () => JSON.stringify(report()) })).status, "ok");
  for (const run of [async () => "PRIVATE TOKEN", async () => { throw new Error("PRIVATE TOKEN"); }]) {
    const result = await readAntigravityUsage({ run });
    assert.equal(result.status, "error");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
  assert.equal((await readAntigravityUsage({ run: async () => { throw Object.assign(new Error(), { code: "ENOENT" }); } })).status, "not_installed");
});
