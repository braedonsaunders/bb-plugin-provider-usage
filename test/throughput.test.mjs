import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Same extensionless-import shim the token accounting tests use.
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

const {
  assembleThroughputSnapshot,
  createThroughputRecorder,
  THROUGHPUT_BIN_MS,
  THROUGHPUT_WINDOW_MS,
} = await import("../lib/throughput.ts");
const { createThroughputScanner } = await import("../lib/throughput-scan.ts");
const { providerSlotIndex } = await import("../lib/series-palette.ts");

const NOW = 1_760_000_000_000;

function bucket(tokens, extra = {}) {
  return {
    tokens,
    input: extra.input ?? tokens,
    output: extra.output ?? 0,
    cached: extra.cached ?? 0,
    reasoning: extra.reasoning ?? 0,
    turns: 1,
  };
}

function delta(atMs, providerId, tokens, threadId = "thr_1") {
  return { atMs, threadId, providerId, bucket: bucket(tokens) };
}

test("the chart spans the whole window even when only one bin has data", () => {
  const snapshot = assembleThroughputSnapshot({
    nowMs: NOW,
    deltas: [delta(NOW - 5_000, "codex", 1_000)],
  });

  assert.equal(
    snapshot.series.length,
    THROUGHPUT_WINDOW_MS / THROUGHPUT_BIN_MS,
  );
  const populated = snapshot.series.filter((point) => point.total > 0);
  assert.equal(populated.length, 1);
  assert.equal(populated[0].byProvider.codex, 1_000);
  assert.equal(snapshot.windowTotals.tokens, 1_000);
});

test("the headline rate counts only the trailing rate window", () => {
  const snapshot = assembleThroughputSnapshot({
    nowMs: NOW,
    deltas: [
      delta(NOW - 30_000, "codex", 600),
      delta(NOW - 5 * 60_000, "codex", 90_000),
    ],
  });

  // 600 tokens inside the trailing 60s is exactly 600/min.
  assert.equal(Math.round(snapshot.tokensPerMinute), 600);
  assert.equal(snapshot.windowTotals.tokens, 90_600);
  assert.equal(snapshot.live, true);
});

test("peak keeps an earlier burst after the current rate falls back", () => {
  const snapshot = assembleThroughputSnapshot({
    nowMs: NOW,
    deltas: [delta(NOW - 6 * 60_000, "codex", 50_000)],
  });

  assert.equal(snapshot.tokensPerMinute, 0);
  assert.equal(Math.round(snapshot.peakTokensPerMinute), 50_000);
  assert.equal(snapshot.live, false);
});

test("turns older than the window are dropped, not clamped into it", () => {
  const recorder = createThroughputRecorder();
  recorder.record(delta(NOW - THROUGHPUT_WINDOW_MS - 1_000, "codex", 5_000), NOW);
  recorder.record(delta(NOW - 20_000, "codex", 7), NOW);

  const snapshot = recorder.snapshot(NOW);
  assert.equal(snapshot.windowTotals.tokens, 7);
});

test("a turn timestamped in the future is pulled back to now", () => {
  const recorder = createThroughputRecorder();
  recorder.record(delta(NOW + 60_000, "codex", 400), NOW);

  const snapshot = recorder.snapshot(NOW);
  assert.equal(snapshot.windowTotals.tokens, 400);
  assert.equal(snapshot.series.at(-1).total, 400);
});

test("providers past the palette's seats fold into one Other series", () => {
  const deltas = [];
  for (let index = 0; index < 9; index += 1) {
    deltas.push(delta(NOW - 10_000, `agent-${index}`, 9 - index, `thr_${index}`));
  }
  const snapshot = assembleThroughputSnapshot({ nowMs: NOW, deltas });

  const ids = snapshot.providers.map((provider) => provider.id);
  assert.equal(ids.length, 6);
  assert.equal(ids.filter((id) => id === "other").length, 1);
  assert.equal(ids.at(-1), "other");
  // Nothing is lost in the fold.
  assert.equal(
    snapshot.providers.reduce((sum, provider) => sum + provider.tokens, 0),
    45,
  );
});

