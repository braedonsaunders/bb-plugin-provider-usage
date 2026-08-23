import { createRequire } from "node:module";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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
}

const require = createRequire(import.meta.url);
const DEFAULT_WINDOW = 200_000;

type SqliteDb = {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  close(): void;
};

/** Approximate o200k/cl100k without shipping a BPE table. */
function estimateTokens(text: string): number {
  if (!text) return 0;
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

function fileTimes(path: string): { mtimeMs: number; birthMs: number; size: number } {
  const info = statSync(path);
  const birth =
    "birthtimeMs" in info && Number.isFinite(info.birthtimeMs)
      ? info.birthtimeMs
      : info.mtimeMs;
  return {
    mtimeMs: Math.round(info.mtimeMs),
    birthMs: Math.round(birth),
    size: info.size,
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

export function scanCursorStores(options?: {
  nowMs?: number;
  cached?: Map<
    string,
    { mtimeMs: number; size: number; daily: Record<string, TokenBucket> }
  >;
}): CursorFileScan[] {
  const cached = options?.cached ?? new Map();
  const cutoff = (options?.nowMs ?? Date.now()) - 90 * 24 * 60 * 60 * 1000;
  const files: CursorFileScan[] = [];

  for (const path of listAcpStorePaths()) {
    let times;
    try {
      times = fileTimes(path);
    } catch {
      continue;
    }
    if (times.size === 0) continue;
    if (times.mtimeMs < cutoff && times.birthMs < cutoff) continue;

    const prior = cached.get(path);
    const stale =
      !prior ||
      prior.mtimeMs !== times.mtimeMs ||
      prior.size !== times.size;

    let daily: Record<string, TokenBucket>;
    if (!stale && prior) {
      daily = prior.daily;
    } else {
      const bucket = readAcpStoreBucket(path);
      if (!bucket) continue;
      daily = applyBucketToDaily(prior?.daily, bucket, times.birthMs, times.mtimeMs);
    }

    files.push({
      path,
      mtimeMs: times.mtimeMs,
      size: times.size,
      daily,
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
