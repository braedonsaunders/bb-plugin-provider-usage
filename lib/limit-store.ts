import type { ProviderKey, ProviderLimitSlice, ProviderSupplement } from "./dashboard";
import { hasRateLimitedProvider, isRateLimitedSlice, overlayLastGoodLimits, rememberGoodLimits, shouldReuseCachedLimits } from "./limits-cache";
import { normalizeProviderLimits } from "./provider-limits";

type LastGood = Partial<Record<ProviderKey, ProviderLimitSlice>>;
export interface LimitsSnapshot {
  limits: Record<ProviderKey, ProviderLimitSlice>;
  claudeSupplement: ProviderSupplement | null;
}
interface CachedFetch extends LimitsSnapshot {
  at: number;
  rateLimitedAt: number | null;
}

/** Cache, last-good data and in-flight work are isolated by machine. */
export function createLimitsStore(deps: {
  read: (key: string) => unknown;
  write: (key: string, value: unknown) => void;
  fetchLimits: (hostId: string | null) => Promise<Record<string, unknown>>;
  fetchClaude: () => Promise<ProviderSupplement | null>;
  now?: () => number;
  onRateLimit?: () => void;
}) {
  const now = deps.now ?? Date.now;
  const states = new Map<string, {
    lastGood: LastGood;
    lastFetch: CachedFetch | null;
    inflight: Promise<LimitsSnapshot> | null;
  }>();

  return {
    async get(hostId: string | null, force = false): Promise<LimitsSnapshot> {
      const key = `machine-v2:${hostId ?? "primary"}`;
      let state = states.get(key);
      if (!state) {
        state = {
          lastGood: (deps.read(`${key}:good`) as LastGood | null) ?? {},
          lastFetch: (deps.read(`${key}:fetch`) as CachedFetch | null) ?? null,
          inflight: null,
        };
        states.set(key, state);
      }
      // Even forced refreshes join an existing read of the same machine.
      if (state.inflight) return state.inflight;
      if (state.lastFetch && shouldReuseCachedLimits({
        nowMs: now(), fetchedAtMs: state.lastFetch.at,
        rateLimitedAtMs: state.lastFetch.rateLimitedAt, force,
      })) return state.lastFetch;

      const run = (async () => {
        const raw = await deps.fetchLimits(hostId);
        const fresh = normalizeProviderLimits(raw);
        const limits = overlayLastGoodLimits(fresh, state.lastGood);
        const claude = hostId === null && fresh.claudeCode.status === "ok"
          ? await deps.fetchClaude() : null;
        const priorEmail = state.lastFetch?.limits.claudeCode.accountEmail;
        const currentEmail = fresh.claudeCode.accountEmail;
        // A successful empty supplement clears spent/removed grants. Cached
        // extras survive only a usage 429 for the same known local identity.
        const reuseExtras = hostId === null && isRateLimitedSlice(fresh.claudeCode)
          && Boolean(currentEmail) && currentEmail === priorEmail;
        const claudeSupplement = claude ?? (reuseExtras ? state.lastFetch?.claudeSupplement ?? null : null);
        state.lastGood = rememberGoodLimits(limits, state.lastGood);
        state.lastFetch = {
          at: now(), limits, claudeSupplement,
          rateLimitedAt: hasRateLimitedProvider(fresh) ? now() : null,
        };
        deps.write(`${key}:good`, state.lastGood);
        deps.write(`${key}:fetch`, state.lastFetch);
        if (hasRateLimitedProvider(fresh)) deps.onRateLimit?.();
        return state.lastFetch;
      })();
      state.inflight = run;
      try { return await run; }
      finally { if (state.inflight === run) state.inflight = null; }
    },
  };
}
