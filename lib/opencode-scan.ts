import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  LocalThroughputSample,
  LocalThroughputSource,
} from "./local-throughput-scan";
import { addBucket, dayKey, emptyBucket, type TokenBucket } from "./tokens";

export interface OpencodeFileScan {
  path: string;
  mtimeMs: number;
  size: number;
  daily: Record<string, TokenBucket>;
}

const require = createRequire(import.meta.url);

type SqliteDb = {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  close(): void;
};

function openSqlite(file: string): SqliteDb | null {
  if (!existsSync(file)) return null;
  try {
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (
        path: string,
        options?: { readOnly?: boolean },
      ) => {
        prepare(sql: string): { all: (...params: unknown[]) => unknown[] };
        close(): void;
      };
    };
    const db = new DatabaseSync(file, { readOnly: true });
    return {
      all<T>(sql: string, ...params: unknown[]) {
        return db.prepare(sql).all(...params) as T[];
      },
      close() {
        db.close();
      },
    };
  } catch {
    try {
      const Database = require("better-sqlite3") as {
        new (
          path: string,
          options?: { readonly?: boolean; fileMustExist?: boolean },
        ): {
          prepare(sql: string): { all: (...params: unknown[]) => unknown[] };
          close(): void;
        };
      };
      const db = new Database(file, { readonly: true, fileMustExist: true });
      return {
        all<T>(sql: string, ...params: unknown[]) {
          return db.prepare(sql).all(...params) as T[];
        },
        close() {
          db.close();
        },
      };
    } catch {
      return null;
    }
  }
}

export function isOpencodeStorePath(path: string): boolean {
  return path.endsWith("opencode.db");
}

/** `$XDG_DATA_HOME/opencode`, else the platform default. */
export function opencodeDbPaths(home = homedir(), env = process.env): string[] {
  const roots: string[] = [];
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) roots.push(join(xdg, "opencode"));
  roots.push(join(home, ".local/share/opencode"));
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const root of roots) {
    const file = join(root, "opencode.db");
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    paths.push(file);
  }
  return paths;
}

/**
 * A busy opencode writes into `-wal` and leaves `opencode.db`'s own mtime
 * untouched for long stretches, so keying the scan cache on the main file
 * alone would freeze the series at whatever it held when the last checkpoint
 * ran. Fold the sidecars into the fingerprint instead.
 */
function dbFingerprint(file: string): { mtimeMs: number; size: number } | null {
  let mtimeMs = 0;
  let size = 0;
  let found = false;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      const info = statSync(`${file}${suffix}`);
      if (!info.isFile()) continue;
      found = true;
      mtimeMs = Math.max(mtimeMs, Math.round(info.mtimeMs));
      size += info.size;
    } catch {
      // Sidecars vanish on checkpoint; only the main file must exist.
    }
  }
  return found ? { mtimeMs, size } : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * opencode stores per-assistant-message counts where `input` already excludes
 * the cache and `total` includes input, output, reasoning, and cache. Prefer
 * that canonical total; the individual fields remain useful breakdowns.
 */
export function extractOpencodeBucket(record: unknown): TokenBucket | null {
  if (!record || typeof record !== "object") return null;
  const row = record as Record<string, unknown>;
  if (row.role !== "assistant") return null;
  const tokens = row.tokens;
  if (!tokens || typeof tokens !== "object") return null;
  const counts = tokens as Record<string, unknown>;
  const cacheRaw = counts.cache;
  const cache =
    cacheRaw && typeof cacheRaw === "object"
      ? (cacheRaw as Record<string, unknown>)
      : {};
  const input = asNumber(counts.input);
  const output = asNumber(counts.output);
  const reasoning = asNumber(counts.reasoning);
  const cached = asNumber(cache.read) + asNumber(cache.write);
  const reportedTotal = asNumber(counts.total);
  const total =
    reportedTotal > 0
      ? reportedTotal
      : input + output + reasoning + cached;
  if (total <= 0 && cached <= 0) return null;
  return { tokens: total, input, output, cached, reasoning, turns: 1 };
}

