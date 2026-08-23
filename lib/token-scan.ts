import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { mergeCursorDaily, scanCursorStores } from "./cursor-scan";
import { mergeOpencodeDaily, scanOpencodeStores } from "./opencode-scan";
import {
  addBucket,
  dayKey,
  emptyBucket,
  type TokenBucket,
} from "./tokens";

export type DailyProviderBuckets = Record<string, Record<string, TokenBucket>>;

export interface FileScanResult {
  path: string;
  mtimeMs: number;
  size: number;
  daily: Record<string, TokenBucket>;
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 80 * 1024 * 1024;

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageBucket(parts: {
  input?: unknown;
  output?: unknown;
  cached?: unknown;
  reasoning?: unknown;
  inputIncludesCached?: boolean;
}): TokenBucket | null {
  const rawInput = asNumber(parts.input);
  const cached = asNumber(parts.cached);
  const output = asNumber(parts.output);
  const reasoning = asNumber(parts.reasoning);
  const input = parts.inputIncludesCached
    ? Math.max(0, rawInput - asNumber(parts.cached))
    : rawInput;
  const tokens = input + output + reasoning;
  if (tokens <= 0 && cached <= 0) return null;
  return { tokens, input, output, cached, reasoning, turns: 1 };
}

function addDaily(
  daily: Record<string, TokenBucket>,
  atMs: number,
  bucket: TokenBucket,
): void {
  if (!Number.isFinite(atMs) || atMs <= 0) return;
  const key = dayKey(atMs);
  const current = daily[key] ?? emptyBucket();
  addBucket(current, bucket);
  daily[key] = current;
}

function timestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function readUsageObject(
  value: unknown,
  inputIncludesCached = false,
): TokenBucket | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return usageBucket({
    input: row.input_tokens ?? row.inputTokens,
    output: row.output_tokens ?? row.outputTokens,
    cached:
      asNumber(row.cached_input_tokens ?? row.cachedInputTokens) +
      asNumber(row.cache_read_input_tokens ?? row.cacheReadInputTokens) +
      asNumber(row.cache_creation_input_tokens ?? row.cacheCreationInputTokens) +
      asNumber(row.cache_write_input_tokens),
    reasoning: row.reasoning_output_tokens ?? row.reasoningOutputTokens,
    inputIncludesCached,
  });
}

export function extractCodexBucket(record: unknown): {
  atMs: number;
  bucket: TokenBucket;
} | null {
  if (!record || typeof record !== "object") return null;
  const row = record as Record<string, unknown>;
  if (row.type !== "event_msg") return null;
  const payload = row.payload;
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  if (body.type !== "token_count") return null;
  const info = body.info;
  if (!info || typeof info !== "object") return null;
  const details = info as Record<string, unknown>;
  const bucket =
    readUsageObject(details.last_token_usage, true) ??
    readUsageObject(details.lastTokenUsage, true);
  if (!bucket) return null;
  const atMs = timestampMs(row.timestamp) || timestampMs(details.created_at);
  return { atMs, bucket };
}

export function extractClaudeBucket(record: unknown): {
  atMs: number;
  bucket: TokenBucket;
} | null {
  if (!record || typeof record !== "object") return null;
  const row = record as Record<string, unknown>;
  if (row.type !== "assistant") return null;
  const message = row.message;
  if (!message || typeof message !== "object") return null;
  const bucket = readUsageObject((message as Record<string, unknown>).usage);
  if (!bucket) return null;
  return { atMs: timestampMs(row.timestamp), bucket };
}

async function walkJsonl(root: string): Promise<string[]> {
  const found: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        found.push(path);
      }
    }
  }
  return found;
}

export function tokenRoots(home = homedir(), env = process.env): {
  id: string;
  root: string;
}[] {
  const roots: { id: string; root: string }[] = [];
  const codexHome = env.CODEX_HOME?.trim() || join(home, ".codex");
  const claudeHome = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  roots.push({ id: "codex", root: join(codexHome, "sessions") });
  roots.push({ id: "claude-code", root: join(claudeHome, "projects") });
  return roots;
}