test("series are ordered by palette seat, not by volume", () => {
  const snapshot = assembleThroughputSnapshot({
    nowMs: NOW,
    deltas: [
      delta(NOW - 10_000, "codex", 10, "thr_a"),
      delta(NOW - 10_000, "claude-code", 9_000, "thr_b"),
    ],
  });

  assert.deepEqual(
    snapshot.providers.map((provider) => provider.id),
    ["claude-code", "codex"],
  );
  assert.ok(providerSlotIndex("claude-code") < providerSlotIndex("codex"));
});

test("thread rows carry the title and mark recent work as active", () => {
  const snapshot = assembleThroughputSnapshot({
    nowMs: NOW,
    deltas: [
      delta(NOW - 10_000, "codex", 500, "thr_live"),
      delta(NOW - 10 * 60_000, "codex", 800, "thr_old"),
    ],
    threads: [
      {
        threadId: "thr_live",
        providerId: "codex",
        title: "Ship the update",
        status: "active",
      },
    ],
  });

  assert.equal(snapshot.threads.length, 2);
  assert.equal(snapshot.activeThreads, 1);
  const live = snapshot.threads.find((row) => row.threadId === "thr_live");
  assert.equal(live.title, "Ship the update");
  const old = snapshot.threads.find((row) => row.threadId === "thr_old");
  assert.equal(old.title, "Untitled thread");
});

function scannerHarness(events, thread = {}) {
  const recorder = createThroughputRecorder();
  const calls = [];
  const scanner = createThroughputScanner(recorder, {
    listThreads: async () => [
      {
        id: "thr_1",
        providerId: "acp-cursor",
        title: "A thread",
        status: "active",
        updatedAt: NOW,
        // Old enough that its history predates the chart window.
        createdAt: NOW - 6 * 60 * 60_000,
        ...thread,
      },
    ],
    listEvents: async (args) => {
      calls.push(args);
      const rows = args.afterSeq
        ? events.filter((event) => event.seq > args.afterSeq)
        : events;
      const ordered =
        args.order === "desc" ? [...rows].reverse() : [...rows];
      return ordered.slice(0, args.limit);
    },
  });
  return { recorder, scanner, calls };
}

test("the scanner differences running totals and strips the acp- prefix", async () => {
  const { recorder, scanner } = scannerHarness([
    {
      seq: 1,
      createdAt: NOW - 40_000,
      total: { totalTokens: 1_000, inputTokens: 900, outputTokens: 100 },
      last: { totalTokens: 400, inputTokens: 380, outputTokens: 20 },
    },
    {
      seq: 2,
      createdAt: NOW - 20_000,
      total: { totalTokens: 2_500, inputTokens: 2_200, outputTokens: 300 },
      last: { totalTokens: 1_500, inputTokens: 1_300, outputTokens: 200 },
    },
  ]);

  await scanner.refresh(NOW);
  const snapshot = recorder.snapshot(NOW);

  // The first event of an older thread is a baseline only — its running total
  // of 1,000 includes history from before the window, and `last` is not a
  // trustworthy step. The second event differences cleanly to 1,500.
  assert.equal(snapshot.windowTotals.tokens, 1_500);
  assert.deepEqual(
    snapshot.providers.map((provider) => provider.id),
    ["cursor"],
  );
});

test("a thread created inside the window charts its whole history", async () => {
  const { recorder, scanner } = scannerHarness(
    [
      {
        seq: 1,
        createdAt: NOW - 40_000,
        total: { totalTokens: 1_000, inputTokens: 1_000, outputTokens: 0 },
        last: { totalTokens: 400, inputTokens: 400, outputTokens: 0 },
      },
    ],
    { createdAt: NOW - 3 * 60_000 },
  );

  await scanner.refresh(NOW);

  // Nothing in this thread's life happened before the window, so the running
  // total is entirely throughput the chart should show.
  assert.equal(recorder.snapshot(NOW).windowTotals.tokens, 1_000);
});

