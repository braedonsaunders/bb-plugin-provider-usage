import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The plugin uses bundler-style extensionless TypeScript imports. Let Node's
// type-strip test runner resolve those imports to the source files directly.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { extractCodexBucket, extractClaudeBucket } = await import(
  "../lib/token-scan.ts"
);
const { scanTokenFiles, seedDailyFromCache } = await import(
  "../lib/token-scan.ts"
);
const {
  createOpencodeLiveThroughputSource,
  extractOpencodeBucket,
  scanOpencodeStores,
} = await import("../lib/opencode-scan.ts");
const { estimateTokens, scanCursorStores } = await import(
  "../lib/cursor-scan.ts"
);
const { bucketFromTotals } = await import("../lib/bb-usage-scan.ts");
const { assembleTokenSnapshot, dayKey } = await import("../lib/tokens.ts");

test("Codex total includes cache without adding reasoning twice", () => {
  const hit = extractCodexBucket({
    timestamp: "2026-08-23T12:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          total_tokens: 1_100,
          input_tokens: 1_000,
          cached_input_tokens: 800,
          output_tokens: 100,
          reasoning_output_tokens: 40,
        },
      },
    },
  });

  assert.deepEqual(hit?.bucket, {
    tokens: 1_100,
    input: 200,
    output: 100,
    cached: 800,
    reasoning: 40,
    turns: 1,
  });
});

test("Claude total adds its disjoint cache fields", () => {
  const hit = extractClaudeBucket({
    timestamp: "2026-08-23T12:00:00.000Z",
    type: "assistant",
    message: {
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 50,
      },
    },
  });

  assert.deepEqual(hit?.bucket, {
    tokens: 970,
    input: 100,
    output: 20,
    cached: 850,
    reasoning: 0,
    turns: 1,
  });
});

test("opencode trusts its canonical total when breakdown fields disagree", () => {
  const bucket = extractOpencodeBucket({
    role: "assistant",
    tokens: {
      total: 1_000,
      input: 100,
      output: 100,
      reasoning: 25,
      cache: { read: 750, write: 0 },
    },
  });

  assert.deepEqual(bucket, {
    tokens: 1_000,
    input: 100,
    output: 100,
    cached: 750,
    reasoning: 25,
    turns: 1,
  });
});

