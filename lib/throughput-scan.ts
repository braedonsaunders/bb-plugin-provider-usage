import {
  bucketFromTotals,
  normalizeProviderId,
  type BbUsageEvent,
  type BbUsageTotal,
} from "./bb-usage-scan";
import {
  THROUGHPUT_WINDOW_MS,
  type ThroughputRecorder,
} from "./throughput";

/**
 * How far back a thread's own `updatedAt` may sit before the scanner stops
 * polling it. Comfortably wider than the chart window so a thread that reports
 * usage slightly after its last row touch is still picked up.
 */
const POLL_GRACE_MS = 5 * 60_000;
/**
 * BB rejects any thread-event page larger than this with a 400, so every read
 * here pages rather than asking for its whole budget at once. Asking for more
 * is not merely trimmed — the request fails outright, which is silent to the
 * chart: the scanner catches, skips the thread, never stores a cursor, and
 * draws a confident flat zero. Keep every `limit` that reaches BB clamped here.
 */
const MAX_EVENT_PAGE = 100;
/** Ceiling on the first-sight backfill, in events across all pages. */
const BASELINE_LIMIT = 300;
/** Ceiling on how far one poll will chase a thread that ran ahead of us. */
const INCREMENT_LIMIT = 500;

export interface ThroughputScanThread {
  id: string;
  providerId: string;
  title: string | null;
  status: string;
  updatedAt: number;
  createdAt: number;
  archivedAt?: number | null;
  deletedAt?: number | null;
}

/** Live throughput is "what is running now". Archived and deleted threads are history. */
export function isLiveThroughputThread(
  thread: Pick<ThroughputScanThread, "archivedAt" | "deletedAt">,
): boolean {
  return !thread.archivedAt && !thread.deletedAt;
}

export interface ThroughputScanDeps {
  listThreads: () => Promise<ThroughputScanThread[]>;
  listEvents: (args: {
    threadId: string;
    afterSeq?: number;
    beforeSeq?: number;
    order: "asc" | "desc";
    limit: number;
  }) => Promise<BbUsageEvent[]>;
  onError?: (error: unknown) => void;
}

interface ThreadCursor {
  lastSeq: number;
  previousTotal: BbUsageTotal;
}

/**
 * Turns BB's own `thread/tokenUsage/updated` stream into live deltas.
 *
 * This is deliberately a different source from the daily chart's transcript
 * scanners. Those read each agent's files, which is right for history but says
 * nothing about *when* BB drove the work; the event stream is the only source
 * that is both current and uniform across every provider. Because it is the
 * one source here, no provider is excluded and nothing is counted twice — the
 * trade is that work run outside BB (an agent CLI in a bare terminal) reports
 * no events and so does not appear.
 */
