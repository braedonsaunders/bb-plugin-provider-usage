import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProviderResetCredits, ProviderSupplement } from "./dashboard";

const execFileAsync = promisify(execFile);

/**
 * Claude Code reads extra reset programs from the same OAuth usage endpoint
 * BB already hits for session/weekly bars. The extra fields only appear when
 * asked for: cedar_ember is the banked-grant inventory (Codex-style saved
 * resets), at_wall adds the weekly session-reset offer. skip_spend keeps the
 * body small. The protocol evolves independently of this plugin, so every
 * field is parsed defensively.
 */
const CLAUDE_USAGE_PATH =
  "/api/oauth/usage?cedar_ember=1&at_wall=1&skip_spend=1";
const CLAUDE_USAGE_URL = `https://api.anthropic.com${CLAUDE_USAGE_PATH}`;
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const USAGE_FETCH_TIMEOUT_MS = 5_000;

type JsonRecord = Record<string, unknown>;

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
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isoTimestamp(value: unknown): string | null {
  const text = scalarString(value);
  if (text) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const seconds = finiteNumber(value);
  if (seconds === null || seconds <= 0) return null;
  // Claude sometimes sends unix seconds, sometimes unix ms.
  const millis = seconds > 1e12 ? seconds : seconds * 1_000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asInt(value: unknown): number | null {
  const numeric = finiteNumber(value);
  if (numeric === null) return null;
  return Math.max(0, Math.trunc(numeric));
}

interface ClaudeGrant {
  resetsLeft: number;
  endsAt: string | null;
  title: string | null;
  description: string | null;
}

function normalizeGrant(value: unknown): ClaudeGrant | null {
  const raw = asRecord(value);
  if (!raw) return null;
  if (raw.paused === true) return null;
  const resetsLeft = asInt(raw.resets_left ?? raw.resetsLeft);
  if (resetsLeft === null) return null;
  const label = scalarString(raw.label);
  return {
    resetsLeft,
    endsAt: isoTimestamp(raw.ends_at ?? raw.endsAt),
    title: label,
    description: label
      ? `${label}${resetsLeft === 1 ? "" : ` · ${resetsLeft} left`}`
      : null,
  };
}

/**
 * Weekly session-limit reset (juniper_tide). Claude Code's CLI surface is
 * often marked ineligible for the *claim* even when the unused weekly reset
 * is still sitting on the account — the same "everybody has one" offer the
 * web usage page shows. Treat an unspent weekly reset as available unless
 * the server has already scheduled the next one.
 */
function juniperReset(value: unknown): ClaudeGrant | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const perWeek = asInt(raw.resets_per_week ?? raw.resetsPerWeek) ?? 1;
  const nextAt = isoTimestamp(
    raw.next_available_at ?? raw.nextAvailableAt ?? raw.weekly_resets_at,
  );
  if (raw.available === true) {
    return {
      resetsLeft: Math.max(1, perWeek),
      endsAt: nextAt,
      title: "Session reset",
      description: "Uses weekly limit · 1/week",
    };
  }
  if (nextAt && raw.available === false && raw.eligible === true) {
    return {
      resetsLeft: 0,
      endsAt: nextAt,
      title: "Session reset",
      description: "Uses weekly limit · 1/week",
    };
  }
  // Unused, but this OAuth client cannot claim it here (surface/cli_version).
  // The reset is still banked on the account.
  const reason = scalarString(raw.ineligible_reason ?? raw.ineligibleReason);
  if (
    raw.available === false &&
    (reason === "surface" || reason === "cli_version") &&
    perWeek > 0 &&
    isoTimestamp(raw.next_available_at ?? raw.nextAvailableAt) === null
  ) {
    return {
      resetsLeft: perWeek,
      endsAt: null,
      title: "Session reset",
      description: "Uses weekly limit · 1/week",
    };
  }
  return null;
}

function mergeResetCredits(parts: ClaudeGrant[]): ProviderResetCredits | null {
  if (parts.length === 0) return null;
  const available = parts
    .filter((part) => part.resetsLeft > 0)
    .slice()
    .sort((left, right) => {
      const leftAt = left.endsAt ? Date.parse(left.endsAt) : Number.POSITIVE_INFINITY;
      const rightAt = right.endsAt ? Date.parse(right.endsAt) : Number.POSITIVE_INFINITY;
      return leftAt - rightAt;
    });
  const next =
    available[0] ??
    parts
      .filter((part) => part.endsAt)
      .slice()
      .sort((left, right) => Date.parse(left.endsAt!) - Date.parse(right.endsAt!))[0] ??
    parts[0]!;
  const availableCount = parts.reduce((sum, part) => sum + part.resetsLeft, 0);
  return {
    availableCount,
    nextExpiresAt: next.endsAt,
    title: next.title,
    description: next.description,
  };
}

/**
 * Convert a Claude OAuth usage snapshot into provider-neutral extras.
 * Windows stay with BB — this only lifts the reset programs BB's schema
 * strips.
 */
export function normalizeClaudeUsage(value: unknown): ProviderSupplement | null {
  const result = asRecord(value);
  if (!result) return null;
  const grants = Array.isArray(asRecord(result.cedar_ember)?.grants)
    ? (asRecord(result.cedar_ember)!.grants as unknown[])
        .map(normalizeGrant)
        .filter((row): row is ClaudeGrant => row !== null)
    : [];
  const weekly = juniperReset(result.juniper_tide);
  const resetCredits = mergeResetCredits(
    weekly ? [...grants, weekly] : grants,
  );
  if (!resetCredits) return null;
  return {
    windows: [],
    credits: null,
    spendControl: null,
    resetCredits,
  };
}

async function readKeychainCredentials(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const argumentSets = [
    [
      "find-generic-password",
      "-s",
      CLAUDE_KEYCHAIN_SERVICE,
      "-a",
      os.userInfo().username,
      "-w",
    ],
    ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
  ];
  for (const args of argumentSets) {
    try {
      const { stdout } = await execFileAsync("security", args, {
        timeout: 10_000,
      });
      if (stdout.trim()) return stdout.trim();
    } catch {
      continue;
    }
  }
  return null;
}

async function readAccessToken(): Promise<string | null> {
  let raw = await readKeychainCredentials();
  if (raw === null) {
    try {
      raw = await readFile(join(os.homedir(), ".claude", ".credentials.json"), "utf8");
    } catch {
      return null;
    }
  }
  try {
    const parsed = asRecord(JSON.parse(raw));
    const oauth = parsed ? asRecord(parsed.claudeAiOauth) : null;
    return oauth ? scalarString(oauth.accessToken) : null;
  } catch {
    return null;
  }
}

async function claudeUserAgent(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("claude", ["--version"], {
      timeout: 2_000,
    });
    const version = stdout.trim().split(/\s+/)[0];
    if (version && /^\d+\.\d+/.test(version)) return `claude-code/${version}`;
  } catch {
    // Fall through. A versioned product token is required: the usage endpoint
    // buckets by User-Agent, and an unversioned one shares the 429 bucket.
  }
  return "claude-code/2.1.278";
}

/** Read banked Claude resets without reading or exposing auth files. */
export async function readClaudeUsageSupplement(options?: {
  timeoutMs?: number;
}): Promise<ProviderSupplement | null> {
  const token = await readAccessToken();
  if (!token) return null;
  const userAgent = await claudeUserAgent();
  try {
    const response = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": userAgent,
      },
      signal: AbortSignal.timeout(options?.timeoutMs ?? USAGE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return normalizeClaudeUsage(await response.json());
  } catch {
    return null;
  }
}
