import { normalizeProviderId } from "./bb-usage-scan";
import {
  isLiveThroughputThread,
  type ThroughputScanThread,
} from "./throughput-scan";
import type { ThroughputRecorder } from "./throughput";
import type { TokenBucket } from "./tokens";

const SESSION_INFO_REFRESH_MS = 30_000;

export interface LocalThroughputSample {
  /** Stable within one source: an opencode message id or Cursor store path. */
  id: string;
  sessionId: string;
  atMs: number;
  bucket: TokenBucket;
  /** Cursor exposes a growing session estimate; opencode exposes per-call rows. */
  cumulative?: boolean;
  /** Lets a brand-new cumulative session safely chart its first whole sample. */
  startedAtMs?: number;
}

export interface LocalThroughputSource {
  providerId: string;
  scan(args: {
    sessionIds: readonly string[];
    sinceMs: number;
  }): Promise<LocalThroughputSample[]> | LocalThroughputSample[];
}

export interface LocalThreadSessionInfo {
  sessionIds: string[];
  /** BB's canonical token stream wins whenever the provider supplies it. */
  hasNativeUsage: boolean;
}

export interface LocalThroughputScanDeps {
  listThreads: () => Promise<ThroughputScanThread[]>;
  listThreadSessionInfo: (
    threadId: string,
  ) => Promise<LocalThreadSessionInfo>;
  sources: readonly LocalThroughputSource[];
  onError?: (error: unknown) => void;
}

interface CachedSessionInfo extends LocalThreadSessionInfo {
  checkedAtMs: number;
}

interface CumulativeSample {
  bucket: TokenBucket;
  atMs: number;
}

function bucketDelta(current: TokenBucket, previous: TokenBucket): TokenBucket {
  const delta = (next: number, prior: number) =>
    next < prior ? Math.max(0, next) : next - prior;
  return {
    tokens: delta(current.tokens, previous.tokens),
    input: delta(current.input, previous.input),
    output: delta(current.output, previous.output),
    cached: delta(current.cached, previous.cached),
    reasoning: delta(current.reasoning, previous.reasoning),
    turns: delta(current.turns, previous.turns),
  };
}

/**
 * Fills holes left by provider bridges that do not emit
 * `thread/tokenUsage/updated`, without pulling unrelated terminal sessions
 * into BB's live chart. Provider thread identities map each local session back
 * to the BB thread that launched it. Native BB usage always takes precedence.
 */