test("a session-total event is taken as a baseline, never charted as a spike", async () => {
  // The shape BB's Claude Code bridge emits for a resumed thread: `last` is
  // usage since the session resumed — hours of it — not a single step. Both
  // figures are far too large to have happened inside the window.
  const events = [
    {
      seq: 1,
      createdAt: NOW - 60_000,
      total: { totalTokens: 98_703_185, inputTokens: 98_000_000, outputTokens: 703_185 },
      last: { totalTokens: 55_893_573, inputTokens: 55_800_000, outputTokens: 93_573 },
    },
  ];
  const { recorder, scanner } = scannerHarness(events);

  await scanner.refresh(NOW);
  assert.equal(recorder.snapshot(NOW).windowTotals.tokens, 0);

  // The next turn differences against that baseline and charts normally.
  events.push({
    seq: 2,
    createdAt: NOW - 10_000,
    total: { totalTokens: 98_815_444, inputTokens: 98_100_000, outputTokens: 715_444 },
    last: { totalTokens: 56_005_832, inputTokens: 55_900_000, outputTokens: 105_832 },
  });
  await scanner.refresh(NOW);
  assert.equal(recorder.snapshot(NOW).windowTotals.tokens, 112_259); // 98,815,444 − 98,703,185
});

test("a second refresh reads only past the cursor and adds the new turn", async () => {
  const events = [
    {
      seq: 1,
      createdAt: NOW - 40_000,
      total: { totalTokens: 1_000, inputTokens: 1_000, outputTokens: 0 },
    },
  ];
  const { recorder, scanner, calls } = scannerHarness(events);

  await scanner.refresh(NOW);
  events.push({
    seq: 2,
    createdAt: NOW - 5_000,
    total: { totalTokens: 1_750, inputTokens: 1_600, outputTokens: 150 },
  });
  await scanner.refresh(NOW);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].afterSeq, undefined);
  assert.equal(calls[1].afterSeq, 1);
  // The seq-1 running total was a baseline; only the 750 difference is charted.
  assert.equal(recorder.snapshot(NOW).windowTotals.tokens, 750);
});

test("a truncated first read still only baselines its oldest row", async () => {
  const events = [];
  for (let index = 1; index <= 320; index += 1) {
    events.push({
      seq: index,
      createdAt: NOW - 60_000 + index * 100,
      total: {
        totalTokens: index * 1_000,
        inputTokens: index * 1_000,
        outputTokens: 0,
      },
    });
  }
  const { recorder, scanner } = scannerHarness(events);

  await scanner.refresh(NOW);
  const snapshot = recorder.snapshot(NOW);

  // The tail holds 300 rows; the oldest sets the baseline and the remaining
  // 299 differences are 1,000 each. Charting that first row instead would have
  // dropped its whole 21,000,000-token running total onto one instant.
  assert.equal(snapshot.windowTotals.tokens, 299_000);
});

test("threads that disappear stop being tracked", async () => {
  const recorder = createThroughputRecorder();
  let threads = [
    {
      id: "thr_1",
      providerId: "codex",
      title: "One",
      status: "active",
      updatedAt: NOW,
      createdAt: NOW - 60_000,
    },
  ];
  const scanner = createThroughputScanner(recorder, {
    listThreads: async () => threads,
    listEvents: async () => [
      {
        seq: 1,
        createdAt: NOW - 5_000,
        total: { totalTokens: 500, inputTokens: 500, outputTokens: 0 },
      },
    ],
  });

  const first = await scanner.refresh(NOW);
  assert.equal(first.tracked, 1);
  assert.equal(first.working, 1);

  threads = [];
  const second = await scanner.refresh(NOW);
  assert.equal(second.tracked, 0);
  assert.equal(recorder.snapshot(NOW).threads.length, 1); // the turn still happened
});
