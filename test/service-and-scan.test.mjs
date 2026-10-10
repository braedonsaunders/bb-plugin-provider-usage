import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const { abortableDelay } = await import("../lib/abort-delay.ts");
const { readAllUsageEvents, scanBbThreadUsage } = await import("../lib/bb-usage-scan.ts");

test("poll delays release their abort listeners when the timer completes", async () => {
  const controller = new AbortController();
  for (let index = 0; index < 25; index++) await abortableDelay(controller.signal, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("poll cancellation clears its timer and works for an already-aborted signal", async () => {
  const controller = new AbortController();
  const pending = abortableDelay(controller.signal, 60_000);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort();
  await pending;
  await abortableDelay(controller.signal, 60_000);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("historical event pagination reads all 250 rows with capped SDK requests", async () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ seq: i + 1 }));
  const calls = [];
  const result = await readAllUsageEvents(async (args) => {
    calls.push(args);
    assert.equal(args.limit, 100);
    return rows.filter((row) => row.seq > (args.afterSeq ?? 0)).slice(0, args.limit);
  });
  assert.deepEqual(result, rows);
  assert.deepEqual(calls.map((args) => args.afterSeq), [undefined, 100, 200]);
});

test("pagination rejects a stuck cursor rather than looping forever", async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ seq: i + 1 }));
  await assert.rejects(readAllUsageEvents(async () => rows), /did not advance/);
});

test("Muse transcripts suppress the BB history fallback to avoid double counting", async () => {
  let reads = 0;
  const result = await scanBbThreadUsage({
    listThreads: async () => [{ id: "muse", providerId: "muse", updatedAt: Date.now() }],
    listEvents: async () => { reads++; return [{ seq: 1, createdAt: Date.now(), total: { totalTokens: 100 } }]; },
  });
  assert.equal(reads, 0);
  assert.deepEqual(result.daily, {});
});

test("remote Muse and Codex threads use BB history because their transcripts are not local", async () => {
  const result = await scanBbThreadUsage({
    localHostId: "mac",
    listThreads: async () => [
      { id: "local", providerId: "muse", hostId: "mac", updatedAt: Date.now() },
      { id: "remote", providerId: "muse", hostId: "gpu", updatedAt: Date.now() },
      { id: "remote-codex", providerId: "codex", hostId: "gpu", updatedAt: Date.now() },
    ],
    listEvents: async (id) => {
      assert.notEqual(id, "local");
      return [{ seq: 1, createdAt: Date.now(), total: { totalTokens: 100 } }];
    },
  });
  assert.deepEqual(result.providers.sort(), ["codex", "muse"]);
  assert.equal(result.threadsScanned, 2);
});
