export const TOKEN_WINDOWS = [7, 30, 90] as const;
export type TokenWindowDays = (typeof TOKEN_WINDOWS)[number];

export const TOKEN_PROVIDERS = ["codex", "claude-code", "cursor", "opencode"] as const;
export type TokenProviderId = (typeof TOKEN_PROVIDERS)[number];

export interface TokenBucket {
  /** Provider-reported total, including cached input. */
  tokens: number;
  /** Prompt/input tokens excluding the cached portion. */
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  turns: number;
}

export interface TokenProviderRow extends TokenBucket {
  id: string;
  displayName: string;
  percent: number;
}

export interface TokenDay {
  day: string;
  label: string;
  total: number;
  byProvider: Record<string, number>;
}

export interface TokenSnapshot {
  days: TokenWindowDays;
  scannedAt: string;
  fileCount: number;
  changedFiles: number;
  sources: string[];
  totals: TokenBucket;
  providers: TokenProviderRow[];
  series: TokenDay[];
}

export const EMPTY_BUCKET: TokenBucket = {
  tokens: 0,
  input: 0,
  output: 0,
  cached: 0,
  reasoning: 0,
  turns: 0,
};

export function emptyBucket(): TokenBucket {
  return { ...EMPTY_BUCKET };
}

export function addBucket(target: TokenBucket, add: TokenBucket): void {
  target.tokens += add.tokens;
  target.input += add.input;
  target.output += add.output;
  target.cached += add.cached;
  target.reasoning += add.reasoning;
  target.turns += add.turns;
}

export function dayKey(ms: number): string {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatTokenCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${Math.round(value / 1000)}k`;
  if (abs >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
    value,
  );
}

export function formatDayLabel(day: string, days: TokenWindowDays): string {
  const [year, month, date] = day.split("-").map(Number);
  const value = new Date(year!, (month ?? 1) - 1, date ?? 1);
  if (days === 7) {
    return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(value);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(value);
}

export function enumerateDays(days: TokenWindowDays, endMs = Date.now()): string[] {
  const end = new Date(endMs);
  end.setHours(12, 0, 0, 0);
  const keys: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(end);
    date.setDate(end.getDate() - offset);
    keys.push(dayKey(date.getTime()));
  }
  return keys;
}

/**
 * Names bb uses for the agents it ships with. Anything else is title-cased
 * from its id rather than dropped, so a provider added after this release
 * still reads as a name instead of a slug.
 */
const PROVIDER_NAMES: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  opencode: "opencode",
  pi: "Pi",
  grok: "Grok",
  "hermes-agent": "Hermes Agent",
  omp: "oh-my-pi",
  gemini: "Gemini",
  amp: "Amp",
  copilot: "Copilot",
};

export function providerDisplayName(id: string): string {
  const known = PROVIDER_NAMES[id];
  if (known) return known;
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function assembleTokenSnapshot(input: {
  days: TokenWindowDays;
  fileCount: number;
  changedFiles: number;
  sources: string[];
  scannedAt?: string;
  daily: Record<string, Record<string, TokenBucket>>;
}): TokenSnapshot {
  const keys = enumerateDays(input.days);
  const providerTotals = new Map<string, TokenBucket>();
  const totals = emptyBucket();
  const series: TokenDay[] = keys.map((day) => {
    const byProvider: Record<string, number> = {};
    let total = 0;
    const row = input.daily[day] ?? {};
    for (const [provider, bucket] of Object.entries(row)) {
      byProvider[provider] = bucket.tokens;
      total += bucket.tokens;
      const running = providerTotals.get(provider) ?? emptyBucket();
      addBucket(running, bucket);
      providerTotals.set(provider, running);
      addBucket(totals, bucket);
    }
    return {
      day,
      label: formatDayLabel(day, input.days),
      total,
      byProvider,
    };
  });

  const providers = [...providerTotals.entries()]
    .map(([id, bucket]) => ({
      id,
      displayName: providerDisplayName(id),
      ...bucket,
      percent: totals.tokens === 0 ? 0 : (bucket.tokens / totals.tokens) * 100,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    days: input.days,
    scannedAt: input.scannedAt ?? new Date().toISOString(),
    fileCount: input.fileCount,
    changedFiles: input.changedFiles,
    sources: input.sources,
    totals,
    providers,
    series,
  };
}

export function formatTokenText(snapshot: TokenSnapshot): string {
  const lines = [
    `Token usage · last ${snapshot.days} days`,
    `  Total             ${formatTokenCount(snapshot.totals.tokens)} (${snapshot.totals.turns} turns, cache included)`,
    `  Input             ${formatTokenCount(snapshot.totals.input)}`,
    `  Output            ${formatTokenCount(snapshot.totals.output)}`,
    `  Cached            ${formatTokenCount(snapshot.totals.cached)}`,
    `  Files scanned     ${snapshot.fileCount}`,
    "",
    "By provider",
  ];
  if (snapshot.providers.length === 0) {
    lines.push("  No transcript token events in this window");
  } else {
    for (const provider of snapshot.providers) {
      lines.push(
        `  ${provider.displayName.padEnd(14)} ${formatTokenCount(provider.tokens).padStart(7)}  ${Math.round(provider.percent)}%  ${formatTokenCount(provider.input)} in / ${formatTokenCount(provider.output)} out`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
