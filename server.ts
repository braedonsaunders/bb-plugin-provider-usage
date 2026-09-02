import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  PROVIDER_KEYS,
  assembleDashboard,
  formatDashboardText,
  type DashboardSnapshot,
  type ProviderKey,
  type ProviderLimitSlice,
  type UsageHost,
} from "./lib/dashboard";
import {
  scanTokenFiles,
  seedDailyFromCache,
  type FileCacheEntry,
  type FileScanResult,
} from "./lib/token-scan";
import {
  mergeDaily,
  scanBbThreadUsage,
  type BbUsageEvent,
  type BbUsageTotal,
} from "./lib/bb-usage-scan";
import {
  TOKEN_WINDOWS,
  assembleTokenSnapshot,
  formatTokenText,
  type TokenBucket,
  type TokenSnapshot,
  type TokenWindowDays,
} from "./lib/tokens";
import {
  createThroughputRecorder,
  formatThroughputText,
  type ThroughputSnapshot,
} from "./lib/throughput";
import {
  createThroughputScanner,
  type ThroughputScanThread,
} from "./lib/throughput-scan";
import { createLocalThroughputScanner } from "./lib/local-throughput-scan";
import { createOpencodeLiveThroughputSource } from "./lib/opencode-scan";
import { createCursorLiveThroughputSource } from "./lib/cursor-scan";
import { readCodexUsageSupplement } from "./lib/codex-usage";
import {
  hasRateLimitedProvider,
  overlayLastGoodLimits,
  rememberGoodLimits,
  shouldReuseCachedLimits,
} from "./lib/limits-cache";
import { normalizeProviderLimits } from "./lib/provider-limits";

const usageWindowSchema = z.object({
  label: z.string(),
  usedPercent: z.number(),
  remainingPercent: z.number(),
  resetsAt: z.string().nullable(),
  cost: z
    .object({
      usedUsdCents: z.number(),
      limitUsdCents: z.number(),
      remainingUsdCents: z.number(),
    })
    .nullable(),
});

const providerUsageSchema = z.object({
  key: z.enum(PROVIDER_KEYS),
  id: z.string(),
  displayName: z.string(),
  logoUrl: z.string().nullable(),
  status: z.enum([
    "ok",
    "not_installed",
    "unauthenticated",
    "expired",
    "error",
  ]),
  accountEmail: z.string().nullable(),
  planLabel: z.string().nullable(),
  message: z.string().nullable(),
  windows: z.array(usageWindowSchema),
  credits: z
    .object({
      hasCredits: z.boolean(),
      unlimited: z.boolean(),
      balance: z.string().nullable(),
    })
    .nullable(),
  spendControl: z
    .object({
      used: z.string(),
      limit: z.string(),
      remainingPercent: z.number(),
      resetsAt: z.string().nullable(),
      reached: z.boolean().nullable(),
    })
    .nullable(),
  resetCredits: z
    .object({
      availableCount: z.number().int(),
      nextExpiresAt: z.string().nullable(),
      title: z.string().nullable(),
      description: z.string().nullable(),
    })
    .nullable(),
});

const dashboardSchema = z.object({
  fetchedAt: z.string(),
  hostId: z.string().nullable(),
  hosts: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.enum(["connected", "disconnected"]),
    }),
  ),
  providers: z.array(providerUsageSchema),
  totals: z.object({
    trackedProviders: z.number().int(),
    okProviders: z.number().int(),
    windowCount: z.number().int(),
    averageUsedPercent: z.number().nullable(),
    averageRemainingPercent: z.number().nullable(),
    cumulativeRemainingPercent: z.number().nullable(),
    tightest: z
      .object({
        providerId: z.string(),
        providerName: z.string(),
        windowLabel: z.string(),
        usedPercent: z.number(),
        remainingPercent: z.number(),
      })
      .nullable(),
    nextResetAt: z.string().nullable(),
    spend: z
      .object({
        usedUsdCents: z.number(),
        limitUsdCents: z.number(),
        remainingUsdCents: z.number(),
      })
      .nullable(),
  }),
});