export function createThroughputScanner(
  recorder: ThroughputRecorder,
  deps: ThroughputScanDeps,
  options?: { windowMs?: number },
) {
  const windowMs = options?.windowMs ?? THROUGHPUT_WINDOW_MS;
  const cursors = new Map<string, ThreadCursor>();
  const dirty = new Set<string>();

  /**
   * The first event seen for a thread has no earlier total to difference
   * against, and `total` is the thread's running sum — charting it raw would
   * drop a whole session's history onto one instant.
   *
   * The event's `last` field is not a way out. It is not uniformly "the last
   * call": BB's Claude Code bridge reports usage accumulated since the provider
   * session resumed, which has been observed at 55.9M against a 98.7M running
   * total — hours of earlier work, not a step. Trusting it produced exactly the
   * spike this guard exists to prevent.
   *
   * So a first event is charted only when the thread itself is younger than the
   * window, because then its entire history is by definition inside the window.
   * Otherwise it becomes the baseline and every event after it differences
   * correctly. The cost is one uncharted turn per thread when the service
   * starts; the alternative is a chart that invents millions of tokens.
   */
  const firstBucket = (
    event: BbUsageEvent,
    thread: ThroughputScanThread,
    nowMs: number,
  ) => {
    if (thread.createdAt > 0 && thread.createdAt > nowMs - windowMs) {
      return bucketFromTotals(event.total, {});
    }
    return null;
  };

  /**
   * The newest events for a thread we have never read, walked backwards a page
   * at a time. It stops as soon as a page reaches past the window, because the
   * only thing older history buys is the one row that becomes the baseline —
   * everything before that is outside the chart and would be discarded anyway.
   * In the common case that is a single request; a thread that has been busy
   * for the whole window costs at most `BASELINE_LIMIT / MAX_EVENT_PAGE` of
   * them.
   */
  const readBaseline = async (
    threadId: string,
    nowMs: number,
  ): Promise<BbUsageEvent[]> => {
    const collected: BbUsageEvent[] = [];
    let beforeSeq: number | undefined;
    while (collected.length < BASELINE_LIMIT) {
      const limit = Math.min(MAX_EVENT_PAGE, BASELINE_LIMIT - collected.length);
      const page = await deps.listEvents({
        threadId,
        order: "desc",
        limit,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      });
      if (page.length === 0) break;
      collected.push(...page);
      if (page.some((event) => event.createdAt <= nowMs - windowMs)) break;
      // A short page is the start of the thread; there is nothing behind it.
      if (page.length < limit) break;
      const lowest = page.reduce(
        (min, event) => Math.min(min, event.seq),
        Number.POSITIVE_INFINITY,
      );
      if (!Number.isFinite(lowest) || lowest <= 1) break;
      beforeSeq = lowest;
    }
    return collected;
  };

  /**
   * Everything past the cursor, paged forward. Without the loop a thread that
   * reported more than one page between polls would never be caught: each poll
   * would read a page, advance by a page, and stay exactly as far behind.
   */
  const readIncrement = async (
    threadId: string,
    afterSeq: number,
  ): Promise<BbUsageEvent[]> => {
    const collected: BbUsageEvent[] = [];
    let cursorSeq = afterSeq;
    while (collected.length < INCREMENT_LIMIT) {
      const limit = Math.min(MAX_EVENT_PAGE, INCREMENT_LIMIT - collected.length);
      const page = await deps.listEvents({
        threadId,
        afterSeq: cursorSeq,
        order: "asc",
        limit,
      });
      if (page.length === 0) break;
      collected.push(...page);
      const highest = page.reduce(
        (max, event) => Math.max(max, event.seq),
        cursorSeq,
      );
      // Defensive: a page that does not move the cursor would spin forever.
      if (highest <= cursorSeq) break;
      cursorSeq = highest;
      if (page.length < limit) break;
    }
    return collected;
  };

  const ingest = (
    thread: ThroughputScanThread,
    events: BbUsageEvent[],
    cursor: ThreadCursor | undefined,
    nowMs: number,
  ): ThreadCursor => {
    const ordered = [...events].sort((a, b) => a.seq - b.seq);
    let previous: BbUsageTotal = cursor?.previousTotal ?? {};
    let lastSeq = cursor?.lastSeq ?? 0;
    const providerId = normalizeProviderId(thread.providerId);

    ordered.forEach((event, index) => {
      const first = !cursor && index === 0;
      const bucket = first
        ? firstBucket(event, thread, nowMs)
        : bucketFromTotals(event.total, previous);
      previous = event.total;
      if (event.seq > lastSeq) lastSeq = event.seq;
      if (!bucket) return;
      if (!Number.isFinite(event.createdAt) || event.createdAt <= 0) return;
      if (event.createdAt <= nowMs - windowMs) return;
      recorder.record(
        {
          atMs: event.createdAt,
          threadId: thread.id,
          providerId,
          bucket,
        },
        nowMs,
      );
    });

    return { lastSeq, previousTotal: previous };
  };

  return {
    /** Poll this thread on the next refresh even if its row looks stale. */
    markDirty(threadId: string): void {
      dirty.add(threadId);
    },

    async refresh(
      nowMs = Date.now(),
    ): Promise<{ scanned: number; tracked: number; working: number }> {
      let threads: ThroughputScanThread[];
      try {
        threads = await deps.listThreads();
      } catch (error) {
        deps.onError?.(error);
        return { scanned: 0, tracked: cursors.size, working: 0 };
      }

      const liveThreads = threads.filter(isLiveThroughputThread);
      const live = new Set(liveThreads.map((thread) => thread.id));
      for (const threadId of [...cursors.keys()]) {
        if (!live.has(threadId)) {
          cursors.delete(threadId);
          recorder.forgetThread(threadId);
        }
      }

      const cutoff = nowMs - windowMs - POLL_GRACE_MS;
      const candidates = liveThreads.filter((thread) => {
        if (dirty.has(thread.id)) return true;
        if (thread.status !== "idle" && thread.status !== "error") return true;
        return thread.updatedAt >= cutoff;
      });
      dirty.clear();

      let scanned = 0;
      for (const thread of candidates) {
        const cursor = cursors.get(thread.id);
        let events: BbUsageEvent[];
        try {
          events = cursor
            ? await readIncrement(thread.id, cursor.lastSeq)
            : await readBaseline(thread.id, nowMs);
        } catch (error) {
          deps.onError?.(error);
          continue;
        }
        scanned += 1;
        recorder.noteThread({
          threadId: thread.id,
          providerId: normalizeProviderId(thread.providerId),
          title: thread.title,
          status: thread.status,
        });
        if (events.length === 0) {
          if (!cursor) cursors.set(thread.id, { lastSeq: 0, previousTotal: {} });
          continue;
        }
        cursors.set(thread.id, ingest(thread, events, cursor, nowMs));
      }

      const working = liveThreads.filter(
        (thread) => thread.status !== "idle" && thread.status !== "error",
      ).length;
      return { scanned, tracked: cursors.size, working };
    },
  };
}

export type ThroughputScanner = ReturnType<typeof createThroughputScanner>;
