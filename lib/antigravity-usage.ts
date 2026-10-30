import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProviderLimitSlice } from "./dashboard";

const execFileAsync = promisify(execFile);
type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** agy /usage is a read-only command: it refreshes auth but spends no tokens. */
export function normalizeAntigravityUsage(value: unknown): ProviderLimitSlice {
  const result = record(value);
  const command = record(result.command);
  const data = record(command.data);
  if (result.status !== "SUCCESS" || command.name !== "usage" || !Array.isArray(data.groups)) {
    return { status: "error", message: "Antigravity returned no structured usage report." };
  }
  const windows: NonNullable<ProviderLimitSlice["windows"]> = [];
  for (const rawGroup of data.groups) {
    const group = record(rawGroup);
    if (!Array.isArray(group.buckets)) continue;
    for (const rawBucket of group.buckets) {
      const bucket = record(rawBucket);
      const fraction = bucket.remaining_fraction;
      if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      const duration = bucket.window === "5h" ? "5-hour limit" : bucket.window === "weekly" ? "Weekly limit" : text(bucket.name) ?? "Quota";
      const reset = text(bucket.reset_time);
      const window = {
        label: `${text(group.name) ?? "Antigravity"} · ${duration}`,
        usedPercent: (1 - fraction) * 100,
        resetsAt: reset && Number.isFinite(Date.parse(reset)) ? new Date(reset).toISOString() : null,
      };
      if (!windows.some((prior) => prior.label === window.label && prior.resetsAt === window.resetsAt)) windows.push(window);
    }
  }
  // Lead with the short Gemini window, which governs the next coding session.
  windows.sort((a, b) => Number(!/Gemini.*5-hour/i.test(a.label)) - Number(!/Gemini.*5-hour/i.test(b.label)));
  return {
    status: "ok", accountEmail: null, planLabel: "Antigravity", windows,
    ...(windows.length ? {} : { message: "Google returned no quota windows. Remaining usage is unknown." }),
  };
}

export async function readAntigravityUsage(options: {
  run?: () => Promise<string>;
} = {}): Promise<ProviderLimitSlice> {
  try {
    const output = options.run ? await options.run() : (await execFileAsync(
      existsSync(join(homedir(), ".local/bin/agy")) ? join(homedir(), ".local/bin/agy") : "agy",
      ["-p", "/usage", "--output-format", "json"],
      { cwd: tmpdir(), timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, NO_COLOR: "1" } },
    )).stdout;
    return normalizeAntigravityUsage(JSON.parse(output));
  } catch (error) {
    // Never return subprocess output: an unauthenticated CLI can print OAuth URLs.
    const code = (error as NodeJS.ErrnoException).code;
    return { status: code === "ENOENT" ? "not_installed" : "error",
      message: code === "ENOENT" ? "Install Antigravity CLI (agy) on this machine."
        : "Could not read Antigravity usage. Open agy to sign in, then refresh." };
  }
}
