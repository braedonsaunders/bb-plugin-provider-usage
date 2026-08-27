import { useCallback, useEffect, useMemo, useState, type PointerEvent } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { HugeiconsIcon } from "@hugeicons/react";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  formatCreditAmount,
  formatFetchedAt,
  formatPercent,
  formatResetAbsolute,
  formatResetRelative,
  formatUsdCents,
  remainingTone,
  statusLabel,
  type DashboardSnapshot,
  type ProviderUsage,
  type RemainingTone,
  type UsageWindow,
} from "./lib/dashboard";
import {
  TOKEN_WINDOWS,
  formatTokenCount,
  type TokenSnapshot,
  type TokenWindowDays,
} from "./lib/tokens";
import { SERIES_STYLESHEET, providerColor } from "./lib/series-palette";
import { LiveThroughputSection } from "./components/live-throughput";
import {
  HomepageUsageSkeleton,
  ProviderLimitsSkeleton,
  Skeleton,
  TokenUsageSkeleton,
} from "./components/usage-skeletons";

const REFRESH_MS = 60_000;
/** Homepage chips and the sidebar % don't need a live Anthropic poll. */
const BACKGROUND_REFRESH_MS = 5 * 60_000;

function toneText(tone: RemainingTone): string {
  if (tone === "critical") return "text-destructive";
  if (tone === "warn") return "text-primary";
  return "text-success";
}

function toneFill(tone: RemainingTone): string {
  if (tone === "critical") return "bg-destructive";
  if (tone === "warn") return "bg-primary";
  return "bg-success";
}

/**
 * The meter's unfilled track is a light step of the fill's own colour, so the
 * whole bar carries the state rather than only the part that is left.
 */
function toneTrack(tone: RemainingTone): string {
  if (tone === "critical") return "bg-destructive/15";
  if (tone === "warn") return "bg-primary/15";
  return "bg-success/15";
}

function toneRing(tone: RemainingTone): string {
  if (tone === "critical") return "stroke-destructive";
  if (tone === "warn") return "stroke-primary";
  return "stroke-success";
}

/**
 * Both charts read the same seat-per-provider palette, so a provider is the
 * same colour in the live section and in the daily one. See
 * `lib/series-palette.ts` for how the slots were chosen and checked.
 */
const providerSwatch = providerColor;

function useDashboard(
  hostId: string | null,
  options?: { pollMs?: number },
) {
  const rpc = useRpc<typeof rpcContract>();
  const pollMs = options?.pollMs ?? REFRESH_MS;
  const [data, setData] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (mode: "initial" | "refresh" | "force" = "refresh") => {
      if (mode === "initial") setLoading(true);
      else setRefreshing(true);
      try {
        const next = await rpc.call("getDashboard", {
          hostId,
          force: mode === "force",
        });
        setData(next);
        setError(null);
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : "Could not load usage.";
        setError(message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [hostId, rpc],
  );

  useEffect(() => {
    void load("initial");
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load("refresh");
    }, pollMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load("refresh");
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, pollMs]);

  return { data, error, loading, refreshing, reload: () => load("force") };
}

function useTokens(days: TokenWindowDays) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<TokenSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (force = false) => {
      try {
        const next = await rpc.call("getTokens", { days, force });
        setData(next);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not load tokens.");
      } finally {
        setLoading(false);
      }
    },
    [days, rpc],
  );

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useRealtime("tokens", () => {
    void load();
  });

  return { data, error, loading, reload: () => load(true) };
}

