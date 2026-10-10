import assert from "node:assert/strict";
import test from "node:test";
import { createTokenRangeStore, dayKey, emptyBucket } from "../lib/tokens.ts";

test("all date ranges project the complete ledger including BB-only providers", () => {
  const store = createTokenRangeStore();
  assert.equal(store.get(7), null);
  const old = new Date(); old.setDate(old.getDate() - 20);
  store.update({ fileCount: 3, changedFiles: 1, sources: ["claude-code", "pi"],
    scannedAt: "2026-10-10T16:00:00Z", daily: {
      [dayKey(Date.now())]: { pi: { ...emptyBucket(), tokens: 100 } },
      [dayKey(old.getTime())]: { pi: { ...emptyBucket(), tokens: 200 } },
    } });
  const week = store.get(7);
  const month = store.get(30);
  assert.equal(week.days, 7);
  assert.equal(week.series.length, 7);
  assert.equal(week.providers[0].id, "pi");
  assert.equal(week.totals.tokens, 100);
  assert.equal(month.days, 30);
  assert.equal(month.totals.tokens, 300);
  assert.deepEqual(store.get(90).sources, ["claude-code", "pi"]);
  assert.equal(month.scannedAt, week.scannedAt);
  assert.equal(store.get(7).days, 7);
});
