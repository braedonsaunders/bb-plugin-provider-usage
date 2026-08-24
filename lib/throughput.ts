import {
  MAX_SERIES,
  OTHER_SERIES_ID,
  providerSlotIndex,
} from "./series-palette";
import {
  addBucket,
  emptyBucket,
  formatTokenCount,
  providerDisplayName,
  type TokenBucket,
} from "./tokens";

/** How far back the live chart reaches. */
export const THROUGHPUT_WINDOW_MS = 15 * 60_000;
/** One column per bin. 10s keeps 90 columns readable at panel width. */
export const THROUGHPUT_BIN_MS = 10_000;
/** The trailing window the headline rate is measured over. */
export const RATE_WINDOW_MS = 60_000;
/** A thread with nothing newer than this is no longer "working". */
export const ACTIVE_THREAD_MS = 90_000;

/** One provider's share of one turn, at the moment the turn reported it. */
export interface ThroughputDelta {
  atMs: number;
  threadId: string;
  providerId: string;
  bucket: TokenBucket;
}

export interface ThroughputThread {
  threadId: string;
  providerId: string;
  title: string | null;
  status: string;
}

export interface ThroughputPoint {
  atMs: number;
  total: number;
  byProvider: Record<string, number>;
}

export interface ThroughputProviderRow {
  id: string;
  displayName: string;
  tokens: number;
  tokensPerMinute: number;
  sharePercent: number;
  lastAtMs: number | null;
}

export interface ThroughputThreadRow {
  threadId: string;
  title: string;
  providerId: string;
  providerName: string;
  status: string;
  tokens: number;
  tokensPerMinute: number;
  lastAtMs: number;
}

export interface ThroughputSnapshot {
  sampledAt: string;
  nowMs: number;
  windowMs: number;
  binMs: number;
  rateWindowMs: number;
  /** Tokens reported over the trailing rate window — the headline number. */
  tokensPerMinute: number;
  /** Best trailing-window rate seen anywhere in the chart's span. */
  peakTokensPerMinute: number;
  peakAtMs: number | null;
  windowTotals: TokenBucket;
  activeThreads: number;
  trackedThreads: number;
  live: boolean;
  providers: ThroughputProviderRow[];
  series: ThroughputPoint[];
  threads: ThroughputThreadRow[];
}

export function binStart(atMs: number, binMs: number): number {
  return Math.floor(atMs / binMs) * binMs;
}

/**
 * Fold everything past the palette's seat count into one "Other" series rather
 * than inventing hues no one can tell apart. The tail is chosen by volume, and
 * the survivors keep their own slot, so folding never repaints a provider that
 * was already on screen under its own name.
 */
function resolveSeriesIds(totals: Map<string, TokenBucket>): Map<string, string> {
  const ranked = [...totals.entries()].sort(
    (a, b) => b[1].tokens - a[1].tokens || a[0].localeCompare(b[0]),
  );
  const mapping = new Map<string, string>();
  if (ranked.length <= MAX_SERIES) {
    for (const [id] of ranked) mapping.set(id, id);
    return mapping;
  }
  ranked.forEach(([id], index) => {
    mapping.set(id, index < MAX_SERIES - 1 ? id : OTHER_SERIES_ID);
  });
  return mapping;
}

/**
 * Order series by palette slot, not by volume. A live chart redraws every
 * couple of seconds, so ranking the stack would reshuffle the bands under the
 * reader's eyes every time two providers traded places.
 */
function compareSeries(a: string, b: string): number {
  if (a === OTHER_SERIES_ID) return 1;
  if (b === OTHER_SERIES_ID) return -1;
  const slotDelta = providerSlotIndex(a) - providerSlotIndex(b);
  return slotDelta !== 0 ? slotDelta : a.localeCompare(b);
}