function TokenChart({ snapshot }: { snapshot: TokenSnapshot }) {
  const seriesIds = snapshot.providers.map((provider) => provider.id);
  const [hover, setHover] = useState<number | null>(null);
  const width = 960;
  const height = 260;
  const pad = { l: 12, r: 12, t: 8, b: 28 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  // Lines are overlaid, not stacked — scale to the tallest series, not the
  // daily total, and leave ~10% of the plot above that peak.
  const peak = Math.max(
    1,
    ...snapshot.series.flatMap((point) =>
      seriesIds.map((id) => point.byProvider[id] ?? 0),
    ),
  );
  const max = peak / 0.9;
  const last = snapshot.series.length - 1;
  const active = hover == null ? null : snapshot.series[hover];

  const xAt = (index: number) =>
    pad.l + (last <= 0 ? innerW / 2 : (index / last) * innerW);
  const yAt = (value: number) => pad.t + (1 - value / max) * innerH;

  const linePath = (id: string) =>
    snapshot.series
      .map((point, index) => {
        const command = index === 0 ? "M" : "L";
        return `${command}${xAt(index).toFixed(2)},${yAt(point.byProvider[id] ?? 0).toFixed(2)}`;
      })
      .join(" ");

  const areaPath = (id: string) => {
    if (snapshot.series.length === 0) return "";
    const top = linePath(id);
    return `${top} L${xAt(last).toFixed(2)},${(pad.t + innerH).toFixed(2)} L${xAt(0).toFixed(2)},${(pad.t + innerH).toFixed(2)} Z`;
  };

  const move = (event: PointerEvent<SVGSVGElement>) => {
    const svg = event.currentTarget;
    const ctm = svg.getScreenCTM();
    let x = 0;
    if (ctm) {
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      x = point.matrixTransform(ctm.inverse()).x;
    } else {
      const rect = svg.getBoundingClientRect();
      x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * width;
    }
    const ratio = last <= 0 ? 0 : (x - pad.l) / Math.max(innerW, 1);
    setHover(Math.max(0, Math.min(last, Math.round(ratio * last))));
  };

  return (
    <div className="space-y-3">
      <div className="relative w-full">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="h-64 w-full"
          role="img"
          aria-label="Token usage by provider"
          onPointerMove={move}
          onPointerLeave={() => setHover(null)}
        >
          {[0.25, 0.5, 0.75, 1].map((tick) => (
            <line
              key={tick}
              x1={pad.l}
              x2={width - pad.r}
              y1={yAt(max * tick)}
              y2={yAt(max * tick)}
              className="stroke-border"
              strokeWidth="1"
            />
          ))}
          {seriesIds.map((id) => (
            <path
              key={`${id}-fill`}
              d={areaPath(id)}
              fill={providerSwatch(id)}
              fillOpacity="0.1"
              stroke="none"
            />
          ))}
          {seriesIds.map((id) => (
            <path
              key={id}
              d={linePath(id)}
              fill="none"
              stroke={providerSwatch(id)}
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {active && hover != null ? (
            <>
              <line
                x1={xAt(hover)}
                x2={xAt(hover)}
                y1={pad.t}
                y2={pad.t + innerH}
                className="stroke-foreground/30"
                strokeWidth="1"
                strokeDasharray="3 4"
              />
              {seriesIds.map((id) => {
                const value = active.byProvider[id] ?? 0;
                return (
                  <circle
                    key={`${id}-dot`}
                    cx={xAt(hover)}
                    cy={yAt(value)}
                    r="4"
                    fill={providerSwatch(id)}
                    className="stroke-background"
                    strokeWidth="2"
                  />
                );
              })}
            </>
          ) : null}
          <text
            x={pad.l}
            y={height - 6}
            className="fill-muted-foreground text-[11px]"
          >
            {snapshot.series[0]?.label}
          </text>
          <text
            x={width - pad.r}
            y={height - 6}
            textAnchor="end"
            className="fill-muted-foreground text-[11px]"
          >
            {snapshot.series.at(-1)?.label}
          </text>
        </svg>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {snapshot.providers.map((provider) => (
            <span key={provider.id} className="inline-flex items-center gap-1.5">
              <span
                className="size-2 rounded-full"
                style={{ background: providerSwatch(provider.id) }}
              />
              <span className="text-muted-foreground">{provider.displayName}</span>
              <span className="tabular-nums text-foreground">
                {formatTokenCount(
                  active
                    ? (active.byProvider[provider.id] ?? 0)
                    : provider.tokens,
                )}
              </span>
            </span>
          ))}
        </div>
        <span className="tabular-nums text-muted-foreground">
          {active
            ? `${active.label} · ${formatTokenCount(active.total)}`
            : `${snapshot.days}d · ${formatTokenCount(snapshot.totals.tokens)}`}
        </span>
      </div>
    </div>
  );
}

function TokenUsageSection() {
  const [days, setDays] = useState<TokenWindowDays>(30);
  const { data, error, loading, reload } = useTokens(days);

  return (
    <Card className="shadow-none">
      <style>{SERIES_STYLESHEET}</style>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 p-5 pb-3">
        <div>
          <CardTitle className="text-base">Token usage</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Tracked token volume, including cached input, across sessions on this machine
          </p>
        </div>
        <div className="flex rounded-md border border-border p-0.5">
          {TOKEN_WINDOWS.map((window) => (
            <button
              key={window}
              type="button"
              className={cn(
                "rounded-sm px-2 py-1 text-xs font-medium",
                days === window
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setDays(window)}
            >
              {window}d
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-5 pt-0" aria-busy={loading && !data}>
        {loading && !data ? (
          <TokenUsageSkeleton />
        ) : error && !data ? (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>{error}</p>
            <Button size="sm" variant="outline" onClick={() => void reload()}>
              Scan again
            </Button>
          </div>
        ) : data ? (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Metric
                label="Total"
                value={formatTokenCount(data.totals.tokens)}
                hint={`${data.totals.turns.toLocaleString()} turns · cache included`}
              />
              <Metric
                label="Input"
                value={formatTokenCount(data.totals.input)}
                hint="Uncached prompt tokens"
              />
              <Metric
                label="Output"
                value={formatTokenCount(data.totals.output)}
                hint="Completion tokens"
              />
              <Metric
                label="Cached"
                value={formatTokenCount(data.totals.cached)}
                hint="Cache reads and writes"
              />
            </div>
            {data.totals.tokens === 0 ? (
              <p className="text-sm text-muted-foreground">
                No transcript token events in the last {data.days} days.
              </p>
            ) : (
              <TokenChart snapshot={data} />
            )}
            <p className="text-xs text-muted-foreground">
              {data.fileCount} session files
              {data.changedFiles > 0 ? ` · ${data.changedFiles} updated` : ""}
              {data.sources.length > 0 ? ` · ${data.sources.join(", ")}` : ""}
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Gauge({
  remainingPercent,
  size = 72,
}: {
  remainingPercent: number;
  size?: number;
}) {
  const tone = remainingTone(remainingPercent);
  const radius = 15.5;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - remainingPercent / 100);
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg viewBox="0 0 36 36" className="size-full -rotate-90">
        <circle
          cx="18"
          cy="18"
          r={radius}
          fill="none"
          className="stroke-muted"
          strokeWidth="3.4"
        />
        <circle
          cx="18"
          cy="18"
          r={radius}
          fill="none"
          className={cn("transition-[stroke-dashoffset] duration-500", toneRing(tone))}
          strokeWidth="3.4"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn("text-sm font-semibold tabular-nums leading-none", toneText(tone))}>
          {Math.round(remainingPercent)}
        </span>
        <span className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          left
        </span>
      </div>
    </div>
  );
}

/**
 * Every meter on this page counts the same way: down. The ring, this bar, and
 * the number beside it all show what is LEFT, which is the way each provider
 * states its own limits — a bar that filled as you spent would say the
 * opposite of the "% left" printed next to it.
 */
function UsageBar({ window }: { window: UsageWindow }) {
  const tone = remainingTone(window.remainingPercent);
  const detail = [
    window.cost
      ? `${formatUsdCents(window.cost.usedUsdCents)} of ${formatUsdCents(window.cost.limitUsdCents)} used`
      : null,
    window.resetsAt
      ? `Resets ${formatResetAbsolute(window.resetsAt)} · in ${formatResetRelative(window.resetsAt)}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{window.label}</p>
          <p className="text-xs text-muted-foreground">
            {detail || "No reset time reported"}
          </p>
        </div>
        <p
          className={cn(
            "shrink-0 text-sm font-semibold tabular-nums",
            toneText(tone),
          )}
        >
          {formatPercent(window.remainingPercent)} left
        </p>
      </div>
      <div
        className={cn("h-1.5 overflow-hidden rounded-full", toneTrack(tone))}
        role="meter"
        aria-valuenow={Math.round(window.remainingPercent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${window.label} remaining`}
      >
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            toneFill(tone),
          )}
          style={{ width: `${window.remainingPercent}%` }}
        />
      </div>
    </div>
  );
}

function ProviderDetails({ provider }: { provider: ProviderUsage }) {
  const rows: Array<{ label: string; value: string; hint: string | null }> = [];
  if (provider.credits) {
    rows.push({
      label: "Credit balance",
      value: provider.credits.unlimited
        ? "Unlimited"
        : provider.credits.hasCredits
          ? `${formatCreditAmount(provider.credits.balance)} credits`
          : "No credits",
      hint: "Available after included plan usage",
    });
  }
  if (provider.resetCredits) {
    const count = provider.resetCredits.availableCount;
    rows.push({
      label: "Banked resets",
      value: `${count} available`,
      hint: provider.resetCredits.nextExpiresAt
        ? `${provider.resetCredits.title ?? "Next reset"} expires ${formatResetAbsolute(provider.resetCredits.nextExpiresAt)} · in ${formatResetRelative(provider.resetCredits.nextExpiresAt)}`
        : null,
    });
  }
  if (provider.spendControl) {
    rows.push({
      label: "On-demand period",
      value: `${provider.spendControl.used} of ${provider.spendControl.limit} used`,
      hint: provider.spendControl.reached
        ? "Spend control reached"
        : provider.spendControl.resetsAt
          ? `Resets ${formatResetAbsolute(provider.spendControl.resetsAt)} · in ${formatResetRelative(provider.spendControl.resetsAt)}`
          : `${formatPercent(provider.spendControl.remainingPercent)} left`,
    });
  }
  if (rows.length === 0) return null;

  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {rows.map((row) => (
        <div
          key={row.label}
          className="rounded-lg border border-border bg-muted/20 px-3 py-2.5"
        >
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {row.label}
          </p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums">
            {row.value}
          </p>
          {row.hint ? (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {row.hint}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ProviderMark({
  name,
  logoUrl,
}: {
  name: string;
  logoUrl: string | null;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex size-10 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted/40">
      {logoUrl && !failed ? (
        <img
          src={logoUrl}
          alt=""
          className="size-6 object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="text-sm font-semibold text-muted-foreground">
          {name.slice(0, 1)}
        </span>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: RemainingTone;
}) {
  return (
    <Card className="shadow-none">
      <CardContent className="space-y-1 p-4">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p
          className={cn(
            "text-xl font-semibold tabular-nums tracking-tight",
            tone ? toneText(tone) : "text-foreground",
          )}
        >
          {value}
        </p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function ProviderLimitsSection({
  data,
  error,
  loading,
  refreshing,
  onReload,
}: {
  data: DashboardSnapshot | null;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  onReload: () => void;
}) {
  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 p-5 pb-4">
        <div>
          <CardTitle className="text-base">Provider limits</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            What is left of each plan window, and when it comes back
          </p>
        </div>
        <button
          type="button"
          title={
            refreshing
              ? "Refreshing…"
              : data
                ? `Updated ${formatFetchedAt(data.fetchedAt)}`
                : "Refresh"
          }
          className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => void onReload()}
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            className={cn("size-3.5", refreshing && "animate-spin")}
          />
          Refresh
        </button>
      </CardHeader>
      <CardContent className="divide-y divide-border p-0" aria-busy={loading && !data}>
        {loading && !data ? (
          <ProviderLimitsSkeleton />
        ) : error && !data ? (
          <div className="space-y-3 p-5 text-sm text-muted-foreground">
            <p>{error}</p>
            <Button size="sm" variant="outline" onClick={() => void onReload()}>
              Try again
            </Button>
          </div>
        ) : data ? (
          data.providers.map((provider) => {
            const hero = provider.windows[0];
            return (
              <div
                key={provider.id}
                className="flex flex-col gap-4 p-5 md:flex-row md:items-start md:gap-6"
              >
                <div className="flex min-w-0 shrink-0 items-center gap-3 md:w-60">
                  <ProviderMark
                    name={provider.displayName}
                    logoUrl={provider.logoUrl}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {provider.displayName}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[
                        provider.planLabel,
                        provider.accountEmail,
                        statusLabel(provider.status),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  {hero ? (
                    <Gauge remainingPercent={hero.remainingPercent} size={56} />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1 space-y-4">
                  {provider.status === "ok" && provider.windows.length > 0 ? (
                    provider.windows.map((window, index) => (
                      <UsageBar
                        key={`${window.label}-${window.resetsAt ?? index}`}
                        window={window}
                      />
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {provider.status === "ok"
                        ? "Signed in, but this provider did not report a subscription window."
                        : provider.status === "unauthenticated" ||
                            provider.status === "expired"
                          ? "Sign in under Settings → Providers to see remaining quota and reset times."
                          : provider.status === "not_installed"
                            ? "Install this provider on the selected machine to track its limits."
                            : provider.message ?? "Usage is unavailable right now."}
                    </p>
                  )}
                  {provider.status === "ok" ? (
                    <ProviderDetails provider={provider} />
                  ) : null}
                </div>
              </div>
            );
          })
        ) : null}
      </CardContent>
    </Card>
  );
}

function DashboardBody({
  hostId,
  onHosts,
}: {
  hostId: string | null;
  onHosts?: (hosts: DashboardSnapshot["hosts"]) => void;
}) {
  const { data, error, loading, refreshing, reload } = useDashboard(hostId);

  useEffect(() => {
    if (data) onHosts?.(data.hosts);
  }, [data, onHosts]);

  return (
    <div className="space-y-5">
      {error && data ? (
        <p className="text-xs text-destructive">Refresh failed: {error}</p>
      ) : null}

      <LiveThroughputSection />
      <TokenUsageSection />
      <ProviderLimitsSection
        data={data}
        error={error}
        loading={loading}
        refreshing={refreshing}
        onReload={reload}
      />
    </div>
  );
}

function DashboardPage() {
  const [hostId, setHostId] = useState<string | null>(null);
  const [hosts, setHosts] = useState<DashboardSnapshot["hosts"]>([]);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto w-full max-w-6xl space-y-5 p-4 md:p-5">
        {hosts.length > 1 ? (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Machine</span>
            <select
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
              value={hostId ?? ""}
              onChange={(event) => setHostId(event.target.value || null)}
            >
              <option value="">Primary</option>
              {hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.name}
                  {host.status === "disconnected" ? " (offline)" : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <DashboardBody hostId={hostId} onHosts={setHosts} />
      </div>
    </div>
  );
}

function HomepageUsage() {
  const { data, loading } = useDashboard(null, { pollMs: BACKGROUND_REFRESH_MS });
  const cards = useMemo(() => data?.providers ?? [], [data]);

  if (loading && !data) {
    return <HomepageUsageSkeleton />;
  }
  if (!data) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {cards.map((provider) => {
        const hero = provider.windows[0];
        return (
          <Card key={provider.id} className="shadow-none">
            <CardContent className="flex items-center gap-3 p-4">
              {hero ? (
                <Gauge remainingPercent={hero.remainingPercent} size={60} />
              ) : (
                <ProviderMark name={provider.displayName} logoUrl={provider.logoUrl} />
              )}
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{provider.displayName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {hero
                    ? `${hero.label} · ${formatPercent(hero.remainingPercent)} left`
                    : statusLabel(provider.status)}
                </p>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function SidebarAccessory() {
  const { data } = useDashboard(null, { pollMs: BACKGROUND_REFRESH_MS });
  const remaining = data?.totals.cumulativeRemainingPercent;
  if (remaining === null || remaining === undefined) {
    return <Skeleton className="inline-block h-3 w-8 align-middle" />;
  }
  return (
    <span
      className={cn(
        "text-xs font-medium tabular-nums",
        toneText(remainingTone(remaining)),
      )}
    >
      {formatPercent(remaining)}
    </span>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "usage",
    title: "Usage",
    icon: "ChartColumn",
    path: "usage",
    component: DashboardPage,
    experimental_sidebarAccessory: SidebarAccessory,
  });
  app.slots.homepageSection({
    id: "usage-overview",
    title: "Provider usage",
    component: HomepageUsage,
  });
});
