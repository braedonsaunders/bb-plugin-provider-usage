import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  cached?: Map<
    string,
    { mtimeMs: number; size: number; daily: Record<string, TokenBucket> }
  >;
}): OpencodeFileScan[] {
  const cached = options?.cached ?? new Map();
  const cutoff = (options?.nowMs ?? Date.now()) - 90 * 24 * 60 * 60 * 1000;
  const files: OpencodeFileScan[] = [];

  for (const path of opencodeDbPaths()) {
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
      const rows = db.all<{ time_created: number; data: string }>(
        "select time_created, data from message" +
          " where time_created >= ? and data like '%\"tokens\"%'",
        cutoff,
      );
      for (const row of rows) {
        let record: unknown;
        try {
          record = JSON.parse(row.data);
        } catch {
          continue;
        }
        const bucket = extractOpencodeBucket(record);
        if (!bucket) continue;
        const atMs = asNumber(row.time_created);
        if (atMs <= 0) continue;
        const key = dayKey(atMs);
        const current = daily[key] ?? emptyBucket();
        addBucket(current, bucket);
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