export function createLocalThroughputScanner(
  recorder: ThroughputRecorder,
  deps: LocalThroughputScanDeps,
  options?: { windowMs?: number },
) {
  const windowMs = options?.windowMs ?? 15 * 60_000;
  const sessionInfo = new Map<string, CachedSessionInfo>();
  const seenEvents = new Map<string, number>();
  const cumulative = new Map<string, CumulativeSample>();

  const readSessionInfo = async (
    thread: ThroughputScanThread,
    nowMs: number,
  ): Promise<CachedSessionInfo | null> => {
    const cached = sessionInfo.get(thread.id);
    if (cached && nowMs - cached.checkedAtMs < SESSION_INFO_REFRESH_MS) {
      return cached;
    }
    try {
      const next = await deps.listThreadSessionInfo(thread.id);
      const row = { ...next, checkedAtMs: nowMs };
      sessionInfo.set(thread.id, row);
      return row;
    } catch (error) {
      deps.onError?.(error);
      return cached ?? null;
    }
  };

  return {
    /** Re-resolve provider identities after BB reports a thread change. */
    markDirty(threadId: string): void {
      const cached = sessionInfo.get(threadId);
      if (cached) cached.checkedAtMs = 0;
    },

    async refresh(
      nowMs = Date.now(),
    ): Promise<{ sources: number; samples: number; sessions: number }> {
      let threads: ThroughputScanThread[];
      try {
        threads = await deps.listThreads();
      } catch (error) {
        deps.onError?.(error);
        return { sources: 0, samples: 0, sessions: 0 };
      }

      const liveThreads = threads.filter(isLiveThroughputThread);
      const liveThreadIds = new Set(liveThreads.map((thread) => thread.id));
      for (const threadId of [...sessionInfo.keys()]) {
        if (!liveThreadIds.has(threadId)) {
          sessionInfo.delete(threadId);
          recorder.forgetThread(threadId);
        }
      }

      const windowStart = nowMs - windowMs;
      for (const [key, atMs] of seenEvents) {
        if (atMs <= windowStart) seenEvents.delete(key);
      }
      // Keep cumulative baselines beyond the visible window. If an old Cursor
      // session resumes after sitting quiet, its next store snapshot still
      // needs the prior total so the first new turn is not lost.

      const sourceIds = new Set(
        deps.sources.map((source) => normalizeProviderId(source.providerId)),
      );
      const candidates = liveThreads.filter(
        (thread) =>
          sourceIds.has(normalizeProviderId(thread.providerId)) &&
          (thread.status !== "idle" || thread.updatedAt > windowStart),
      );
      const infoByThread = new Map<string, CachedSessionInfo>();
      for (const thread of candidates) {
        const info = await readSessionInfo(thread, nowMs);
        if (info) infoByThread.set(thread.id, info);
      }

      let scannedSources = 0;
      let recordedSamples = 0;
      const trackedSessions = new Set<string>();

      for (const source of deps.sources) {
        const providerId = normalizeProviderId(source.providerId);
        const sessionThreads = new Map<string, ThroughputScanThread>();
        for (const thread of candidates) {
          if (normalizeProviderId(thread.providerId) !== providerId) continue;
          const info = infoByThread.get(thread.id);
          if (!info || info.hasNativeUsage) continue;
          recorder.noteThread({
            threadId: thread.id,
            providerId,
            title: thread.title,
            status: thread.status,
          });
          for (const sessionId of info.sessionIds) {
            if (!sessionId) continue;
            trackedSessions.add(`${providerId}:${sessionId}`);
            const prior = sessionThreads.get(sessionId);
            if (!prior || thread.updatedAt > prior.updatedAt) {
              sessionThreads.set(sessionId, thread);
            }
          }
        }
        if (sessionThreads.size === 0) continue;

        let samples: LocalThroughputSample[];
        try {
          samples = await source.scan({
            sessionIds: [...sessionThreads.keys()],
            sinceMs: windowStart,
          });
        } catch (error) {
          deps.onError?.(error);
          continue;
        }
        scannedSources += 1;

        for (const sample of samples) {
          const thread = sessionThreads.get(sample.sessionId);
          if (!thread) continue;
          if (!Number.isFinite(sample.atMs) || sample.atMs <= windowStart) {
            continue;
          }
          const key = `${providerId}:${sample.id}`;
          let bucket = sample.bucket;
          if (sample.cumulative) {
            const previous = cumulative.get(key);
            cumulative.set(key, { bucket: sample.bucket, atMs: sample.atMs });
            if (previous) {
              bucket = bucketDelta(sample.bucket, previous.bucket);
            } else {
              const entirelyInWindow =
                thread.createdAt > windowStart ||
                (sample.startedAtMs ?? 0) > windowStart;
              if (!entirelyInWindow) continue;
            }
          } else {
            if (seenEvents.has(key)) continue;
            seenEvents.set(key, sample.atMs);
          }

          recorder.record(
            {
              atMs: sample.atMs,
              threadId: thread.id,
              providerId,
              bucket,
            },
            nowMs,
          );
          recordedSamples += 1;
        }
      }

      return {
        sources: scannedSources,
        samples: recordedSamples,
        sessions: trackedSessions.size,
      };
    },
  };
}

export type LocalThroughputScanner = ReturnType<
  typeof createLocalThroughputScanner
>;
