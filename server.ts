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
import { scanTokenFiles, type FileScanResult } from "./lib/token-scan";
import {
  TOKEN_WINDOWS,
  assembleTokenSnapshot,
  formatTokenText,
  type TokenBucket,
  type TokenSnapshot,
  type TokenWindowDays,
} from "./lib/tokens";

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

export const rpcContract = defineRpcContract({
  getDashboard: {
    input: z.object({ hostId: z.string().nullable() }).strict(),
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
});

function asLimitSlice(value: unknown): ProviderLimitSlice {
  if (!value || typeof value !== "object") {
    return { status: "error", message: "No usage data returned." };
  }
  return value as ProviderLimitSlice;
}

async function loadDashboard(
  bb: BbPluginApi,
  hostId: string | null,
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
  const [limits, catalog] = await Promise.all([
    bb.sdk.system.usageLimits(
      resolvedHostId ? { hostId: resolvedHostId } : {},
    ),
    bb.sdk.providers.list(resolvedHostId ? { hostId: resolvedHostId } : {}),
  ]);

  const slices = Object.fromEntries(
    PROVIDER_KEYS.map((key) => [key, asLimitSlice(limits[key])]),
  ) as Record<ProviderKey, ProviderLimitSlice>;

  return assembleDashboard({
    limits: slices,
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
  days: TokenWindowDays;
  force: boolean;
} {
  let json = false;
  let help = false;
  let tokens = false;
  let force = false;
  let days: TokenWindowDays = 30;
  let hostId: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") help = true;
    else if (arg === "--force") force = true;
    else if (arg === "tokens") tokens = true;
    else if (arg === "--days") {
      const next = Number(argv[i + 1]);
      if (isTokenWindow(next)) days = next;
      i += 1;
    } else if (arg === "--machine" || arg === "--host") {
      hostId = argv[i + 1] ?? null;
      i += 1;
    }
  }
  return { json, hostId, help, tokens, days, force };
}

type TokenCacheRow = {
  path: string;
  mtime_ms: number;
  size: number;
  daily_json: string;
};

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
  ]);

  const loadCache = new Map<
    string,
    { mtimeMs: number; size: number; daily: Record<string, TokenBucket> }
  >();
  for (const row of db
    .prepare(
      "SELECT path, mtime_ms, size, daily_json FROM token_file_cache",
    )
    .all() as TokenCacheRow[]) {
    try {
      loadCache.set(row.path, {
        mtimeMs: row.mtime_ms,
        size: row.size,
        daily: JSON.parse(row.daily_json) as Record<string, TokenBucket>,
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
          JSON.stringify(file.daily),
        );
        loadCache.set(file.path, {
          mtimeMs: file.mtimeMs,
          size: file.size,
          daily: file.daily,
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

  const sync = async (days: TokenWindowDays, force = false) => {
    if (inflight) return inflight;
    inflight = (async () => {
      const cached = force ? new Map() : loadCache;
      const jsonl = await scanTokenFiles({ cached, includeCursor: false });
      persistFiles(jsonl.files);
      snapshotFrom(days, jsonl);
      publish();
      const full = await scanTokenFiles({ cached: loadCache, includeCursor: true });
      persistFiles(full.files);
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
        });
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
    });
    persistFiles(jsonl.files);
    const snapshot = snapshotFrom(days, jsonl);
    void sync(days);
    return snapshot;
  };

  return { get, sync };
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");
  const tokens = createTokenStore(bb);

  bb.rpc.register(rpcContract, {
    async getDashboard({ hostId }) {
      return loadDashboard(bb, hostId);
    },
    async getTokens({ days, force }) {
      return tokens.get(days, force === true);
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
    ],
    async run(argv) {
      const { json, hostId, help, tokens: tokensOnly, days, force } =
        parseCliArgs(argv);
      if (help) {
        return {
          exitCode: 0,
          stdout:
            "Usage: bb usage [show|tokens] [--days 7|30|90] [--machine <id-or-name>] [--force] [--json]\n",
        };
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

      const snapshot = await loadDashboard(bb, resolvedHostId);
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
