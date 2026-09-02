export const PROVIDER_KEYS = ["codex", "claudeCode", "cursor", "muse"] as const;
export type ProviderKey = (typeof PROVIDER_KEYS)[number];

export const PROVIDER_META: Record<
  ProviderKey,
  {
    id: string;
    displayName: string;
    fallbackLogoUrl: string;
    matchIds: readonly string[];
  }
> = {
  codex: {
    id: "codex",
    displayName: "Codex",
    fallbackLogoUrl: "/api/v1/system/providers/codex/logo",
    matchIds: ["codex"],
  },
  claudeCode: {
    id: "claude-code",
    displayName: "Claude Code",
    fallbackLogoUrl: "/api/v1/system/providers/claude-code/logo",
    matchIds: ["claude-code"],
  },
  cursor: {
    id: "cursor",
    displayName: "Cursor",
    fallbackLogoUrl: "/api/v1/system/providers/acp-cursor/logo",
    matchIds: ["acp-cursor", "cursor"],
  },
  muse: {
    id: "muse",
    displayName: "Muse Code",
    fallbackLogoUrl: "/api/v1/system/providers/muse/logo",
    matchIds: ["muse"],
  },
};

/** Map dashboard keys to `system.usageLimits` response keys from the host. */
export function pickProviderLimitRaw(
  limits: Record<string, unknown>,
  key: ProviderKey,
): unknown {
  for (const id of PROVIDER_META[key].matchIds) {
    if (id in limits) return limits[id];
  }
  return limits[key];
}

export type UsageStatus =
  | "ok"
  | "not_installed"
  | "unauthenticated"
  | "expired"
  | "error";

export type RemainingTone = "ok" | "warn" | "critical";

export interface UsageWindow {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  cost: {
    usedUsdCents: number;
    limitUsdCents: number;
    remainingUsdCents: number;
  } | null;
}

export interface ProviderUsage {
  key: ProviderKey;
  id: string;
  displayName: string;
  logoUrl: string | null;
  status: UsageStatus;
  accountEmail: string | null;
  planLabel: string | null;
  message: string | null;
  windows: UsageWindow[];
  credits: ProviderCreditBalance | null;
  spendControl: ProviderSpendControl | null;
  resetCredits: ProviderResetCredits | null;
}

