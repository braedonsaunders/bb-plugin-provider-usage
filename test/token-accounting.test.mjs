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
const { scanTokenFiles } = await import("../lib/token-scan.ts");
const { extractOpencodeBucket } = await import("../lib/opencode-scan.ts");
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