test("opencode live source reads completed usage for one BB session", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-usage-opencode-"));
  const path = join(root, "opencode.db");
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path);
  try {
    db.exec(
      "create table message (" +
        "id text primary key, session_id text not null," +
        "time_created integer not null, time_updated integer not null," +
        "data text not null)",
    );
    const insert = db.prepare("insert into message values (?, ?, ?, ?, ?)");
    insert.run(
      "msg_pending",
      "ses_bb",
      1_000,
      2_000,
      JSON.stringify({
        role: "assistant",
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }),
    );
    insert.run(
      "msg_done",
      "ses_bb",
      3_000,
      4_000,
      JSON.stringify({
        role: "assistant",
        tokens: {
          total: 900,
          input: 100,
          output: 50,
          reasoning: 0,
          cache: { read: 750, write: 0 },
        },
        time: { created: 3_000, completed: 4_500 },
      }),
    );
  } finally {
    db.close();
  }

  try {
    const source = createOpencodeLiveThroughputSource({ paths: [path] });
    const samples = await source.scan({
      sessionIds: ["ses_bb"],
      sinceMs: 0,
    });
    assert.equal(samples.length, 1);
    assert.equal(samples[0].id, "msg_done");
    assert.equal(samples[0].sessionId, "ses_bb");
    assert.equal(samples[0].atMs, 4_500);
    assert.equal(samples[0].bucket.tokens, 900);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("BB usage events difference the canonical running total", () => {
  const bucket = bucketFromTotals(
    {
      totalTokens: 2_000,
      inputTokens: 1_800,
      cachedInputTokens: 1_600,
      outputTokens: 200,
      reasoningOutputTokens: 100,
    },
    {
      totalTokens: 1_000,
      inputTokens: 900,
      cachedInputTokens: 800,
      outputTokens: 100,
      reasoningOutputTokens: 50,
    },
  );

  assert.deepEqual(bucket, {
    tokens: 1_000,
    input: 100,
    output: 100,
    cached: 800,
    reasoning: 50,
    turns: 1,
  });
});

test("daily chart and provider shares use cache-inclusive totals", () => {
  const today = dayKey(Date.now());
  const snapshot = assembleTokenSnapshot({
    days: 7,
    fileCount: 2,
    changedFiles: 2,
    sources: ["codex", "claude-code"],
    daily: {
      [today]: {
        codex: {
          tokens: 1_100,
          input: 200,
          output: 100,
          cached: 800,
          reasoning: 40,
          turns: 1,
        },
        "claude-code": {
          tokens: 970,
          input: 100,
          output: 20,
          cached: 850,
          reasoning: 0,
          turns: 1,
        },
      },
    },
  });

  assert.equal(snapshot.totals.tokens, 2_070);
  assert.equal(snapshot.series.at(-1)?.total, 2_070);
  assert.deepEqual(snapshot.series.at(-1)?.byProvider, {
    codex: 1_100,
    "claude-code": 970,
  });
  assert.equal(snapshot.providers[0]?.id, "codex");
  assert.equal(snapshot.providers[0]?.percent, (1_100 / 2_070) * 100);
});

test("transcript scan uses Codex cumulative totals and Claude message ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-usage-test-"));
  const codexHome = join(root, "codex");
  const claudeHome = join(root, "claude");
  const codexSessions = join(codexHome, "sessions");
  const claudeProject = join(claudeHome, "projects", "project");
  await mkdir(codexSessions, { recursive: true });
  await mkdir(claudeProject, { recursive: true });
  const timestamp = new Date().toISOString();

  const codexRecord = (total) =>
    JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            total_tokens: total,
            input_tokens: total - 100,
            cached_input_tokens: total - 300,
            output_tokens: 100,
            reasoning_output_tokens: 40,
          },
          last_token_usage: {
            total_tokens: 1_100,
            input_tokens: 1_000,
            cached_input_tokens: 800,
            output_tokens: 100,
            reasoning_output_tokens: 40,
          },
        },
      },
    });
  await writeFile(
    join(codexSessions, "session.jsonl"),
    `${codexRecord(1_100)}\n${codexRecord(2_200)}\n`,
  );

  const claudeRecord = (output, id = "msg-shared") =>
    JSON.stringify({
      timestamp,
      type: "assistant",
      message: {
        id,
        usage: {
          input_tokens: 100,
          output_tokens: output,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 0,
        },
      },
    });
  await writeFile(
    join(claudeProject, "parent.jsonl"),
    `${claudeRecord(5)}\n${claudeRecord(20)}\n`,
  );
  await writeFile(
    join(claudeProject, "copied-subagent.jsonl"),
    `${claudeRecord(20)}\n`,
  );

  const priorCodexHome = process.env.CODEX_HOME;
  const priorClaudeHome = process.env.CLAUDE_CONFIG_DIR;
  process.env.CODEX_HOME = codexHome;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  try {
    const result = await scanTokenFiles({
      includeCursor: false,
      includeOpencode: false,
    });
    const bucket = result.daily[dayKey(Date.now())];
    assert.equal(bucket?.codex.tokens, 2_200);
    assert.equal(bucket?.codex.turns, 2);
    assert.equal(bucket?.["claude-code"].tokens, 920);
    assert.equal(bucket?.["claude-code"].turns, 1);
  } finally {
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorCodexHome;
    if (priorClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = priorClaudeHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("estimateTokens uses length/3.6 for ASCII and keeps CJK per-glyph", () => {
  assert.equal(estimateTokens("abcd"), 2);
  assert.equal(estimateTokens("你好"), 2);
});

test("seedDailyFromCache paints cursor/opencode without double-counting", () => {
  const today = dayKey(Date.now());
  const daily = {};
  const sources = [];
  const cached = new Map([
    [
      "/tmp/.cursor/acp-sessions/ses/store.db",
      {
        daily: {
          [today]: {
            tokens: 311,
            input: 300,
            output: 11,
            cached: 0,
            reasoning: 0,
            turns: 1,
          },
        },
      },
    ],
    [
      "/tmp/.local/share/opencode/opencode.db",
      {
        daily: {
          [today]: {
            tokens: 4_800,
            input: 4_000,
            output: 800,
            cached: 0,
            reasoning: 0,
            turns: 2,
          },
        },
      },
    ],
  ]);

  assert.equal(seedDailyFromCache(daily, sources, cached, "cursor"), 1);
  assert.equal(seedDailyFromCache(daily, sources, cached, "opencode"), 1);
  assert.deepEqual(sources, ["cursor", "opencode"]);
  assert.equal(daily[today]?.cursor.tokens, 311);
  assert.equal(daily[today]?.opencode.tokens, 4_800);

  assert.equal(seedDailyFromCache(daily, sources, cached, "cursor"), 0);
  assert.equal(daily[today]?.cursor.tokens, 311);
});

test("opencode store scan aggregates json_extract scalars by day", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-usage-oc-scan-"));
  const path = join(root, "opencode.db");
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path);
  const created = Date.now() - 60_000;
  try {
    db.exec(
      "create table message (" +
        "id text primary key, session_id text not null," +
        "time_created integer not null, time_updated integer not null," +
        "data text not null)",
    );
    db.prepare("insert into message values (?, ?, ?, ?, ?)").run(
      "msg_done",
      "ses",
      created,
      created + 1,
      JSON.stringify({
        role: "assistant",
        tokens: {
          total: 900,
          input: 100,
          output: 50,
          reasoning: 0,
          cache: { read: 750, write: 0 },
        },
      }),
    );
  } finally {
    db.close();
  }

  try {
    const files = scanOpencodeStores({ paths: [path] });
    assert.equal(files.length, 1);
    const bucket = files[0].daily[dayKey(created)];
    assert.equal(bucket?.tokens, 900);
    assert.equal(bucket?.cached, 750);
    assert.equal(bucket?.turns, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cursor scan skips a full reread when blob identity is unchanged", async () => {
  const home = await mkdtemp(join(tmpdir(), "provider-usage-cursor-"));
  const session = join(home, ".cursor", "acp-sessions", "ses-1");
  await mkdir(session, { recursive: true });
  const path = join(session, "store.db");
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path);
  try {
    db.exec("create table blobs (id text primary key, data blob)");
    db.prepare("insert into blobs values (?, ?)").run(
      "blob-1",
      Buffer.from(
        JSON.stringify({
          role: "user",
          content: "hello world from a cursor prompt",
          providerOptions: { cursor: { requestId: "req-1" } },
        }),
      ),
    );
    db.prepare("insert into blobs values (?, ?)").run(
      "blob-2",
      Buffer.from(
        JSON.stringify({
          role: "assistant",
          content: "a short reply",
        }),
      ),
    );
  } finally {
    db.close();
  }

  try {
    const first = scanCursorStores({ home });
    assert.equal(first.length, 1);
    assert.ok((first[0].blobCount ?? 0) >= 2);
    const tokens = Object.values(first[0].daily).reduce(
      (sum, bucket) => sum + bucket.tokens,
      0,
    );
    assert.ok(tokens > 0);

    const cache = new Map([
      [
        first[0].path,
        {
          mtimeMs: 0,
          size: 0,
          daily: first[0].daily,
          blobCount: first[0].blobCount,
          maxRowid: first[0].maxRowid,
        },
      ],
    ]);
    const second = scanCursorStores({ home, cached: cache });
    assert.equal(second.length, 1);
    assert.deepEqual(second[0].daily, first[0].daily);
    assert.equal(second[0].blobCount, first[0].blobCount);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
