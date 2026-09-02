import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

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

const { extractMuseBucket, tokenRoots } = await import("../lib/token-scan.ts");
const { assembleDashboard } = await import("../lib/dashboard.ts");

const MUSE_RECORD = {
  schema_version: 1,
  id: "f6d176d9-d83c-4246-81b0-8f9fc4516412",
  recorded_at: 1_788_388_113_895_797,
  record_type: "event",
  payload_type: "runtime.session",
  payload: {
    kind: "run",
    run_id: "45540013-5e97-4e07-a01b-ac56c0be07cd",
    event: {
      kind: "model_completed",
      model: "muse-spark-1.3-contributor",
      duration_ms: 3_710,
      usage: {
        input_tokens: 23_893,
        output_tokens: 301,
        cached_tokens: 900,
        cache_write_tokens: 0,
        cache_read_tokens: 0,
        reasoning_tokens: 269,
      },
    },
  },
};

test("a muse model completion becomes one cache-inclusive bucket", () => {
  const hit = extractMuseBucket(MUSE_RECORD);
  assert.ok(hit);
  assert.equal(hit.atMs, 1_788_388_113_896);
  assert.deepEqual(hit.bucket, {
    tokens: 24_194,
    input: 22_993,
    output: 301,
    cached: 900,
    reasoning: 269,
    turns: 1,
  });
});

test("records that are not model completions are ignored", () => {
  assert.equal(extractMuseBucket({ payload: { kind: "run" } }), null);
  assert.equal(
    extractMuseBucket({
      recorded_at: 1,
      payload: { kind: "run", event: { kind: "model_request_configured" } },
    }),
    null,
  );
  assert.equal(extractMuseBucket(null), null);
});

test("the muse session root follows MUSE_HOME and XDG", () => {
  const rootFor = (env) =>
    tokenRoots("/home/dev", env).find((root) => root.id === "muse")?.root;
  assert.equal(rootFor({}), "/home/dev/.local/share/muse/sessions");
  assert.equal(
    rootFor({ XDG_DATA_HOME: "/data" }),
    "/data/muse/sessions",
  );
  assert.equal(rootFor({ MUSE_HOME: "/opt/muse" }), "/opt/muse/data/sessions");
});

const OK_SLICE = { status: "ok", windows: [] };

function dashboard({ museStatus, catalog }) {
  return assembleDashboard({
    limits: {
      codex: OK_SLICE,
      claudeCode: OK_SLICE,
      cursor: OK_SLICE,
      muse: { status: museStatus },
    },
    hosts: [],
    catalog,
    hostId: null,
  });
}

test("an uninstalled provider no plugin registered is not listed", () => {
  const snapshot = dashboard({ museStatus: "not_installed", catalog: [] });
  assert.deepEqual(
    snapshot.providers.map((provider) => provider.id),
    ["codex", "claude-code", "cursor"],
  );
  assert.equal(snapshot.totals.trackedProviders, 3);
});

test("an uninstalled provider whose plugin is installed still reports", () => {
  const snapshot = dashboard({
    museStatus: "not_installed",
    catalog: [{ id: "muse", displayName: "Muse Code", logoUrl: "/muse.svg" }],
  });
  const muse = snapshot.providers.find((provider) => provider.id === "muse");
  assert.equal(muse?.status, "not_installed");
  assert.equal(muse?.logoUrl, "/muse.svg");
});

test("a signed-in muse account is listed with its catalog identity", () => {
  const snapshot = assembleDashboard({
    limits: {
      codex: OK_SLICE,
      claudeCode: OK_SLICE,
      cursor: OK_SLICE,
      muse: {
        status: "ok",
        planLabel: "High usage",
        accountEmail: "dev@example.com",
        windows: [
          { label: "5-hour limit", usedPercent: 40, resetsAt: null },
        ],
      },
    },
    hosts: [],
    catalog: [{ id: "muse", displayName: "Muse Code", logoUrl: "/muse.svg" }],
    hostId: null,
  });
  const muse = snapshot.providers.find((provider) => provider.id === "muse");
  assert.equal(muse?.planLabel, "High usage");
  assert.equal(muse?.windows[0]?.remainingPercent, 60);
});