export function assembleThroughputSnapshot(input: {
  nowMs: number;
  deltas: readonly ThroughputDelta[];
  threads?: readonly ThroughputThread[];
  windowMs?: number;
  binMs?: number;
  rateWindowMs?: number;
  trackedThreads?: number;
}): ThroughputSnapshot {
  const windowMs = input.windowMs ?? THROUGHPUT_WINDOW_MS;
  const binMs = input.binMs ?? THROUGHPUT_BIN_MS;
  const rateWindowMs = input.rateWindowMs ?? RATE_WINDOW_MS;
  const nowMs = input.nowMs;
  const windowStart = nowMs - windowMs;

  const inWindow = input.deltas.filter(
    (delta) => delta.atMs > windowStart && delta.atMs <= nowMs,
  );

  const providerTotals = new Map<string, TokenBucket>();
  for (const delta of inWindow) {
    const current = providerTotals.get(delta.providerId) ?? emptyBucket();
    addBucket(current, delta.bucket);
    providerTotals.set(delta.providerId, current);
  }
  const seriesOf = resolveSeriesIds(providerTotals);

  // The chart always spans the full window, so an idle stretch reads as real
  // quiet rather than a chart that shrank to fit the last burst.
  const lastBin = binStart(nowMs, binMs);
  const binCount = Math.max(1, Math.round(windowMs / binMs));
  const firstBin = lastBin - (binCount - 1) * binMs;

  const byBin = new Map<number, Map<string, number>>();
  const seriesTotals = new Map<string, TokenBucket>();
  const windowTotals = emptyBucket();
  const lastSeenAt = new Map<string, number>();
  for (const delta of inWindow) {
    const seriesId = seriesOf.get(delta.providerId) ?? delta.providerId;
    const bin = Math.max(firstBin, binStart(delta.atMs, binMs));
    const row = byBin.get(bin) ?? new Map<string, number>();
    row.set(seriesId, (row.get(seriesId) ?? 0) + delta.bucket.tokens);
    byBin.set(bin, row);

    const running = seriesTotals.get(seriesId) ?? emptyBucket();
    addBucket(running, delta.bucket);
    seriesTotals.set(seriesId, running);
    addBucket(windowTotals, delta.bucket);
    const previous = lastSeenAt.get(seriesId);
    if (previous === undefined || delta.atMs > previous) {
      lastSeenAt.set(seriesId, delta.atMs);
    }
  }

  const series: ThroughputPoint[] = [];
  for (let index = 0; index < binCount; index += 1) {
    const atMs = firstBin + index * binMs;
    const row = byBin.get(atMs);
    const byProvider: Record<string, number> = {};
    let total = 0;
    if (row) {
      for (const [seriesId, tokens] of row) {
        byProvider[seriesId] = tokens;
        total += tokens;
      }
    }
    series.push({ atMs, total, byProvider });
  }

  const rateFrom = (endMs: number) => {
    let sum = 0;
    for (const delta of inWindow) {
      if (delta.atMs > endMs - rateWindowMs && delta.atMs <= endMs) {
        sum += delta.bucket.tokens;
      }
    }
    return (sum / rateWindowMs) * 60_000;
  };

  const tokensPerMinute = rateFrom(nowMs);
  // Sample the trailing rate at each bin edge; a burst inside the window shows
  // up as the peak even once the headline rate has fallen back to nothing.
  let peakTokensPerMinute = tokensPerMinute;
  let peakAtMs: number | null = inWindow.length === 0 ? null : nowMs;
  for (let index = 0; index < binCount; index += 1) {
    const edge = firstBin + index * binMs + binMs;
    if (edge > nowMs) break;
    const rate = rateFrom(edge);
    if (rate > peakTokensPerMinute) {
      peakTokensPerMinute = rate;
      peakAtMs = edge;
    }
  }

  const providers: ThroughputProviderRow[] = [...seriesTotals.entries()]
    .map(([id, bucket]) => ({
      id,
      displayName:
        id === OTHER_SERIES_ID ? "Other" : providerDisplayName(id),
      tokens: bucket.tokens,
      tokensPerMinute: (bucket.tokens / windowMs) * 60_000,
      sharePercent:
        windowTotals.tokens === 0
          ? 0
          : (bucket.tokens / windowTotals.tokens) * 100,
      lastAtMs: lastSeenAt.get(id) ?? null,
    }))
    .sort((a, b) => compareSeries(a.id, b.id));

  const threadMeta = new Map(
    (input.threads ?? []).map((thread) => [thread.threadId, thread]),
  );
  const threadTotals = new Map<
    string,
    { bucket: TokenBucket; providerId: string; lastAtMs: number }
  >();
  for (const delta of inWindow) {
    const current = threadTotals.get(delta.threadId) ?? {
      bucket: emptyBucket(),
      providerId: delta.providerId,
      lastAtMs: delta.atMs,
    };
    addBucket(current.bucket, delta.bucket);
    current.providerId = delta.providerId;
    if (delta.atMs > current.lastAtMs) current.lastAtMs = delta.atMs;
    threadTotals.set(delta.threadId, current);
  }

  const threads: ThroughputThreadRow[] = [...threadTotals.entries()]
    .map(([threadId, row]) => {
      const meta = threadMeta.get(threadId);
      return {
        threadId,
        title: meta?.title?.trim() || "Untitled thread",
        providerId: row.providerId,
        providerName: providerDisplayName(row.providerId),
        status: meta?.status ?? "idle",
        tokens: row.bucket.tokens,
        tokensPerMinute: (row.bucket.tokens / windowMs) * 60_000,
        lastAtMs: row.lastAtMs,
      };
    })
    .sort((a, b) => b.tokens - a.tokens || a.threadId.localeCompare(b.threadId));

  const activeThreads = threads.filter(
    (thread) => thread.lastAtMs > nowMs - ACTIVE_THREAD_MS,
  ).length;

  return {
    sampledAt: new Date(nowMs).toISOString(),
    nowMs,
    windowMs,
    binMs,
    rateWindowMs,
    tokensPerMinute,
    peakTokensPerMinute,
    peakAtMs,
    windowTotals,
    activeThreads,
    trackedThreads: input.trackedThreads ?? threadMeta.size,
    live: tokensPerMinute > 0,
    providers,
    series,
    threads,
  };
}