async function parseFile(
  path: string,
  providerId: string,
): Promise<Record<string, TokenBucket>> {
  const daily: Record<string, TokenBucket> = {};
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lastFingerprint = "";
  for await (const line of lines) {
    if (line.length < 20) continue;
    const interesting =
      providerId === "codex"
        ? line.includes("token_count")
        : line.includes('"assistant"') && line.includes("usage");
    if (!interesting) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const hit =
      providerId === "codex"
        ? extractCodexBucket(record)
        : extractClaudeBucket(record);
    if (!hit) continue;
    const fingerprint = `${hit.bucket.input}:${hit.bucket.output}:${hit.bucket.cached}:${hit.bucket.reasoning}`;
    if (fingerprint === lastFingerprint) continue;
    lastFingerprint = fingerprint;
    addDaily(daily, hit.atMs, hit.bucket);
  }
  return daily;
}

export async function scanTokenFiles(options?: {
  nowMs?: number;
  includeCursor?: boolean;
  includeOpencode?: boolean;
  cached?: Map<string, { mtimeMs: number; size: number; daily: Record<string, TokenBucket> }>;
}): Promise<{
  files: FileScanResult[];
  changedFiles: number;
  sources: string[];
  daily: DailyProviderBuckets;
}> {
  const nowMs = options?.nowMs ?? Date.now();
  const cutoff = nowMs - NINETY_DAYS_MS;
  const cached = options?.cached ?? new Map();
  const files: FileScanResult[] = [];
  const sources: string[] = [];
  let changedFiles = 0;
  const daily: DailyProviderBuckets = {};

  for (const source of tokenRoots()) {
    let listing: string[];
    try {
      listing = await walkJsonl(source.root);
    } catch {
      continue;
    }
    if (listing.length === 0) continue;
    sources.push(source.id);

    for (const path of listing) {
      let info;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) {
        continue;
      }
      if (info.mtimeMs < cutoff) continue;

      const prior = cached.get(path);
      const stale =
        !prior ||
        prior.mtimeMs !== Math.round(info.mtimeMs) ||
        prior.size !== info.size;
      const fileDaily = stale ? await parseFile(path, source.id) : prior.daily;
      if (stale) changedFiles += 1;

      files.push({
        path,
        mtimeMs: Math.round(info.mtimeMs),
        size: info.size,
        daily: fileDaily,
      });

      for (const [day, bucket] of Object.entries(fileDaily) as Array<
        [string, TokenBucket]
      >) {
        const row = daily[day] ?? {};
        const current = row[source.id] ?? emptyBucket();
        addBucket(current, bucket);
        row[source.id] = current;
        daily[day] = row;
      }
    }
  }

  const cursorFiles =
    options?.includeCursor === false ? [] : scanCursorStores({ cached, nowMs });
  if (cursorFiles.length > 0) {
    sources.push("cursor");
    for (const file of cursorFiles) {
      const prior = cached.get(file.path);
      if (
        !prior ||
        prior.mtimeMs !== file.mtimeMs ||
        prior.size !== file.size
      ) {
        changedFiles += 1;
      }
      files.push(file);
    }
    mergeCursorDaily(daily, cursorFiles);
  }

  const opencodeFiles =
    options?.includeOpencode === false ? [] : scanOpencodeStores({ cached, nowMs });
  if (opencodeFiles.length > 0) {
    sources.push("opencode");
    for (const file of opencodeFiles) {
      const prior = cached.get(file.path);
      if (!prior || prior.mtimeMs !== file.mtimeMs || prior.size !== file.size) {
        changedFiles += 1;
      }
      files.push(file);
    }
    mergeOpencodeDaily(daily, opencodeFiles);
  }

  return { files, changedFiles, sources, daily };
}
