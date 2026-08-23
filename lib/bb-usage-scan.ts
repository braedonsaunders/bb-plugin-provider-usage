import { addBucket, dayKey, emptyBucket, type TokenBucket } from "./tokens";

/**
 * Providers with a dedicated transcript scanner. Those read the agent's own
 * files, so they get full history and exact per-day attribution; bb's event
 * stream only starts at whatever bb itself has driven. Anything NOT in this
 * set falls back to the events below, which is what makes a provider bb has
 * never heard of before still show up in the chart.
 */
export const SCANNED_PROVIDERS: ReadonlySet<string> = new Set([
  "codex",
  "claude-code",
  "cursor",
  "opencode",
]);

export interface BbThreadRef {
  id: string;
  providerId: string;
  updatedAt: number;
}

export interface BbUsageTotal {
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface BbUsageEvent {
  seq: number;
  createdAt: number;
  total: BbUsageTotal;
}

/** bb namespaces every ACP agent as `acp-<agent>`; the chart wants the agent. */
export function normalizeProviderId(providerId: string): string {
  const trimmed = providerId.trim();
  if (!trimmed) return "unknown";
  return trimmed.startsWith("acp-") ? trimmed.slice(4) : trimmed;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * `thread/tokenUsage/updated` carries the thread's running total, not the
 * turn's, so consecutive events are differenced. A total that goes backwards
 * means the thread was compacted or restarted upstream, and the new total is
 * itself the delta rather than a negative one.
 */
function delta(current: number, previous: number): number {
  if (current < previous) return Math.max(0, current);
  return current - previous;
}

export function bucketFromTotals(
  current: BbUsageTotal,
  previous: BbUsageTotal,
): TokenBucket | null {
  const input = delta(asNumber(current.inputTokens), asNumber(previous.inputTokens));
  const output = delta(asNumber(current.outputTokens), asNumber(previous.outputTokens));
  const reasoning = delta(
    asNumber(current.reasoningOutputTokens),
    asNumber(previous.reasoningOutputTokens),
  );
  const cached = delta(
    asNumber(current.cachedInputTokens),
    asNumber(previous.cachedInputTokens),
  );
  const tokens = input + output + reasoning;
  if (tokens <= 0 && cached <= 0) return null;
  return { tokens, input, output, cached, reasoning, turns: 1 };
}

export interface BbUsageScanResult {
  daily: Record<string, Record<string, TokenBucket>>;
  providers: string[];
  threadsScanned: number;
}

export async function scanBbThreadUsage(deps: {
  listThreads: () => Promise<BbThreadRef[]>;
  listEvents: (threadId: string) => Promise<BbUsageEvent[]>;
  nowMs?: number;
  covered?: ReadonlySet<string>;
  onError?: (error: unknown) => void;
}): Promise<BbUsageScanResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const cutoff = nowMs - 90 * 24 * 60 * 60 * 1000;
  const covered = deps.covered ?? SCANNED_PROVIDERS;
  const daily: Record<string, Record<string, TokenBucket>> = {};
  const providers = new Set<string>();
  let threadsScanned = 0;

  let threads: BbThreadRef[];
  try {
    threads = await deps.listThreads();
  } catch (error) {
    deps.onError?.(error);
    return { daily, providers: [], threadsScanned: 0 };
  }

  for (const thread of threads) {
    const providerId = normalizeProviderId(thread.providerId);
    if (covered.has(providerId)) continue;
    if (thread.updatedAt > 0 && thread.updatedAt < cutoff) continue;

    let events: BbUsageEvent[];
    try {
      events = await deps.listEvents(thread.id);
    } catch (error) {
      deps.onError?.(error);
      continue;
    }
    if (events.length === 0) continue;
    threadsScanned += 1;

    let previous: BbUsageTotal = {};
    for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
      const bucket = bucketFromTotals(event.total, previous);
      previous = event.total;
      if (!bucket) continue;
      if (!Number.isFinite(event.createdAt) || event.createdAt <= 0) continue;
      if (event.createdAt < cutoff) continue;
      providers.add(providerId);
      const key = dayKey(event.createdAt);
      const row = daily[key] ?? {};
      const current = row[providerId] ?? emptyBucket();
      addBucket(current, bucket);
      row[providerId] = current;
      daily[key] = row;
    }
  }

  return { daily, providers: [...providers], threadsScanned };
}

export function mergeDaily(
  target: Record<string, Record<string, TokenBucket>>,
  source: Record<string, Record<string, TokenBucket>>,
): void {
  for (const [day, row] of Object.entries(source)) {
    const into = target[day] ?? {};
    for (const [provider, bucket] of Object.entries(row)) {
      const current = into[provider] ?? emptyBucket();
      addBucket(current, bucket);
      into[provider] = current;
    }
    target[day] = into;
  }
}
