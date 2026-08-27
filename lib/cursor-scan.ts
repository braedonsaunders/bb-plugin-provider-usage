import { createRequire } from "node:module";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
  LocalThroughputSample,
  LocalThroughputSource,
} from "./local-throughput-scan";
import {
  addBucket,
  dayKey,
  emptyBucket,
  type TokenBucket,
} from "./tokens";

export interface CursorFileScan {
  path: string;
  mtimeMs: number;
  size: number;
  daily: Record<string, TokenBucket>;
  blobCount?: number;
  maxRowid?: number;
}

export interface CursorCacheEntry {
  mtimeMs: number;
  size: number;
  daily: Record<string, TokenBucket>;
  blobCount?: number;
  maxRowid?: number;
}

export function isCursorStorePath(path: string): boolean {
  if (!path.endsWith("store.db")) return false;
  return path.includes("acp-sessions") || path.includes("/chats/") || path.includes("\\chats\\");
}

const require = createRequire(import.meta.url);
const DEFAULT_WINDOW = 200_000;

type SqliteDb = {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  close(): void;
};

const CJK_RE = /[\u2e80-\u9fff]/;

/** Approximate o200k/cl100k without shipping a BPE table. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Code and English never hit the CJK branch; skip the per-char walk.
  if (!CJK_RE.test(text)) return Math.ceil(text.length / 3.6);
  let tokens = 0;
  let latin = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0x2e80) {
      if (latin) {
        tokens += Math.ceil(latin / 3.6);
        latin = 0;
      }
      tokens += 1;
    } else {
      latin += 1;
    }
  }
  if (latin) tokens += Math.ceil(latin / 3.6);
  return tokens;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return textOf(rec.text ?? rec.result ?? rec.content ?? rec.summary ?? "");
  }
  return "";
}

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

function parseJsonBlob(data: unknown): Record<string, unknown> | null {
  try {
    if (typeof data === "string") {
      return data.startsWith("{")
        ? (JSON.parse(data) as Record<string, unknown>)
        : null;
    }
    if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
      if (data.length === 0 || data[0] !== 0x7b) return null;
      return JSON.parse(Buffer.from(data).toString("utf8")) as Record<
        string,
        unknown
      >;
    }
  } catch {
    return null;
  }
  return null;
}

function fileTimes(
  path: string,
  includeWal = true,
): { mtimeMs: number; birthMs: number; size: number } {
  const info = statSync(path);
  const birth =
    "birthtimeMs" in info && Number.isFinite(info.birthtimeMs)
      ? info.birthtimeMs
      : info.mtimeMs;
  let mtimeMs = info.mtimeMs;
  let size = info.size;
  // Live throughput still watches WAL: a busy session can grow for a long
  // time without checkpointing. The daily chart keys cache on the main file
  // only — WAL/SHM mtime chatter was forcing a full reread of hundreds of
  // stores on every page load.
  if (includeWal) {
    for (const suffix of ["-wal", "-shm"]) {
      try {
        const sidecar = statSync(`${path}${suffix}`);
        if (!sidecar.isFile()) continue;
        mtimeMs = Math.max(mtimeMs, sidecar.mtimeMs);
        size += sidecar.size;
      } catch {
        // Sidecars appear and disappear around checkpoints.
      }
    }
  }
  return {
    mtimeMs: Math.round(mtimeMs),
    birthMs: Math.round(birth),
    size,
  };
}

function bucketTotal(daily: Record<string, TokenBucket>): TokenBucket {
  const total = emptyBucket();
  for (const bucket of Object.values(daily)) addBucket(total, bucket);
  return total;
}

function subtractBucket(next: TokenBucket, prev: TokenBucket): TokenBucket {
  return {
    tokens: Math.max(0, next.tokens - prev.tokens),
    input: Math.max(0, next.input - prev.input),
    output: Math.max(0, next.output - prev.output),
    cached: Math.max(0, next.cached - prev.cached),
    reasoning: Math.max(0, next.reasoning - prev.reasoning),
    turns: Math.max(0, next.turns - prev.turns),
  };
}

/**
 * cursortrack on ACP stores: each user request bills the current context
 * window (capped), plus assistant output. Blobs have no timestamps, so the
 * first scan lands on session birth; later growth is attributed to mtime.
 */
