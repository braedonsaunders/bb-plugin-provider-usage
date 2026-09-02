import {
  PROVIDER_KEYS,
  type ProviderKey,
  type ProviderLimitSlice,
} from "./dashboard";

export const LIMITS_TTL_MS = 5 * 60_000;
export const RATE_LIMIT_BACKOFF_MS = 15 * 60_000;

export function isRateLimitedSlice(
  slice: ProviderLimitSlice | undefined,
): boolean {
  return (
    slice?.status === "error" && /rate limited/i.test(slice.message ?? "")
  );
}

export function hasRateLimitedProvider(
  limits: Record<ProviderKey, ProviderLimitSlice>,
): boolean {
  return PROVIDER_KEYS.some((key) => isRateLimitedSlice(limits[key]));
}

/**
 * Anthropic's OAuth usage endpoint 429s if BB asks too often. Keep the last
 * successful Claude (or any provider) windows instead of blanking the meter.
 */
export function overlayLastGoodLimits(
  fresh: Record<ProviderKey, ProviderLimitSlice>,
  lastGood: Partial<Record<ProviderKey, ProviderLimitSlice>> | undefined,
): Record<ProviderKey, ProviderLimitSlice> {
  if (!lastGood) return fresh;
  const next = { ...fresh };
  for (const key of PROVIDER_KEYS) {
    const current = next[key];
    const prior = lastGood[key];
    if (!isRateLimitedSlice(current) || prior?.status !== "ok") continue;
    next[key] = {
      ...prior,
      planLabel: current.planLabel ?? prior.planLabel,
      accountEmail: current.accountEmail ?? prior.accountEmail,
    };
  }
  return next;
}

export function rememberGoodLimits(
  limits: Record<ProviderKey, ProviderLimitSlice>,
  prior: Partial<Record<ProviderKey, ProviderLimitSlice>> = {},
): Partial<Record<ProviderKey, ProviderLimitSlice>> {
  const next = { ...prior };
  for (const key of PROVIDER_KEYS) {
    const slice = limits[key];
    if (slice?.status === "ok") next[key] = slice;
  }
  return next;
}

export function shouldReuseCachedLimits(args: {
  nowMs: number;
  fetchedAtMs: number;
  rateLimitedAtMs: number | null;
  force?: boolean;
}): boolean {
  if (args.force) return false;
  if (args.nowMs - args.fetchedAtMs < LIMITS_TTL_MS) return true;
  return (
    args.rateLimitedAtMs != null &&
    args.nowMs - args.rateLimitedAtMs < RATE_LIMIT_BACKOFF_MS
  );
}
