import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const { createLimitsStore } = await import("../lib/limit-store.ts");
const { overlayLastGoodLimits, shouldReuseCachedLimits, LIMITS_TTL_MS, RATE_LIMIT_BACKOFF_MS } = await import("../lib/limits-cache.ts");
const limits = (email = "local@example.com", used = 1, status = "ok") => ({
  codex: { status: "not_installed" }, cursor: { status: "not_installed" }, muse: { status: "not_installed" },
  claudeCode: { status, accountEmail: email, windows: status === "ok" ? [{ label: "Session", usedPercent: used, resetsAt: null }] : [],
    ...(status === "error" ? { message: "Claude usage is rate limited right now." } : {}) },
});
const extras = { windows: [], credits: null, spendControl: null,
  resetCredits: { availableCount: 1, title: "Reset", description: null, nextExpiresAt: null } };
const harness = (fetchLimits, fetchClaude = async () => null) => {
  const cache = new Map();
  let now = 1_000_000;
  const deps = { read: (k) => cache.get(k), write: (k, v) => cache.set(k, structuredClone(v)),
    fetchLimits, fetchClaude, now: () => now };
  return { store: createLimitsStore(deps), deps, advance: () => { now += LIMITS_TTL_MS + 1; } };
};

test("a rate-limited new login never borrows the previous login's quota", () => {
  const fresh = limits("new@example.com", 0, "error");
  const result = overlayLastGoodLimits(fresh, limits("old@example.com", 90));
  assert.equal(result.claudeCode.status, "error");
  assert.deepEqual(result.claudeCode.windows, []);
  const same = overlayLastGoodLimits(limits("old@example.com", 0, "error"), limits("old@example.com", 90));
  assert.equal(same.claudeCode.windows[0].usedPercent, 90);
  assert.match(same.claudeCode.message, /cached usage/);
});

test("TTL, backoff and force honor their time boundaries", () => {
  const args = { nowMs: LIMITS_TTL_MS - 1, fetchedAtMs: 0, rateLimitedAtMs: null };
  assert.equal(shouldReuseCachedLimits(args), true);
  assert.equal(shouldReuseCachedLimits({ ...args, nowMs: LIMITS_TTL_MS }), false);
  assert.equal(shouldReuseCachedLimits({ ...args, nowMs: RATE_LIMIT_BACKOFF_MS - 1, rateLimitedAtMs: 0 }), true);
  assert.equal(shouldReuseCachedLimits({ ...args, nowMs: RATE_LIMIT_BACKOFF_MS, rateLimitedAtMs: 0 }), false);
  assert.equal(shouldReuseCachedLimits({ ...args, force: true }), false);
});

test("concurrent machine requests are isolated and same-machine force is coalesced", async () => {
  const pending = new Map();
  let calls = 0;
  const { store } = harness((host) => { calls++; return new Promise((resolve) => pending.set(host, resolve)); });
  const local = store.get(null);
  const localForce = store.get(null, true);
  const remote = store.get("remote");
  assert.equal(calls, 2);
  pending.get("remote")(limits("remote@example.com", 80));
  pending.get(null)(limits("local@example.com", 1));
  assert.equal((await remote).limits.claudeCode.accountEmail, "remote@example.com");
  assert.equal((await local).limits.claudeCode.accountEmail, "local@example.com");
  assert.deepEqual(await localForce, await local);
});

test("last-good windows never cross machine boundaries or plugin reloads", async () => {
  let remote429 = false;
  const { store, deps, advance } = harness(async (host) => host
    ? limits("remote@example.com", 80, remote429 ? "error" : "ok")
    : limits("local@example.com", 1));
  await store.get("remote"); await store.get(null);
  advance(); remote429 = true;
  const reloaded = createLimitsStore(deps);
  const remote = await reloaded.get("remote");
  assert.equal(remote.limits.claudeCode.windows[0].usedPercent, 80);
  assert.equal(remote.claudeSupplement, null);
});

test("successful empty Claude reset inventory clears the cached grant", async () => {
  let supplement = extras;
  const { store, advance } = harness(async () => limits(), async () => supplement);
  assert.equal((await store.get(null)).claudeSupplement.resetCredits.availableCount, 1);
  advance(); supplement = { ...extras, resetCredits: null };
  assert.equal((await store.get(null)).claudeSupplement.resetCredits, null);
});

test("failed supplementary read does not relabel old grants after switching login", async () => {
  let email = "first@example.com";
  let supplement = extras;
  const { store, advance } = harness(async () => limits(email), async () => supplement);
  await store.get(null);
  advance(); email = "second@example.com"; supplement = null;
  assert.equal((await store.get(null)).claudeSupplement, null);
});

test("failed machine fetch clears its inflight slot so the next read can recover", async () => {
  let fail = true;
  const { store } = harness(async () => { if (fail) throw new Error("offline"); return limits(); });
  await assert.rejects(store.get(null), /offline/);
  fail = false;
  assert.equal((await store.get(null)).limits.claudeCode.status, "ok");
});
