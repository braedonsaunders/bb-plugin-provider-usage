import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

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

const { normalizeProviderLimits } = await import(
  "../lib/provider-limits.ts"
);

const healthy = (planLabel) => ({
  status: "ok",
  accountEmail: null,
  planLabel,
  windows: [],
});

test("normalizes BB 0.41 provider-id usage keys", () => {
  const normalized = normalizeProviderLimits({
    codex: healthy("Pro"),
    "claude-code": healthy("Max (20x)"),
    "acp-cursor": healthy("Ultra"),
  });

  assert.equal(normalized.codex.planLabel, "Pro");
  assert.equal(normalized.claudeCode.planLabel, "Max (20x)");
  assert.equal(normalized.cursor.planLabel, "Ultra");
});

test("keeps compatibility with legacy usage aliases", () => {
  const normalized = normalizeProviderLimits({
    codex: healthy("Pro"),
    claudeCode: healthy("Max (20x)"),
    cursor: healthy("Ultra"),
  });

  assert.equal(normalized.claudeCode.status, "ok");
  assert.equal(normalized.cursor.status, "ok");
});

test("prefers current provider ids and reports genuinely missing data", () => {
  const normalized = normalizeProviderLimits({
    codex: healthy("Pro"),
    "claude-code": healthy("Current"),
    claudeCode: healthy("Legacy"),
  });

  assert.equal(normalized.claudeCode.planLabel, "Current");
  assert.deepEqual(normalized.cursor, {
    status: "error",
    message: "No usage data returned.",
  });
});