const tokenBucketSchema = z.object({
  tokens: z.number(),
  input: z.number(),
  output: z.number(),
  cached: z.number(),
  reasoning: z.number(),
  turns: z.number(),
});

const tokenSnapshotSchema = z.object({
  days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  scannedAt: z.string(),
  fileCount: z.number().int(),
  changedFiles: z.number().int(),
  sources: z.array(z.string()),
  totals: tokenBucketSchema,
  providers: z.array(
    tokenBucketSchema.extend({
      id: z.string(),
      displayName: z.string(),
      percent: z.number(),
    }),
  ),
  series: z.array(
    z.object({
      day: z.string(),
      label: z.string(),
      total: z.number(),
      byProvider: z.record(z.string(), z.number()),
    }),
  ),
});

const throughputSnapshotSchema = z.object({
  sampledAt: z.string(),
  nowMs: z.number(),
  windowMs: z.number(),
  binMs: z.number(),
  rateWindowMs: z.number(),
  tokensPerMinute: z.number(),
  peakTokensPerMinute: z.number(),
  peakAtMs: z.number().nullable(),
  windowTotals: tokenBucketSchema,
  activeThreads: z.number().int(),
  trackedThreads: z.number().int(),
  live: z.boolean(),
  providers: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      tokens: z.number(),
      tokensPerMinute: z.number(),
      sharePercent: z.number(),
      lastAtMs: z.number().nullable(),
    }),
  ),
  series: z.array(
    z.object({
      atMs: z.number(),
      total: z.number(),
      byProvider: z.record(z.string(), z.number()),
    }),
  ),
  threads: z.array(
    z.object({
      threadId: z.string(),
      title: z.string(),
      providerId: z.string(),
      providerName: z.string(),
      status: z.string(),
      tokens: z.number(),
      tokensPerMinute: z.number(),
      lastAtMs: z.number(),
    }),
  ),
});

export const rpcContract = defineRpcContract({
  getDashboard: {
    input: z
      .object({
        hostId: z.string().nullable(),
        force: z.boolean().optional(),
      })
      .strict(),
    output: dashboardSchema,
  },
  getTokens: {
    input: z
      .object({
        days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
        force: z.boolean().optional(),
      })
      .strict(),
    output: tokenSnapshotSchema,
  },
  getThroughput: {
    input: z.null(),
    output: throughputSnapshotSchema,
  },
});

type LastGoodLimits = Partial<Record<ProviderKey, ProviderLimitSlice>>;

type LastFetch = {
  at: number;
  hostId: string | null;
  limits: Record<ProviderKey, ProviderLimitSlice>;
  rateLimitedAt: number | null;
};

function createLimitStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  const read = db.prepare("SELECT value FROM limits_cache WHERE key = ?");
  const write = db.prepare(
    `INSERT INTO limits_cache (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  const readJson = <T>(key: string): T | null => {
    const row = read.get(key) as { value?: string } | undefined;
    if (!row?.value) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  };

  let lastGood = readJson<LastGoodLimits>("last-good") ?? {};
  let lastFetch = readJson<LastFetch>("last-fetch");
  let inflight: Promise<Record<ProviderKey, ProviderLimitSlice>> | null = null;

  const persist = () => {
    write.run("last-good", JSON.stringify(lastGood));
    if (lastFetch) write.run("last-fetch", JSON.stringify(lastFetch));
  };

  const readLive = async (hostId: string | null) => {
    const raw = await bb.sdk.system.usageLimits(hostId ? { hostId } : {});
    const fresh = normalizeProviderLimits(raw);
    const limits = overlayLastGoodLimits(fresh, lastGood);
    lastGood = rememberGoodLimits(limits, lastGood);
    lastFetch = {
      at: Date.now(),
      hostId,
      limits,
      rateLimitedAt: hasRateLimitedProvider(fresh) ? Date.now() : null,
    };
    persist();
    if (hasRateLimitedProvider(fresh)) {
      bb.log.warn(
        "usage limits: a provider was rate-limited; serving last good windows",
      );
    }
    return limits;
  };

  const get = async (hostId: string | null, force = false) => {
    if (
      lastFetch &&
      lastFetch.hostId === hostId &&
      shouldReuseCachedLimits({
        nowMs: Date.now(),
        fetchedAtMs: lastFetch.at,
        rateLimitedAtMs: lastFetch.rateLimitedAt,
        force,
      })
    ) {
      return lastFetch.limits;
    }
    if (inflight && !force) return inflight;
    const run = readLive(hostId);
    inflight = run;
    try {
      return await run;
    } finally {
      if (inflight === run) inflight = null;
    }
  };

  return { get };
}

async function loadDashboard(
  bb: BbPluginApi,
  hostId: string | null,
  limitsStore: { get: (hostId: string | null, force?: boolean) => Promise<Record<ProviderKey, ProviderLimitSlice>> },
  force = false,
): Promise<DashboardSnapshot> {
  const hosts = (await bb.sdk.hosts.list()).map(
    (host): UsageHost => ({
      id: host.id,
      name: host.name,
      status: host.status,
    }),
  );
  const resolvedHostId =
    hostId && hosts.some((host) => host.id === hostId) ? hostId : null;
  const [slices, catalog] = await Promise.all([
    limitsStore.get(resolvedHostId, force),
    bb.sdk.providers.list(resolvedHostId ? { hostId: resolvedHostId } : {}),
  ]);

  const codexSupplement =
    resolvedHostId === null && slices.codex.status === "ok"
      ? await readCodexUsageSupplement()
      : null;

  return assembleDashboard({
    limits: slices,
    supplements: codexSupplement ? { codex: codexSupplement } : undefined,
    hosts,
    catalog,
    hostId: resolvedHostId,
  });
}

function isTokenWindow(value: number): value is TokenWindowDays {
  return (TOKEN_WINDOWS as readonly number[]).includes(value);
}

function parseCliArgs(argv: string[]): {
  json: boolean;
  hostId: string | null;
  help: boolean;
  tokens: boolean;
  live: boolean;
  days: TokenWindowDays;
  force: boolean;
} {
  let json = false;
  let help = false;
  let tokens = false;
  let live = false;
  let force = false;
  let days: TokenWindowDays = 30;
  let hostId: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") help = true;
    else if (arg === "--force") force = true;
    else if (arg === "tokens") tokens = true;
    else if (arg === "live") live = true;
    else if (arg === "--days") {
      const next = Number(argv[i + 1]);
      if (isTokenWindow(next)) days = next;
      i += 1;
    } else if (arg === "--machine" || arg === "--host") {
      hostId = argv[i + 1] ?? null;
      i += 1;
    }
  }
  return { json, hostId, help, tokens, live, days, force };
}

type TokenCacheRow = {
  path: string;
  mtime_ms: number;
  size: number;
  daily_json: string;
};

type PersistedTokenFile = {
  version: 2;
  daily: Record<string, TokenBucket>;
  keyedEvents?: FileScanResult["keyedEvents"];
  blobCount?: number;
  maxRowid?: number;
};

function isPersistedTokenFile(value: unknown): value is PersistedTokenFile {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return row.version === 2 && !!row.daily && typeof row.daily === "object";
}

function createTokenStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS token_file_cache (
      path TEXT PRIMARY KEY,
      mtime_ms INTEGER NOT NULL,
      size INTEGER NOT NULL,
      daily_json TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS token_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `DELETE FROM token_file_cache`,
    // Token accounting v2: Total now follows each provider's canonical total
    // (cache included, reasoning not double-counted). Reparse persisted files.
    `DELETE FROM token_file_cache`,
    // Identity-aware transcript parsing stores Claude message ids so the same
    // response is deduplicated across fragments and copied subagent files.
    `DELETE FROM token_file_cache`,
    `CREATE TABLE IF NOT EXISTS limits_cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  ]);

  const loadCache = new Map<string, FileCacheEntry>();
  for (const row of db
    .prepare(
      "SELECT path, mtime_ms, size, daily_json FROM token_file_cache",
    )
    .all() as TokenCacheRow[]) {
    try {
      const parsed = JSON.parse(row.daily_json) as
        | PersistedTokenFile
        | Record<string, TokenBucket>;
      const persisted: PersistedTokenFile = isPersistedTokenFile(parsed)
        ? parsed
        : { version: 2, daily: parsed as Record<string, TokenBucket> };
      loadCache.set(row.path, {
        mtimeMs: row.mtime_ms,
        size: row.size,
        daily: persisted.daily,
        ...(persisted.keyedEvents
          ? { keyedEvents: persisted.keyedEvents }
          : {}),
        ...(persisted.blobCount != null
          ? { blobCount: persisted.blobCount, maxRowid: persisted.maxRowid }
          : {}),
      });
    } catch {
      continue;
    }
  }

  const upsert = db.prepare(
    `INSERT INTO token_file_cache (path, mtime_ms, size, daily_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       mtime_ms = excluded.mtime_ms,
       size = excluded.size,
       daily_json = excluded.daily_json`,
  );
  const writeMeta = db.prepare(
    `INSERT INTO token_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const readMeta = db.prepare("SELECT value FROM token_meta WHERE key = ?");

  let inflight: Promise<TokenSnapshot> | null = null;
  let lastSnapshot: TokenSnapshot | null = null;

  const publish = () => {
    bb.realtime.publish("tokens", { at: Date.now() });
  };

  const persistFiles = (files: FileScanResult[]) => {
    const tx = db.transaction((rows: FileScanResult[]) => {
      for (const file of rows) {
        upsert.run(
          file.path,
          file.mtimeMs,
          file.size,
          JSON.stringify({
            version: 2,
            daily: file.daily,
            ...(file.keyedEvents ? { keyedEvents: file.keyedEvents } : {}),
            ...(file.blobCount != null
              ? { blobCount: file.blobCount, maxRowid: file.maxRowid }
              : {}),
          } satisfies PersistedTokenFile),
        );
        loadCache.set(file.path, {
          mtimeMs: file.mtimeMs,
          size: file.size,
          daily: file.daily,
          ...(file.keyedEvents ? { keyedEvents: file.keyedEvents } : {}),
          ...(file.blobCount != null
            ? { blobCount: file.blobCount, maxRowid: file.maxRowid }
            : {}),
        });
      }
    });
    tx(files);
  };

  const snapshotFrom = (
    days: TokenWindowDays,
    scanned: {
      files: FileScanResult[];
      changedFiles: number;
      sources: string[];
      daily: Record<string, Record<string, TokenBucket>>;
    },
  ) => {
    const snapshot = assembleTokenSnapshot({
      days,
      fileCount: scanned.files.length,
      changedFiles: scanned.changedFiles,
      sources: scanned.sources,
      daily: scanned.daily,
    });
    lastSnapshot = snapshot;
    writeMeta.run("last-scan", snapshot.scannedAt);
    return snapshot;
  };

  const hasCursorCache = () =>
    [...loadCache.keys()].some(
      (path) => path.includes("acp-sessions") || path.endsWith("store.db"),
    );
  const hasOpencodeCache = () =>
    [...loadCache.keys()].some((path) => path.endsWith("opencode.db"));

  const paintCachedStores = (
    scanned: {
      sources: string[];
      daily: Record<string, Record<string, TokenBucket>>;
    },
  ) => {
    seedDailyFromCache(scanned.daily, scanned.sources, loadCache, "cursor");
    seedDailyFromCache(scanned.daily, scanned.sources, loadCache, "opencode");
  };

  /**
   * Every provider bb can drive, without a scanner per vendor: bb's own
   * `thread/tokenUsage/updated` is part of the provider-bridge contract, so an
   * agent the plugin has never heard of still lands in the chart as soon as it
   * reports usage. Providers with a dedicated transcript scanner are skipped
   * inside scanBbThreadUsage so they are not counted twice.
   */
  const scanBbThreads = async (nowMs: number) =>
    scanBbThreadUsage({
      nowMs,
      onError: (error) =>
        bb.log.warn(
          `bb thread usage scan: ${error instanceof Error ? error.message : String(error)}`,
        ),
      listThreads: async () => {
        const rows = await bb.sdk.threads.list({ includeHidden: true });
        return rows.map((row) => ({
          id: row.id,
          providerId: row.providerId,
          updatedAt: row.updatedAt,
        }));
      },
      listEvents: async (threadId) => {
        const rows = await bb.sdk.threads.events.list({
          threadId,
          types: ["thread/tokenUsage/updated"],
        });
        const events: BbUsageEvent[] = [];
        for (const row of rows) {
          if (row.type !== "thread/tokenUsage/updated") continue;
          const total = row.data.tokenUsage?.total as BbUsageTotal | undefined;
          if (!total) continue;
          events.push({ seq: row.seq, createdAt: row.createdAt, total });
        }
        return events;
      },
    });

  const sync = async (days: TokenWindowDays, force = false) => {
    if (inflight) return inflight;
    inflight = (async () => {
      const nowMs = Date.now();
      const cached = force ? new Map() : loadCache;
      const phase1Started = Date.now();
      // jsonl (Codex/Claude) is the cheap first paint. Seed cursor/opencode
      // from the last persisted totals so those series never vanish while
      // the heavier stores refresh.
      const jsonl = await scanTokenFiles({
        cached,
        includeCursor: false,
        includeOpencode: false,
      });
      persistFiles(jsonl.files);
      if (!force) paintCachedStores(jsonl);
      snapshotFrom(days, jsonl);
      publish();
      bb.log.info(
        `token scan phase1 ${Date.now() - phase1Started}ms sources=[${jsonl.sources.join(", ")}]`,
      );

      const phase2Started = Date.now();
      const full = await scanTokenFiles({
        cached: loadCache,
        includeCursor: true,
        includeOpencode: true,
      });
      persistFiles(full.files);
      const bbUsage = await scanBbThreads(nowMs);
      mergeDaily(full.daily, bbUsage.daily);
      full.sources.push(...bbUsage.providers);
      bb.log.info(
        `token scan phase2 ${Date.now() - phase2Started}ms ` +
          `changed=${full.changedFiles} ` +
          `bbThreads=${bbUsage.threadsScanned} ` +
          `providers [${bbUsage.providers.join(", ") || "none"}]`,
      );
      const snapshot = snapshotFrom(days, full);
      publish();
      return snapshot;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const get = async (days: TokenWindowDays, force = false) => {
    if (force) return sync(days, true);
    if (lastSnapshot) {
      if (lastSnapshot.days !== days) {
        const scanned = await scanTokenFiles({
          cached: loadCache,
          includeCursor: hasCursorCache(),
          includeOpencode: hasOpencodeCache(),
        });
        paintCachedStores(scanned);
        return assembleTokenSnapshot({
          days,
          fileCount: scanned.files.length,
          changedFiles: scanned.changedFiles,
          sources: scanned.sources,
          daily: scanned.daily,
        });
      }
      if (!inflight) {
        const lastScan = (
          readMeta.get("last-scan") as { value?: string } | undefined
        )?.value;
        const stale =
          !lastScan || Date.now() - Date.parse(lastScan) >= 120_000;
        if (stale) void sync(days);
      }
      return lastSnapshot;
    }
    const jsonl = await scanTokenFiles({
      cached: loadCache,
      includeCursor: false,
      includeOpencode: false,
    });
    persistFiles(jsonl.files);
    paintCachedStores(jsonl);
    const snapshot = snapshotFrom(days, jsonl);
    void sync(days);
    return snapshot;
  };

  return { get, sync };
}

/** Poll cadence while at least one thread is working, and while none are. */
const THROUGHPUT_BUSY_MS = 2_000;
const THROUGHPUT_QUIET_MS = 10_000;

function createThroughputStore(bb: BbPluginApi) {
  const recorder = createThroughputRecorder();
  let tracked = 0;
  let working = 0;
  let sharedThreads: Promise<ThroughputScanThread[]> | null = null;
  let refreshInflight: Promise<ThroughputSnapshot> | null = null;

  const readThreads = async (): Promise<ThroughputScanThread[]> => {
    const rows = await bb.sdk.threads.list({ includeHidden: true });
    return rows
      .filter((row) => !row.archivedAt && !row.deletedAt)
      .map(
        (row): ThroughputScanThread => ({
          id: row.id,
          providerId: row.providerId,
          title: row.title ?? row.titleFallback ?? null,
          status: row.status,
          updatedAt: row.updatedAt,
          createdAt: row.createdAt,
          archivedAt: row.archivedAt ?? null,
          deletedAt: row.deletedAt ?? null,
        }),
      );
  };
  const listThreads = () => sharedThreads ?? readThreads();

  const scanner = createThroughputScanner(recorder, {
    onError: (error) =>
      bb.log.warn(
        `throughput scan: ${error instanceof Error ? error.message : String(error)}`,
      ),
    listThreads,
    listEvents: async ({ threadId, afterSeq, order, limit }) => {
      const rows = await bb.sdk.threads.events.list({
        threadId,
        types: ["thread/tokenUsage/updated"],
        order,
        limit: String(limit),
        ...(afterSeq === undefined ? {} : { afterSeq: String(afterSeq) }),
      });
      const events: BbUsageEvent[] = [];
      for (const row of rows) {
        if (row.type !== "thread/tokenUsage/updated") continue;
        const usage = row.data.tokenUsage;
        const total = usage?.total as BbUsageTotal | undefined;
        if (!total) continue;
        const last = usage?.last as BbUsageTotal | undefined;
        events.push({
          seq: row.seq,
          createdAt: row.createdAt,
          total,
          ...(last ? { last } : {}),
        });
      }
      return events;
    },
  });

  const localScanner = createLocalThroughputScanner(recorder, {
    listThreads,
    sources: [
      createOpencodeLiveThroughputSource(),
      createCursorLiveThroughputSource(),
    ],
    onError: (error) =>
      bb.log.warn(
        `local throughput scan: ${error instanceof Error ? error.message : String(error)}`,
      ),
    listThreadSessionInfo: async (threadId) => {
      const [identityRows, usageRows] = await Promise.all([
        bb.sdk.threads.events.list({
          threadId,
          types: ["thread/identity"],
          order: "desc",
          limit: "100",
        }),
        bb.sdk.threads.events.list({
          threadId,
          types: ["thread/tokenUsage/updated"],
          order: "desc",
          limit: "1",
        }),
      ]);
      const sessionIds = new Set<string>();
      for (const row of identityRows) {
        if (row.type === "thread/identity" && row.data.providerThreadId) {
          sessionIds.add(row.data.providerThreadId);
        }
      }
      return {
        sessionIds: [...sessionIds],
        hasNativeUsage: usageRows.some(
          (row) => row.type === "thread/tokenUsage/updated",
        ),
      };
    },
  });

  const snapshot = (nowMs = Date.now()): ThroughputSnapshot =>
    recorder.snapshot(nowMs, tracked);

  const refresh = async (): Promise<ThroughputSnapshot> => {
    if (refreshInflight) return refreshInflight;
    const run = (async () => {
      const nowMs = Date.now();
      sharedThreads = readThreads();
      try {
        const result = await scanner.refresh(nowMs);
        await localScanner.refresh(nowMs);
        tracked = result.tracked;
        working = result.working;
        return snapshot(nowMs);
      } finally {
        sharedThreads = null;
      }
    })();
    refreshInflight = run;
    try {
      return await run;
    } finally {
      if (refreshInflight === run) refreshInflight = null;
    }
  };

  return {
    snapshot,
    refresh,
    markDirty: (threadId: string) => {
      scanner.markDirty(threadId);
      localScanner.markDirty(threadId);
    },
    /** Poll fast while work is in flight, slowly when the machine is quiet. */
    intervalMs: () => (working > 0 ? THROUGHPUT_BUSY_MS : THROUGHPUT_QUIET_MS),
  };
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");
  const tokens = createTokenStore(bb);
  const limits = createLimitStore(bb);
  const throughput = createThroughputStore(bb);

  bb.rpc.register(rpcContract, {
    async getDashboard({ hostId, force }) {
      return loadDashboard(bb, hostId, limits, force === true);
    },
    async getTokens({ days, force }) {
      return tokens.get(days, force === true);
    },
    async getThroughput() {
      return throughput.snapshot();
    },
  });

  bb.background.service("token-scan", {
    async start(signal) {
      try {
        await tokens.sync(30);
        bb.realtime.publish("tokens", { at: Date.now() });
      } catch (error) {
        bb.log.warn(
          `initial token scan failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 15 * 60_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        if (signal.aborted) break;
        try {
          await tokens.sync(30);
          bb.realtime.publish("tokens", { at: Date.now() });
        } catch (error) {
          bb.log.warn(
            `token scan failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    },
  });

  bb.background.service("throughput-scan", {
    async start(signal) {
      // A thread row changes the moment its turn moves, which is the earliest
      // signal available that new usage events may exist — well before the
      // next poll would have come round.
      let unsubscribe: (() => void) | null = null;
      try {
        unsubscribe = bb.sdk.subscribe({
          event: "thread:changed",
          callback: (event) => {
            if (event.id) throughput.markDirty(event.id);
          },
        });
      } catch (error) {
        bb.log.warn(
          `throughput thread subscription unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      signal.addEventListener("abort", () => unsubscribe?.(), { once: true });

      let previous = "";
      while (!signal.aborted) {
        try {
          const snapshot = await throughput.refresh();
          // Publish only on change: an idle machine should not wake every
          // connected client every two seconds.
          const signature = `${snapshot.windowTotals.tokens}:${snapshot.windowTotals.turns}:${snapshot.activeThreads}`;
          if (signature !== previous) {
            previous = signature;
            bb.realtime.publish("throughput", { at: snapshot.nowMs });
          }
        } catch (error) {
          bb.log.warn(
            `throughput refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (signal.aborted) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, throughput.intervalMs());
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
      unsubscribe?.();
    },
  });

  bb.cli.register({
    name: "usage",
    summary: "Show provider subscription usage, remaining limits, and token totals",
    commands: [
      {
        name: "show",
        summary: "Print remaining usage, plans, and reset windows",
        usage: "bb usage [show] [--machine <id-or-name>] [--json]",
      },
      {
        name: "tokens",
        summary: "Print global token usage across providers",
        usage: "bb usage tokens [--days 7|30|90] [--force] [--json]",
      },
      {
        name: "live",
        summary: "Print live token throughput across running threads",
        usage: "bb usage live [--json]",
      },
    ],
    async run(argv) {
      const { json, hostId, help, tokens: tokensOnly, live, days, force } =
        parseCliArgs(argv);
      if (help) {
        return {
          exitCode: 0,
          stdout:
            "Usage: bb usage [show|tokens|live] [--days 7|30|90] [--machine <id-or-name>] [--force] [--json]\n",
        };
      }

      if (live) {
        const snapshot = await throughput.refresh();
        if (json) {
          return { exitCode: 0, stdout: `${JSON.stringify(snapshot, null, 2)}\n` };
        }
        return { exitCode: 0, stdout: formatThroughputText(snapshot) };
      }

      if (tokensOnly) {
        const snapshot = await tokens.get(days, force);
        if (json) {
          return { exitCode: 0, stdout: `${JSON.stringify(snapshot, null, 2)}\n` };
        }
        return { exitCode: 0, stdout: formatTokenText(snapshot) };
      }

      let resolvedHostId = hostId;
      if (hostId) {
        const hosts = await bb.sdk.hosts.list();
        const match = hosts.find(
          (host) => host.id === hostId || host.name === hostId,
        );
        if (!match) {
          return {
            exitCode: 1,
            stderr: `Unknown machine: ${hostId}\n`,
          };
        }
        resolvedHostId = match.id;
      }

      const snapshot = await loadDashboard(bb, resolvedHostId, limits, force);
      const tokenSnapshot = await tokens.get(days, force);
      if (json) {
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({ ...snapshot, tokens: tokenSnapshot }, null, 2)}\n`,
        };
      }
      return {
        exitCode: 0,
        stdout: `${formatDashboardText(snapshot)}\n${formatTokenText(tokenSnapshot)}`,
      };
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