export interface ProviderCreditBalance {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface ProviderSpendControl {
  used: string;
  limit: string;
  remainingPercent: number;
  resetsAt: string | null;
  reached: boolean | null;
}

export interface ProviderResetCredits {
  availableCount: number;
  nextExpiresAt: string | null;
  title: string | null;
  description: string | null;
}

export interface UsageHost {
  id: string;
  name: string;
  status: "connected" | "disconnected";
}

export interface UsageTotals {
  trackedProviders: number;
  okProviders: number;
  windowCount: number;
  averageUsedPercent: number | null;
  averageRemainingPercent: number | null;
  /** Mean remaining of each signed-in provider's primary window. */
  cumulativeRemainingPercent: number | null;
  tightest: {
    providerId: string;
    providerName: string;
    windowLabel: string;
    usedPercent: number;
    remainingPercent: number;
  } | null;
  nextResetAt: string | null;
  spend: {
    usedUsdCents: number;
    limitUsdCents: number;
    remainingUsdCents: number;
  } | null;
}

export interface DashboardSnapshot {
  fetchedAt: string;
  hostId: string | null;
  hosts: UsageHost[];
  providers: ProviderUsage[];
  totals: UsageTotals;
}

export interface ProviderLimitSlice {
  status: UsageStatus;
  accountEmail?: string | null;
  planLabel?: string | null;
  message?: string;
  windows?: Array<{
    label: string;
    usedPercent: number;
    resetsAt: string | null;
    cost?: { usedUsdCents: number; limitUsdCents: number };
  }>;
}

export interface ProviderSupplement {
  windows: NonNullable<ProviderLimitSlice["windows"]>;
  credits: ProviderCreditBalance | null;
  spendControl: ProviderSpendControl | null;
  resetCredits: ProviderResetCredits | null;
}

export interface ProviderCatalogEntry {
  id: string;
  displayName: string;
  logoUrl: string | null;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function remainingTone(remainingPercent: number): RemainingTone {
  if (remainingPercent <= 10) return "critical";
  if (remainingPercent <= 30) return "warn";
  return "ok";
}

export function formatUsdCents(cents: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export function formatPercent(value: number): string {
  return `${Math.round(clampPercent(value))}%`;
}

export function formatCreditAmount(value: string | null): string {
  if (value === null) return "Unknown";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
  }).format(numeric);
}

export function formatResetAbsolute(iso: string | null): string {
  if (!iso) return "Reset time unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Reset time unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatResetRelative(iso: string | null, nowMs = Date.now()): string {
  if (!iso) return "unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  const delta = date.getTime() - nowMs;
  if (delta <= 0) return "now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rem = minutes % 60;
    return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`;
}

export function formatFetchedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "just now";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

export function statusLabel(status: UsageStatus): string {
  switch (status) {
    case "ok":
      return "Signed in";
    case "unauthenticated":
      return "Not signed in";
    case "expired":
      return "Session expired";
    case "not_installed":
      return "Not installed";
    case "error":
      return "Unavailable";
  }
}

function normalizeWindows(
  windows: ProviderLimitSlice["windows"] | undefined,
): UsageWindow[] {
  return (windows ?? []).map((window) => {
    const usedPercent = clampPercent(window.usedPercent);
    const cost = window.cost
      ? {
          usedUsdCents: window.cost.usedUsdCents,
          limitUsdCents: window.cost.limitUsdCents,
          remainingUsdCents: Math.max(
            0,
            window.cost.limitUsdCents - window.cost.usedUsdCents,
          ),
        }
      : null;
    return {
      label: window.label,
      usedPercent,
      remainingPercent: clampPercent(100 - usedPercent),
      resetsAt: window.resetsAt,
      cost,
    };
  });
}

function mergeWindows(
  reported: ProviderLimitSlice["windows"] | undefined,
  supplemental: ProviderLimitSlice["windows"] | undefined,
): UsageWindow[] {
  const merged = normalizeWindows(reported);
  for (const next of normalizeWindows(supplemental)) {
    const duplicate = merged.some(
      (current) =>
        current.label.toLocaleLowerCase() === next.label.toLocaleLowerCase() &&
        current.resetsAt === next.resetsAt &&
        Math.abs(current.usedPercent - next.usedPercent) < 0.01,
    );
    if (!duplicate) merged.push(next);
  }
  return merged;
}

function resolveCatalog(
  key: ProviderKey,
  catalog: readonly ProviderCatalogEntry[],
): Pick<ProviderUsage, "displayName" | "logoUrl"> {
  const meta = PROVIDER_META[key];
  const match = catalog.find((provider) => meta.matchIds.includes(provider.id));
  return {
    displayName: match?.displayName ?? meta.displayName,
    logoUrl: match?.logoUrl ?? meta.fallbackLogoUrl,
  };
}

function isRegistered(
  key: ProviderKey,
  catalog: readonly ProviderCatalogEntry[],
): boolean {
  return catalog.some((provider) =>
    PROVIDER_META[key].matchIds.includes(provider.id),
  );
}

function heroWindow(provider: ProviderUsage): UsageWindow | undefined {
  return provider.windows.find((window) => !window.cost) ?? provider.windows[0];
}

function buildTotals(providers: ProviderUsage[]): UsageTotals {
  const ok = providers.filter((provider) => provider.status === "ok");
  const windows = ok.flatMap((provider) =>
    provider.windows.map((window) => ({ provider, window })),
  );
  const heroRemaining = ok
    .map((provider) => heroWindow(provider)?.remainingPercent)
    .filter((value): value is number => value !== undefined);
  const cumulativeRemainingPercent =
    heroRemaining.length === 0
      ? null
      : clampPercent(
          heroRemaining.reduce((sum, value) => sum + value, 0) /
            heroRemaining.length,
        );

  const averageUsedPercent =
    windows.length === 0
      ? null
      : windows.reduce((sum, row) => sum + row.window.usedPercent, 0) /
        windows.length;

  const tightest = windows.reduce<UsageTotals["tightest"]>((best, row) => {
    if (!best || row.window.usedPercent > best.usedPercent) {
      return {
        providerId: row.provider.id,
        providerName: row.provider.displayName,
        windowLabel: row.window.label,
        usedPercent: row.window.usedPercent,
        remainingPercent: row.window.remainingPercent,
      };
    }
    return best;
  }, null);

  const nextResetAt = windows
    .map((row) => row.window.resetsAt)
    .filter((value): value is string => Boolean(value))
    .sort()[0] ?? null;

  const spendWindows = windows.filter((row) => row.window.cost);
  const spend =
    spendWindows.length === 0
      ? null
      : spendWindows.reduce(
          (acc, row) => {
            const cost = row.window.cost!;
            return {
              usedUsdCents: acc.usedUsdCents + cost.usedUsdCents,
              limitUsdCents: acc.limitUsdCents + cost.limitUsdCents,
              remainingUsdCents: acc.remainingUsdCents + cost.remainingUsdCents,
            };
          },
          { usedUsdCents: 0, limitUsdCents: 0, remainingUsdCents: 0 },
        );

  return {
    trackedProviders: providers.length,
    okProviders: ok.length,
    windowCount: windows.length,
    averageUsedPercent,
    averageRemainingPercent:
      averageUsedPercent === null ? null : clampPercent(100 - averageUsedPercent),
    cumulativeRemainingPercent,
    tightest,
    nextResetAt,
    spend,
  };
}

export function assembleDashboard(input: {
  limits: Record<ProviderKey, ProviderLimitSlice>;
  supplements?: Partial<Record<ProviderKey, ProviderSupplement>>;
  hosts: UsageHost[];
  catalog: readonly ProviderCatalogEntry[];
  hostId: string | null;
  fetchedAt?: string;
}): DashboardSnapshot {
  /**
   * A provider that is neither installed nor registered on this host is not a
   * meter the user is missing — it is an agent they never added. Plugin-supplied
   * providers only reach the catalog once their plugin is installed, so this is
   * what keeps the dashboard to the agents that actually exist here. A provider
   * bb ships stays listed even when uninstalled, because "not installed" is real
   * news for those.
   */
  const trackedKeys = PROVIDER_KEYS.filter((key) => {
    const slice = input.limits[key];
    if (slice === undefined) return false;
    return slice.status !== "not_installed" || isRegistered(key, input.catalog);
  });

  const providers = trackedKeys.map((key) => {
    const slice = input.limits[key]!;
    const supplement = input.supplements?.[key];
    const identity = resolveCatalog(key, input.catalog);
    return {
      key,
      id: PROVIDER_META[key].id,
      displayName: identity.displayName,
      logoUrl: identity.logoUrl,
      status: slice.status,
      accountEmail: slice.accountEmail ?? null,
      planLabel: slice.planLabel ?? null,
      message: slice.message ?? null,
      windows:
        slice.status === "ok"
          ? mergeWindows(slice.windows, supplement?.windows)
          : [],
      credits: slice.status === "ok" ? (supplement?.credits ?? null) : null,
      spendControl:
        slice.status === "ok" ? (supplement?.spendControl ?? null) : null,
      resetCredits:
        slice.status === "ok" ? (supplement?.resetCredits ?? null) : null,
    } satisfies ProviderUsage;
  });

  return {
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
    hostId: input.hostId,
    hosts: input.hosts,
    providers,
    totals: buildTotals(providers),
  };
}

export function formatDashboardText(snapshot: DashboardSnapshot): string {
  const host =
    snapshot.hosts.find((row) => row.id === snapshot.hostId)?.name ??
    snapshot.hosts[0]?.name ??
    "Primary machine";

  const lines = [
    `Usage · ${host}`,
    `Fetched ${snapshot.fetchedAt}`,
    "",
    "Totals",
    `  Providers        ${snapshot.totals.okProviders} signed in / ${snapshot.totals.trackedProviders} tracked`,
    // Everything below counts down, matching the panel's meters and the way
    // each provider states its own limits.
    `  Remaining        ${
      snapshot.totals.cumulativeRemainingPercent === null
        ? "—"
        : `${formatPercent(snapshot.totals.cumulativeRemainingPercent)} left`
    }`,
    `  Window average   ${
      snapshot.totals.averageRemainingPercent === null
        ? "—"
        : `${formatPercent(snapshot.totals.averageRemainingPercent)} left`
    }`,
    `  Tightest         ${
      snapshot.totals.tightest
        ? `${snapshot.totals.tightest.providerName} ${snapshot.totals.tightest.windowLabel} · ${formatPercent(snapshot.totals.tightest.remainingPercent)} left`
        : "—"
    }`,
    `  Next reset       ${
      snapshot.totals.nextResetAt
        ? `${formatResetAbsolute(snapshot.totals.nextResetAt)} (in ${formatResetRelative(snapshot.totals.nextResetAt)})`
        : "—"
    }`,
  ];

  for (const provider of snapshot.providers) {
    lines.push("");
    const bits = [provider.displayName];
    if (provider.planLabel) bits.push(provider.planLabel);
    if (provider.accountEmail) bits.push(provider.accountEmail);
    lines.push(bits.join(" · "));
    if (provider.status !== "ok") {
      lines.push(`  ${statusLabel(provider.status)}${provider.message ? ` — ${provider.message}` : ""}`);
      continue;
    }
    if (provider.windows.length === 0) {
      lines.push("  No subscription windows reported");
      continue;
    }
    for (const window of provider.windows) {
      const cost = window.cost
        ? ` · ${formatUsdCents(window.cost.usedUsdCents)} / ${formatUsdCents(window.cost.limitUsdCents)}`
        : "";
      const reset = window.resetsAt
        ? ` · resets ${formatResetAbsolute(window.resetsAt)} (in ${formatResetRelative(window.resetsAt)})`
        : "";
      lines.push(
        `  ${window.label.padEnd(18)} ${formatPercent(window.remainingPercent)} left · ${formatPercent(window.usedPercent)} used${cost}${reset}`,
      );
    }
    if (provider.credits) {
      const value = provider.credits.unlimited
        ? "Unlimited"
        : provider.credits.hasCredits
          ? `${formatCreditAmount(provider.credits.balance)} credits`
          : "No credits";
      lines.push(`  ${"Credit balance".padEnd(18)} ${value}`);
    }
    if (provider.resetCredits) {
      const count = provider.resetCredits.availableCount;
      const expiry = provider.resetCredits.nextExpiresAt
        ? ` · next expires ${formatResetAbsolute(provider.resetCredits.nextExpiresAt)} (in ${formatResetRelative(provider.resetCredits.nextExpiresAt)})`
        : "";
      lines.push(
        `  ${"Banked resets".padEnd(18)} ${count} available${expiry}`,
      );
    }
    if (provider.spendControl) {
      const reset = provider.spendControl.resetsAt
        ? ` · resets ${formatResetAbsolute(provider.spendControl.resetsAt)} (in ${formatResetRelative(provider.spendControl.resetsAt)})`
        : "";
      lines.push(
        `  ${"On-demand period".padEnd(18)} ${provider.spendControl.used} of ${provider.spendControl.limit} used${reset}`,
      );
    }
  }

  if (snapshot.totals.spend) {
    lines.push("");
    lines.push(
      `On-demand ${formatUsdCents(snapshot.totals.spend.usedUsdCents)} of ${formatUsdCents(snapshot.totals.spend.limitUsdCents)}`,
    );
  }

  return `${lines.join("\n")}\n`;
}