function readAcpStoreIdentity(file: string): { blobCount: number; maxRowid: number } | null {
  const db = openSqlite(file);
  if (!db) return null;
  try {
    const row = db.all<{ n: number; max_rowid: number | null }>(
      "SELECT COUNT(*) AS n, MAX(rowid) AS max_rowid FROM blobs",
    )[0];
    return {
      blobCount: Number(row?.n ?? 0),
      maxRowid: Number(row?.max_rowid ?? 0),
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function readAcpStoreBucket(file: string): TokenBucket | null {
  const db = openSqlite(file);
  if (!db) return null;
  try {
    const rows = db.all<{ data: unknown }>(
      "SELECT data FROM blobs WHERE substr(data, 1, 1) = x'7b'",
    );
    let requests = 0;
    let assistant = 0;
    let conversation = 0;
    for (const row of rows) {
      const blob = parseJsonBlob(row.data);
      if (!blob || typeof blob.role !== "string") continue;
      const tokens = estimateTokens(textOf(blob.content));
      conversation += tokens;
      if (blob.role === "assistant") assistant += tokens;
      if (blob.role !== "user") continue;
      const cursor = (
        blob.providerOptions as { cursor?: Record<string, unknown> } | undefined
      )?.cursor;
      if (cursor && (cursor.requestId || cursor.requestContextCompleteness)) {
        requests += 1;
      }
    }
    if (requests === 0 && conversation === 0) return null;
    const window = Math.min(DEFAULT_WINDOW, Math.max(conversation, 8_000));
    const input = Math.max(1, requests) * window;
    return {
      tokens: input + assistant,
      input,
      output: assistant,
      cached: 0,
      reasoning: 0,
      turns: Math.max(1, requests),
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function listAcpStorePaths(home = homedir()): string[] {
  const found = new Map<string, string>();
  const add = (file: string) => {
    if (!existsSync(file)) return;
    const sessionId = basename(dirname(file)) || file;
    if (!found.has(sessionId)) found.set(sessionId, file);
  };

  const acpRoot = join(home, ".cursor/acp-sessions");
  try {
    for (const entry of readdirSync(acpRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      add(join(acpRoot, entry.name, "store.db"));
    }
  } catch {
    // Missing ACP root is normal when Cursor has not been used this way.
  }

  const chats = join(home, ".cursor/chats");
  try {
    for (const workspace of readdirSync(chats, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue;
      const dir = join(chats, workspace.name);
      for (const session of readdirSync(dir, { withFileTypes: true })) {
        if (!session.isDirectory()) continue;
        add(join(dir, session.name, "store.db"));
      }
    }
  } catch {
    // Optional second location.
  }

  return [...found.values()];
}

function applyBucketToDaily(
  prior: Record<string, TokenBucket> | undefined,
  bucket: TokenBucket,
  birthMs: number,
  mtimeMs: number,
): Record<string, TokenBucket> {
  if (!prior) {
    return { [dayKey(birthMs || mtimeMs)]: { ...bucket } };
  }
  const previous = bucketTotal(prior);
  const delta = subtractBucket(bucket, previous);
  if (delta.tokens <= 0 && delta.turns <= 0) return prior;
  const daily = Object.fromEntries(
    Object.entries(prior).map(([day, row]) => [day, { ...row }]),
  );
  const key = dayKey(mtimeMs);
  const current = daily[key] ?? emptyBucket();
  addBucket(current, delta);
  daily[key] = current;
  return daily;
}

function identityUnchanged(
  prior: CursorCacheEntry | undefined,
  identity: { blobCount: number; maxRowid: number } | null,
): boolean {
  return (
    !!prior &&
    !!identity &&
    prior.blobCount === identity.blobCount &&
    (prior.maxRowid ?? 0) === identity.maxRowid &&
    !!prior.daily
  );
}

export function scanCursorStores(options?: {
  nowMs?: number;
  home?: string;
  cached?: Map<string, CursorCacheEntry>;
}): CursorFileScan[] {
  const cached = options?.cached ?? new Map();
  const cutoff = (options?.nowMs ?? Date.now()) - 90 * 24 * 60 * 60 * 1000;
  const files: CursorFileScan[] = [];

  for (const path of listAcpStorePaths(options?.home)) {
    let times;
    try {
      times = fileTimes(path, false);
    } catch {
      continue;
    }
    if (times.size === 0) continue;
    if (times.mtimeMs < cutoff && times.birthMs < cutoff) continue;

    const prior = cached.get(path);
    const fingerprintStale =
      !prior ||
      prior.mtimeMs !== times.mtimeMs ||
      prior.size !== times.size;

    let daily: Record<string, TokenBucket>;
    let identity: { blobCount: number; maxRowid: number } | null =
      prior?.blobCount != null
        ? { blobCount: prior.blobCount, maxRowid: prior.maxRowid ?? 0 }
        : null;

    if (!fingerprintStale && prior) {
      daily = prior.daily;
    } else {
      // WAL/SHM mtime chatter used to bust every store. Identity is COUNT +
      // MAX(rowid): a checkpoint with no new blobs is a cache hit. An older
      // cache row with totals but no identity is also kept — we just stamp
      // the identity so the next pass can skip the open entirely.
      const nextIdentity = readAcpStoreIdentity(path);
      if (
        prior?.daily &&
        (prior.blobCount == null || identityUnchanged(prior, nextIdentity))
      ) {
        daily = prior.daily;
        identity = nextIdentity ?? identity;
      } else {
        const bucket = readAcpStoreBucket(path);
        if (!bucket) continue;
        daily = applyBucketToDaily(prior?.daily, bucket, times.birthMs, times.mtimeMs);
        identity = nextIdentity;
      }
    }

    files.push({
      path,
      mtimeMs: times.mtimeMs,
      size: times.size,
      daily,
      ...(identity
        ? { blobCount: identity.blobCount, maxRowid: identity.maxRowid }
        : {}),
    });
  }

  return files;
}

export function mergeCursorDaily(
  daily: Record<string, Record<string, TokenBucket>>,
  files: CursorFileScan[],
): void {
  for (const file of files) {
    for (const [day, bucket] of Object.entries(file.daily)) {
      const row = daily[day] ?? {};
      const current = row.cursor ?? emptyBucket();
      addBucket(current, bucket);
      row.cursor = current;
      daily[day] = row;
    }
  }
}

/**
 * Cursor ACP stores have no per-message token counters or timestamps. This
 * source therefore reports the same growing text-derived session estimate as
 * the daily chart. The local scanner differences successive snapshots and
 * labels them under the BB thread whose provider identity owns the store.
 */
export function createCursorLiveThroughputSource(options?: {
  home?: string;
}): LocalThroughputSource {
  const root = join(options?.home ?? homedir(), ".cursor/acp-sessions");
  const fingerprints = new Map<string, string>();

  return {
    providerId: "cursor",
    scan({ sessionIds }) {
      const samples: LocalThroughputSample[] = [];
      for (const sessionId of sessionIds) {
        const path = join(root, sessionId, "store.db");
        if (!existsSync(path)) continue;
        let times;
        try {
          times = fileTimes(path);
        } catch {
          continue;
        }
        const fingerprint = `${times.mtimeMs}:${times.size}`;
        if (fingerprints.get(path) === fingerprint) continue;
        const bucket = readAcpStoreBucket(path);
        if (!bucket) continue;
        fingerprints.set(path, fingerprint);
        samples.push({
          id: path,
          sessionId,
          atMs: times.mtimeMs,
          startedAtMs: times.birthMs,
          bucket,
          cumulative: true,
        });
      }
      return samples;
    },
  };
}
