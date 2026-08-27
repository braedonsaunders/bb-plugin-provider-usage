import { spawn } from "node:child_process";
import type { ProviderSupplement } from "./dashboard";

type JsonRecord = Record<string, unknown>;

interface AppServerResponse {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function scalarString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  const numeric = finiteNumber(value);
  return numeric === null ? null : String(numeric);
}

function isoFromUnixSeconds(value: unknown): string | null {
  const seconds = finiteNumber(value);
  if (seconds === null || seconds <= 0) return null;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function durationLabel(minutes: number | null, fallback: string): string {
  if (minutes === null || minutes <= 0) return fallback;
  if (minutes === 60) return "Hourly limit";
  if (minutes < 24 * 60 && minutes % 60 === 0) {
    return `${minutes / 60}-hour limit`;
  }
  if (minutes === 24 * 60) return "Daily limit";
  if (minutes === 7 * 24 * 60) return "Weekly limit";
  if (minutes % (7 * 24 * 60) === 0) {
    return `${minutes / (7 * 24 * 60)}-week limit`;
  }
  if (minutes % (24 * 60) === 0) {
    return `${minutes / (24 * 60)}-day limit`;
  }
  return fallback;
}

function normalizeWindow(
  snapshot: JsonRecord,
  key: "primary" | "secondary",
): ProviderSupplement["windows"][number] | null {
  const raw = asRecord(snapshot[key]);
  if (!raw) return null;
  const usedPercent = finiteNumber(raw.usedPercent);
  if (usedPercent === null) return null;
  const duration = finiteNumber(raw.windowDurationMins);
  const generic = key === "primary" ? "Primary limit" : "Secondary limit";
  const baseLabel = durationLabel(duration, generic);
  const limitName = scalarString(snapshot.limitName);
  return {
    label: limitName ? `${limitName} · ${baseLabel}` : baseLabel,
    usedPercent,
    resetsAt: isoFromUnixSeconds(raw.resetsAt),
  };
}

function snapshotRows(result: JsonRecord): JsonRecord[] {
  const byId = asRecord(result.rateLimitsByLimitId);
  if (byId) {
    const rows = Object.values(byId)
      .map(asRecord)
      .filter((value): value is JsonRecord => value !== null);
    if (rows.length > 0) return rows;
  }
  const fallback = asRecord(result.rateLimits);
  return fallback ? [fallback] : [];
}

/**
 * Convert the Codex app-server account snapshot into provider-neutral details.
 * The protocol evolves independently of this plugin, so every field is parsed
 * defensively and absent additions simply disappear from the dashboard.
 */
export function normalizeCodexRateLimits(value: unknown): ProviderSupplement | null {
  const result = asRecord(value);
  if (!result) return null;
  const snapshots = snapshotRows(result);
  if (snapshots.length === 0) return null;

  const windows = snapshots.flatMap((snapshot) =>
    (["primary", "secondary"] as const)
      .map((key) => normalizeWindow(snapshot, key))
      .filter(
        (window): window is ProviderSupplement["windows"][number] =>
          window !== null,
      ),
  );

  const creditRow = snapshots
    .map((snapshot) => asRecord(snapshot.credits))
    .find((row): row is JsonRecord => row !== null);
  const credits = creditRow
    ? {
        hasCredits: creditRow.hasCredits === true,
        unlimited: creditRow.unlimited === true,
        balance: scalarString(creditRow.balance),
      }
    : null;

  const spendSnapshot = snapshots.find((snapshot) =>
    Boolean(asRecord(snapshot.individualLimit)),
  );
  const spendRow = spendSnapshot
    ? asRecord(spendSnapshot.individualLimit)
    : null;
  const spendUsed = spendRow ? scalarString(spendRow.used) : null;
  const spendLimit = spendRow ? scalarString(spendRow.limit) : null;
  const spendControl =
    spendRow && spendUsed !== null && spendLimit !== null
      ? {
          used: spendUsed,
          limit: spendLimit,
          remainingPercent: Math.min(
            100,
            Math.max(0, finiteNumber(spendRow.remainingPercent) ?? 0),
          ),
          resetsAt: isoFromUnixSeconds(spendRow.resetsAt),
          reached:
            typeof spendSnapshot?.spendControlReached === "boolean"
              ? spendSnapshot.spendControlReached
              : null,
        }
      : null;

  const resetSummary = asRecord(result.rateLimitResetCredits);
  const resetCount = resetSummary
    ? finiteNumber(resetSummary.availableCount)
    : null;
  const resetRows = Array.isArray(resetSummary?.credits)
    ? resetSummary.credits
        .map(asRecord)
        .filter(
          (row): row is JsonRecord =>
            row !== null && (row.status === "available" || row.status == null),
        )
    : [];
  resetRows.sort((left, right) => {
    const leftAt = finiteNumber(left.expiresAt) ?? Number.POSITIVE_INFINITY;
    const rightAt = finiteNumber(right.expiresAt) ?? Number.POSITIVE_INFINITY;
    return leftAt - rightAt;
  });
  const nextReset = resetRows[0] ?? null;
  const resetCredits =
    resetCount === null
      ? null
      : {
          availableCount: Math.max(0, Math.trunc(resetCount)),
          nextExpiresAt: isoFromUnixSeconds(nextReset?.expiresAt),
          title: scalarString(nextReset?.title),
          description: scalarString(nextReset?.description),
        };

  return { windows, credits, spendControl, resetCredits };
}

function commandCandidates(explicit?: string): string[] {
  const configured = explicit?.trim() || process.env.CODEX_CLI_PATH?.trim();
  return [
    configured,
    "codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter(
    (value, index, rows): value is string =>
      Boolean(value) && rows.indexOf(value) === index,
  );
}

async function readFromCommand(
  command: string,
  timeoutMs: number,
): Promise<ProviderSupplement | null> {
  return new Promise((resolve) => {
    const child = spawn(command, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    let buffer = "";

    const finish = (value: ProviderSupplement | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    child.once("error", () => finish(null));
    child.once("exit", () => finish(null));
    child.stdin.on("error", () => finish(null));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: AppServerResponse;
        try {
          message = JSON.parse(line) as AppServerResponse;
        } catch {
          continue;
        }
        if (message.id === 1 && message.result) {
          child.stdin.write(
            `${JSON.stringify({ method: "account/rateLimits/read", id: 2 })}\n`,
          );
        } else if (message.id === 2) {
          finish(normalizeCodexRateLimits(message.result));
        }
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "bb-provider-usage",
            title: "BB Provider Usage",
            version: "0.7.0",
          },
          capabilities: null,
        },
      })}\n`,
    );
  });
}

/** Read supplemental local Codex limits without reading or exposing auth files. */
export async function readCodexUsageSupplement(options?: {
  command?: string;
  timeoutMs?: number;
}): Promise<ProviderSupplement | null> {
  for (const command of commandCandidates(options?.command)) {
    const result = await readFromCommand(command, options?.timeoutMs ?? 5_000);
    if (result) return result;
  }
  return null;
}
