import { execFile } from "node:child_process";
import {
  clampPercent,
  formatWindowDurationLabel,
  type ProviderAccountUsage,
  type ProviderKey,
  type UsageWindow,
} from "./dashboard";

type JsonRecord = Record<string, unknown>;

/**
 * The Account Pooler names providers the way its CLI does (`bb pool routing
 * <claude|codex>`), which is not the dashboard's key for the same provider.
 */
const POOL_PROVIDER_KEYS: Record<string, ProviderKey> = {
  codex: "codex",
  claude: "claudeCode",
  "claude-code": "claudeCode",
};

export type ProviderPoolAccounts = Partial<
  Record<ProviderKey, ProviderAccountUsage[]>
>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * The pool reports a reset as epoch milliseconds, but its table prints ISO and
 * the field has changed shape before. Accept either and drop anything else.
 */
function isoTimestamp(value: unknown): string | null {
  const numeric = typeof value === "number" ? value : null;
  if (numeric !== null && Number.isFinite(numeric) && numeric > 0) {
    const date = new Date(numeric);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const text = nonEmptyString(value);
  if (text === null) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Utilization arrives as a 0–1 fraction: the pool prints `7d=100%` for a
 * utilization of 1. A value above 1 is therefore already a percentage, which
 * keeps this honest if the field is ever widened.
 */
function utilizationPercent(value: unknown): number | null {
  const numeric = finiteNumber(value);
  if (numeric === null || numeric < 0) return null;
  return clampPercent(numeric <= 1 ? numeric * 100 : numeric);
}

function toWindow(
  usedPercent: number,
  label: string,
  resetsAt: string | null,
): UsageWindow {
  return {
    label,
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    resetsAt,
    cost: null,
  };
}

function windowsFromLimitRows(rows: unknown): UsageWindow[] {
  if (!Array.isArray(rows)) return [];
  const windows: UsageWindow[] = [];
  for (const entry of rows) {
    const row = asRecord(entry);
    if (!row) continue;
    const usedPercent = utilizationPercent(row.utilization);
    if (usedPercent === null) continue;
    const minutes = finiteNumber(row.windowMinutes);
    const resetsAt = isoTimestamp(row.resetAt);
    /**
     * The pool posts a slot as soon as a response header mentions it, before it
     * knows the window's length or when it turns over — `windowMinutes: null`
     * with `resetAt: 0`. Charting that as "Secondary limit · 100% left" reads as
     * a full window when the truth is that nothing is known about it yet, so a
     * window the pool cannot name or time is left out until it can.
     */
    if (minutes === null && resetsAt === null) continue;
    const slot = nonEmptyString(row.slot);
    const fallback = slot
      ? `${slot[0]!.toUpperCase()}${slot.slice(1)} limit`
      : "Limit";
    windows.push(
      toWindow(usedPercent, formatWindowDurationLabel(minutes, fallback), resetsAt),
    );
  }
  return windows;
}

/**
 * Older pool rows carried the two Codex windows as flat fields. They are only
 * consulted when `limitWindows` is absent, so a pool that reports both does
 * not chart the same window twice.
 */
function windowsFromFlatFields(account: JsonRecord): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const fiveHour = utilizationPercent(account.fiveHourUtilization);
  if (fiveHour !== null) {
    windows.push(
      toWindow(fiveHour, "5-hour limit", isoTimestamp(account.fiveHourResetAt)),
    );
  }
  const sevenDay = utilizationPercent(account.sevenDayUtilization);
  if (sevenDay !== null) {
    windows.push(
      toWindow(sevenDay, "Weekly limit", isoTimestamp(account.sevenDayResetAt)),
    );
  }
  return windows;
}

/**
 * Turn `bb pool status --json` into per-provider account meters.
 *
 * The pooler is experimental and says its CLI can change between releases, so
 * every field is optional here: an unreadable account degrades to a row with a
 * status and no windows rather than removing the provider from the dashboard.
 */
export function normalizeAccountPool(
  value: unknown,
  nowMs = Date.now(),
): ProviderPoolAccounts {
  const result = asRecord(value);
  if (!result) return {};
  const routing = asRecord(result.routing) ?? {};
  const rows = Array.isArray(result.accounts) ? result.accounts : [];

  const byKey: ProviderPoolAccounts = {};
  for (const entry of rows) {
    const account = asRecord(entry);
    if (!account) continue;
    if (account.enabled === false) continue;

    const poolProvider = nonEmptyString(account.provider);
    if (poolProvider === null) continue;
    const key = POOL_PROVIDER_KEYS[poolProvider];
    // Routing off means bb still hands this provider its own credentials, so
    // the pool's numbers would describe traffic that is not flowing there.
    if (!key || routing[poolProvider] !== true) continue;

    const limitWindows = windowsFromLimitRows(account.limitWindows);
    const windows =
      limitWindows.length > 0 ? limitWindows : windowsFromFlatFields(account);
    const status = nonEmptyString(account.status) ?? "unknown";
    const heldUntil = finiteNumber(account.heldUntil);
    const email = nonEmptyString(account.email);

    (byKey[key] ??= []).push({
      id: nonEmptyString(account.id) ?? `${poolProvider}-${byKey[key]!.length}`,
      label: nonEmptyString(account.label) ?? email ?? "Account",
      email,
      priority: finiteNumber(account.priority) ?? 0,
      status,
      unavailable:
        status !== "ready" || (heldUntil !== null && heldUntil > nowMs),
      // Resolved against the host's signed-in account when the dashboard is
      // assembled; the pool itself has no view of which login the CLI holds.
      local: false,
      windows,
      message: nonEmptyString(account.error),
    });
  }

  // The pool runs accounts sequentially by priority, then by the order added,
  // and its own listing is already in insertion order. Sorting on priority
  // alone would reshuffle ties, so keep the received order within a priority.
  for (const accounts of Object.values(byKey)) {
    accounts?.sort((left, right) => left.priority - right.priority);
  }
  return byKey;
}

function commandCandidates(explicit?: string): string[] {
  const configured = explicit?.trim() || process.env.BB_CLI?.trim();
  return [configured, "bb", "/opt/homebrew/bin/bb", "/usr/local/bin/bb"].filter(
    (value, index, rows): value is string =>
      Boolean(value) && rows.indexOf(value) === index,
  );
}

function runPoolStatus(
  command: string,
  timeoutMs: number,
): Promise<unknown | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      ["pool", "status", "--json"],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/**
 * Read pooled account limits, or nothing at all when the Account Pooler is not
 * installed. A missing pool is the common case, not an error, so this never
 * throws and never blocks the dashboard on a slow CLI.
 */
export async function readAccountPool(options?: {
  command?: string;
  timeoutMs?: number;
  nowMs?: number;
}): Promise<ProviderPoolAccounts> {
  for (const command of commandCandidates(options?.command)) {
    const raw = await runPoolStatus(command, options?.timeoutMs ?? 5_000);
    if (raw !== null) return normalizeAccountPool(raw, options?.nowMs);
  }
  return {};
}