/**
 * The rolling record the live section reads from. It holds only the turns
 * inside the window — a few hundred rows at most — and is deliberately not
 * persisted: "what is running right now" has no meaning after a restart.
 */
export function createThroughputRecorder(options?: {
  windowMs?: number;
  binMs?: number;
  rateWindowMs?: number;
}) {
  const windowMs = options?.windowMs ?? THROUGHPUT_WINDOW_MS;
  const binMs = options?.binMs ?? THROUGHPUT_BIN_MS;
  const rateWindowMs = options?.rateWindowMs ?? RATE_WINDOW_MS;
  let deltas: ThroughputDelta[] = [];
  const threads = new Map<string, ThroughputThread>();

  const prune = (nowMs: number) => {
    const cutoff = nowMs - windowMs;
    if (deltas.length > 0 && deltas[0]!.atMs <= cutoff) {
      deltas = deltas.filter((delta) => delta.atMs > cutoff);
    }
  };

  return {
    record(delta: ThroughputDelta, nowMs = Date.now()): void {
      if (!Number.isFinite(delta.atMs) || delta.atMs <= 0) return;
      if (delta.bucket.tokens <= 0 && delta.bucket.cached <= 0) return;
      // A clock skew between the provider and this machine would otherwise put
      // a turn in the future, where it never expires and never plots.
      const atMs = Math.min(delta.atMs, nowMs);
      if (atMs <= nowMs - windowMs) return;
      deltas.push({ ...delta, atMs });
      deltas.sort((a, b) => a.atMs - b.atMs);
      prune(nowMs);
    },
    noteThread(thread: ThroughputThread): void {
      threads.set(thread.threadId, thread);
    },
    forgetThread(threadId: string): void {
      threads.delete(threadId);
    },
    snapshot(nowMs = Date.now(), trackedThreads?: number): ThroughputSnapshot {
      prune(nowMs);
      return assembleThroughputSnapshot({
        nowMs,
        deltas,
        threads: [...threads.values()],
        windowMs,
        binMs,
        rateWindowMs,
        ...(trackedThreads === undefined ? {} : { trackedThreads }),
      });
    },
  };
}

export type ThroughputRecorder = ReturnType<typeof createThroughputRecorder>;

export function formatRate(tokensPerMinute: number): string {
  return `${formatTokenCount(Math.round(tokensPerMinute))}/min`;
}

export function formatThroughputText(snapshot: ThroughputSnapshot): string {
  const minutes = Math.round(snapshot.windowMs / 60_000);
  const lines = [
    `Live throughput · last ${minutes} minutes`,
    `  Now               ${formatRate(snapshot.tokensPerMinute)}`,
    `  Peak              ${formatRate(snapshot.peakTokensPerMinute)}`,
    `  Window total      ${formatTokenCount(snapshot.windowTotals.tokens)} over ${snapshot.windowTotals.turns} turn${snapshot.windowTotals.turns === 1 ? "" : "s"}`,
    `  Threads working   ${snapshot.activeThreads} of ${snapshot.trackedThreads} tracked`,
    "",
    "By provider",
  ];
  if (snapshot.providers.length === 0) {
    lines.push("  Nothing reported in this window");
  } else {
    for (const provider of snapshot.providers) {
      lines.push(
        `  ${provider.displayName.padEnd(14)} ${formatTokenCount(provider.tokens).padStart(7)}  ${Math.round(provider.sharePercent)}%  ${formatRate(provider.tokensPerMinute)}`,
      );
    }
  }
  if (snapshot.threads.length > 0) {
    lines.push("", "By thread");
    for (const thread of snapshot.threads.slice(0, 10)) {
      lines.push(
        `  ${thread.title.slice(0, 40).padEnd(40)} ${formatTokenCount(thread.tokens).padStart(7)}  ${thread.providerName}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
