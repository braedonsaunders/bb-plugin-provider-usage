import {
  PROVIDER_KEYS,
  pickProviderLimitRaw,
  type ProviderKey,
  type ProviderLimitSlice,
} from "./dashboard";

function asLimitSlice(value: unknown): ProviderLimitSlice {
  if (!value || typeof value !== "object") {
    return { status: "error", message: "No usage data returned." };
  }
  return value as ProviderLimitSlice;
}

/**
 * BB 0.41 keys usage results by provider id (`claude-code`, `acp-cursor`).
 * Older BB releases exposed the UI aliases (`claudeCode`, `cursor`). Accept
 * both contracts so one plugin release remains compatible across upgrades.
 */
export function normalizeProviderLimits(
  raw: Record<string, unknown>,
): Record<ProviderKey, ProviderLimitSlice> {
  return Object.fromEntries(
    PROVIDER_KEYS.map((key) => {
      return [key, asLimitSlice(pickProviderLimitRaw(raw, key))];
    }),
  ) as Record<ProviderKey, ProviderLimitSlice>;
}