export function scanOpencodeStores(options?: {
  nowMs?: number;
  paths?: readonly string[];
  cached?: Map<
    string,
    { mtimeMs: number; size: number; daily: Record<string, TokenBucket> }
  >;
}): OpencodeFileScan[] {
  const cached = options?.cached ?? new Map();
  const cutoff = (options?.nowMs ?? Date.now()) - 90 * 24 * 60 * 60 * 1000;
  const files: OpencodeFileScan[] = [];

  for (const path of options?.paths ?? opencodeDbPaths()) {
    const fingerprint = dbFingerprint(path);
    if (!fingerprint) continue;

    const prior = cached.get(path);
    if (
      prior &&
      prior.mtimeMs === fingerprint.mtimeMs &&
      prior.size === fingerprint.size
    ) {
      files.push({ path, ...fingerprint, daily: prior.daily });
      continue;
    }

    const db = openSqlite(path);
    if (!db) continue;
    const daily: Record<string, TokenBucket> = {};
    try {
      // Pull only the token scalars. Shipping `data` (avg ~7KB, some multi-MB)
      // into JS just to JSON.parse it is the cold-scan cost on a 1GB db.
      const rows = db.all<{
        time_created: number;
        total: unknown;
        input: unknown;
        output: unknown;
        reasoning: unknown;
        cache_read: unknown;
        cache_write: unknown;
      }>(
        "select time_created," +
          " json_extract(data, '$.tokens.total') as total," +
          " json_extract(data, '$.tokens.input') as input," +
          " json_extract(data, '$.tokens.output') as output," +
          " json_extract(data, '$.tokens.reasoning') as reasoning," +
          " json_extract(data, '$.tokens.cache.read') as cache_read," +
          " json_extract(data, '$.tokens.cache.write') as cache_write" +
          " from message where time_created >= ?" +
          " and (json_extract(data, '$.tokens.total') > 0" +
          " or json_extract(data, '$.tokens.cache.read') > 0" +
          " or json_extract(data, '$.tokens.cache.write') > 0)",
        cutoff,
      );
      for (const row of rows) {
        const atMs = asNumber(row.time_created);
        if (atMs <= 0) continue;
        const input = asNumber(row.input);
        const output = asNumber(row.output);
        const reasoning = asNumber(row.reasoning);
        const cached = asNumber(row.cache_read) + asNumber(row.cache_write);
        const reportedTotal = asNumber(row.total);
        const tokens =
          reportedTotal > 0 ? reportedTotal : input + output + reasoning + cached;
        if (tokens <= 0 && cached <= 0) continue;
        const key = dayKey(atMs);
        const current = daily[key] ?? emptyBucket();
        addBucket(current, {
          tokens,
          input,
          output,
          cached,
          reasoning,
          turns: 1,
        });
        daily[key] = current;
      }
    } catch {
      continue;
    } finally {
      db.close();
    }

    files.push({ path, ...fingerprint, daily });
  }

  return files;
}

export function mergeOpencodeDaily(
  daily: Record<string, Record<string, TokenBucket>>,
  files: OpencodeFileScan[],
): void {
  for (const file of files) {
    for (const [day, bucket] of Object.entries(file.daily)) {
      const row = daily[day] ?? {};
      const current = row.opencode ?? emptyBucket();
      addBucket(current, bucket);
      row.opencode = current;
      daily[day] = row;
    }
  }
}

const LIVE_RESCAN_OVERLAP_MS = 5 * 60_000;

function opencodeCompletedAt(record: unknown, fallback: number): number {
  if (!record || typeof record !== "object") return fallback;
  const time = (record as Record<string, unknown>).time;
  if (!time || typeof time !== "object") return fallback;
  const completed = asNumber((time as Record<string, unknown>).completed);
  return completed > 0 ? completed : fallback;
}

/**
 * Exact per-call samples for opencode sessions launched by BB. The source
 * keeps a small overlap because opencode inserts a zero-token assistant row
 * when a call starts, then updates that same row with final usage on finish.
 */
export function createOpencodeLiveThroughputSource(options?: {
  paths?: readonly string[];
}): LocalThroughputSource {
  const newestCreatedAt = new Map<string, number>();

  return {
    providerId: "opencode",
    scan({ sessionIds, sinceMs }) {
      const samples: LocalThroughputSample[] = [];
      const paths = options?.paths ?? opencodeDbPaths();
      for (const path of paths) {
        const db = openSqlite(path);
        if (!db) continue;
        try {
          for (const sessionId of sessionIds) {
            const previous = newestCreatedAt.get(sessionId);
            const cutoff =
              previous === undefined
                ? sinceMs
                : Math.max(sinceMs, previous - LIVE_RESCAN_OVERLAP_MS);
            const rows = db.all<{
              id: string;
              session_id: string;
              time_created: number;
              time_updated: number;
              data: string;
            }>(
              "select id, session_id, time_created, time_updated, data" +
                " from message where session_id = ? and time_created >= ?" +
                " and data like '%\"tokens\"%' order by time_created asc, id asc",
              sessionId,
              cutoff,
            );
            let latest = previous ?? 0;
            for (const row of rows) {
              const createdAt = asNumber(row.time_created);
              if (createdAt > latest) latest = createdAt;
              let record: unknown;
              try {
                record = JSON.parse(row.data);
              } catch {
                continue;
              }
              const bucket = extractOpencodeBucket(record);
              if (!bucket) continue;
              const atMs = opencodeCompletedAt(
                record,
                asNumber(row.time_updated) || createdAt,
              );
              if (atMs <= sinceMs) continue;
              samples.push({
                id: row.id,
                sessionId: row.session_id,
                atMs,
                bucket,
              });
            }
            if (latest > 0) newestCreatedAt.set(sessionId, latest);
          }
        } finally {
          db.close();
        }
      }
      return samples;
    },
  };
}
