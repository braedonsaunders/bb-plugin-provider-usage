import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { SERIES_STYLESHEET, providerColor } from "@/lib/series-palette";
import { formatTokenCount } from "@/lib/tokens";
import { formatRate, type ThroughputSnapshot } from "@/lib/throughput";
import {
  LiveThroughputSkeleton,
  Skeleton,
} from "@/components/usage-skeletons";

/** The chart advances on its own clock, so it refetches even while quiet. */
const POLL_MS = 2_000;
const CHART_HEIGHT = 168;
const PAD = { left: 48, right: 10, top: 14, bottom: 22 };
/** Surface gap between stacked segments, and the bar's rounded data-end. */
const SEGMENT_GAP = 2;
const CAP_RADIUS = 3;

function useThroughput() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<ThroughputSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inflight = useRef(false);

  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const next = await rpc.call("getThroughput", null);
      setData(next as ThroughputSnapshot);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not read throughput.",
      );
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  // The signal says "something changed"; the poll keeps the time axis moving
  // when nothing has.
  useRealtime("throughput", () => {
    void load();
  });

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  return { data, error, loading };
}

/**
 * The chart is drawn at real pixel size rather than stretched from a fixed
 * viewBox: a non-uniform scale would distort the rounded bar caps and thin the
 * gridlines unevenly. Only the width is observed and the height is fixed, so
 * measuring can never resize the element it measures.
 */
function useMeasuredWidth<T extends HTMLElement>() {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);

  // A callback ref, not an effect: the chart container only exists once the
  // first snapshot has arrived, so an effect keyed on mount would run while
  // there was nothing to observe and never attach.
  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    const next = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0;
      setWidth((current) =>
        Math.abs(current - measured) < 0.5 ? current : measured,
      );
    });
    next.observe(node);
    observer.current = next;
    setWidth(node.clientWidth);
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);

  return [ref, width] as const;
}

/** Axis max so the tallest value sits ~10% below the top of the plot. */
function axisMaxForPeak(peak: number): number {
  return peak <= 0 ? 1 : peak / 0.9;
}

function formatClock(atMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(atMs));
}

function formatAgo(atMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

function roundedTopBar(
  x: number,
  top: number,
  bottom: number,
  width: number,
): string {
  const radius = Math.max(0, Math.min(CAP_RADIUS, width / 2, bottom - top));
  return [
    `M${x},${bottom}`,
    `L${x},${top + radius}`,
    `Q${x},${top} ${x + radius},${top}`,
    `L${x + width - radius},${top}`,
    `Q${x + width},${top} ${x + width},${top + radius}`,
    `L${x + width},${bottom}`,
    "Z",
  ].join(" ");
}

interface SeriesMeta {
  id: string;
  displayName: string;
}

function ThroughputChart({
  snapshot,
  series,
  width,
}: {
  snapshot: ThroughputSnapshot;
  series: SeriesMeta[];
  width: number;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const innerW = Math.max(1, width - PAD.left - PAD.right);
  const innerH = CHART_HEIGHT - PAD.top - PAD.bottom;
  const bins = snapshot.series;
  const slot = innerW / Math.max(1, bins.length);
  const barWidth = Math.max(2, Math.min(12, slot - 2));
  const axisMax = axisMaxForPeak(Math.max(...bins.map((bin) => bin.total), 0));
  const yAt = (value: number) => PAD.top + innerH * (1 - value / axisMax);
  const slotX = (index: number) => PAD.left + slot * index;

  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left - PAD.left;
    const index = Math.floor(x / slot);
    setHover(index < 0 || index >= bins.length ? null : index);
  };

  const active = hover === null ? null : bins[hover];
  const activeRows =
    active === null
      ? []
      : series
          .map((row) => ({ ...row, value: active.byProvider[row.id] ?? 0 }))
          .filter((row) => row.value > 0);

  const ticks = [0, 0.5, 1];
  const labelIndices = [
    0,
    Math.floor(bins.length / 3),
    Math.floor((bins.length * 2) / 3),
    bins.length - 1,
  ];

  return (
    <div className="relative">
      <svg
        width={width}
        height={CHART_HEIGHT}
        className="block touch-none select-none"
        role="img"
        aria-label={`Token throughput over the last ${Math.round(snapshot.windowMs / 60_000)} minutes, currently ${formatRate(snapshot.tokensPerMinute)}`}
        onPointerMove={move}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={PAD.left + innerW}
              y1={yAt(axisMax * tick)}
              y2={yAt(axisMax * tick)}
              className="stroke-border"
              strokeWidth="1"
              shapeRendering="crispEdges"
            />
            <text
              x={PAD.left - 8}
              y={yAt(axisMax * tick) + 3}
              textAnchor="end"
              className="fill-muted-foreground text-[10px] tabular-nums"
            >
              {formatTokenCount(axisMax * tick)}
            </text>
          </g>
        ))}

        {hover !== null ? (
          <rect
            x={slotX(hover)}
            y={PAD.top}
            width={slot}
            height={innerH}
            className="fill-foreground/[0.06]"
          />
        ) : null}

        {bins.map((bin, index) => {
          if (bin.total <= 0) return null;
          const x = slotX(index) + (slot - barWidth) / 2;
          const stack = series
            .map((row) => ({ id: row.id, value: bin.byProvider[row.id] ?? 0 }))
            .filter((row) => row.value > 0);
          let cumulative = 0;
          return (
            <g key={bin.atMs}>
              {stack.map((segment, segmentIndex) => {
                const bottom = yAt(cumulative);
                cumulative += segment.value;
                const rawTop = yAt(cumulative);
                const isTop = segmentIndex === stack.length - 1;
                // The gap belongs between touching fills, so it is taken off
                // the top of every segment that has another one above it.
                const top =
                  isTop || bottom - rawTop <= SEGMENT_GAP * 2
                    ? rawTop
                    : rawTop + SEGMENT_GAP;
                const color = providerColor(segment.id);
                return isTop ? (
                  <path
                    key={segment.id}
                    d={roundedTopBar(x, top, bottom, barWidth)}
                    fill={color}
                  />
                ) : (
                  <rect
                    key={segment.id}
                    x={x}
                    y={top}
                    width={barWidth}
                    height={Math.max(0.5, bottom - top)}
                    fill={color}
                  />
                );
              })}
            </g>
          );
        })}

        {labelIndices.map((index, position) => {
          const bin = bins[index];
          if (!bin) return null;
          const isLast = position === labelIndices.length - 1;
          return (
            <text
              key={`${bin.atMs}-label`}
              x={isLast ? PAD.left + innerW : slotX(index) + slot / 2}
              y={CHART_HEIGHT - 6}
              textAnchor={position === 0 ? "start" : isLast ? "end" : "middle"}
              className="fill-muted-foreground text-[10px]"
            >
              {isLast
                ? "now"
                : `${Math.max(1, Math.round((snapshot.nowMs - bin.atMs) / 60_000))}m ago`}
            </text>
          );
        })}
      </svg>

      {active ? (
        <div
          className="pointer-events-none absolute z-10 min-w-36 -translate-x-1/2 rounded-md border border-border bg-popover p-2 shadow-md"
          style={{
            left: Math.min(
              Math.max(slotX(hover!) + slot / 2, PAD.left + 70),
              PAD.left + innerW - 70,
            ),
            top: 4,
          }}
        >
          <p className="text-[10px] text-muted-foreground">
            {formatClock(active.atMs)} · {formatAgo(active.atMs, snapshot.nowMs)}
          </p>
          {activeRows.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">No tokens</p>
          ) : (
            <div className="mt-1 space-y-0.5">
              {activeRows.map((row) => (
                <p
                  key={row.id}
                  className="flex items-center justify-between gap-3 text-xs"
                >
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span
                      className="h-0.5 w-3 rounded-full"
                      style={{ background: providerColor(row.id) }}
                    />
                    {row.displayName}
                  </span>
                  <span className="font-medium tabular-nums text-foreground">
                    {formatTokenCount(row.value)}
                  </span>
                </p>
              ))}
              {activeRows.length > 1 ? (
                <p className="flex items-center justify-between gap-3 border-t border-border pt-0.5 text-xs">
                  <span className="text-muted-foreground">Total</span>
                  <span className="font-medium tabular-nums text-foreground">
                    {formatTokenCount(active.total)}
                  </span>
                </p>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function StatCell({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
        {value}
      </p>
      {hint ? (
        <p className="truncate text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function LiveThroughputSection() {
  const { data, error, loading } = useThroughput();
  const [chartRef, width] = useMeasuredWidth<HTMLDivElement>();

  const series = useMemo<SeriesMeta[]>(
    () =>
      (data?.providers ?? []).map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
      })),
    [data],
  );

  const windowMinutes = data ? Math.round(data.windowMs / 60_000) : 15;

  return (
    <Card className="shadow-none">
      <style>{SERIES_STYLESHEET}</style>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 p-5 pb-3">
        <div>
          <CardTitle className="text-base">Live throughput</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Tokens BB has driven in the last {windowMinutes} minutes, as each
            turn reports them
          </p>
        </div>
        {data ? (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
              data.live
                ? "border-success/30 text-success"
                : "border-border text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                data.live ? "animate-pulse bg-success" : "bg-muted-foreground",
              )}
            />
            {data.live ? "Live" : "Quiet"}
          </span>
        ) : (
          <Skeleton className="h-5 w-14 rounded-full" />
        )}
      </CardHeader>

      <CardContent className="space-y-4 p-5 pt-0" aria-busy={loading && !data}>
        {loading && !data ? (
          <LiveThroughputSkeleton />
        ) : error && !data ? (
          <p className="text-sm text-muted-foreground">{error}</p>
        ) : data ? (
          <>
            <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
              <div>
                {/* Tabular figures here on purpose: the value rewrites every
                    couple of seconds, and proportional digits make it twitch. */}
                <p className="text-4xl font-semibold tabular-nums leading-none tracking-tight text-foreground">
                  {formatTokenCount(Math.round(data.tokensPerMinute))}
                </p>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  tokens per minute · last{" "}
                  {Math.round(data.rateWindowMs / 1000)}s
                </p>
              </div>
              <div className="flex flex-1 flex-wrap justify-end gap-x-8 gap-y-3">
                <StatCell
                  label="Peak"
                  value={formatRate(data.peakTokensPerMinute)}
                  hint={
                    data.peakAtMs
                      ? formatAgo(data.peakAtMs, data.nowMs)
                      : `Last ${windowMinutes}m`
                  }
                />
                <StatCell
                  label={`${windowMinutes}m total`}
                  value={formatTokenCount(data.windowTotals.tokens)}
                  hint={`${data.windowTotals.turns} turn${data.windowTotals.turns === 1 ? "" : "s"}`}
                />
                <StatCell
                  label="Working"
                  value={`${data.activeThreads}`}
                  hint={`of ${data.trackedThreads} thread${data.trackedThreads === 1 ? "" : "s"}`}
                />
              </div>
            </div>

            <div ref={chartRef} className="w-full">
              {width > 0 ? (
                <ThroughputChart
                  snapshot={data}
                  series={series}
                  width={width}
                />
              ) : (
                <div style={{ height: CHART_HEIGHT }} />
              )}
            </div>

            {data.providers.length > 0 ? (
              <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
                {data.providers.map((provider) => (
                  <span
                    key={provider.id}
                    className="inline-flex items-center gap-1.5"
                  >
                    <span
                      className="size-2 rounded-full"
                      style={{ background: providerColor(provider.id) }}
                    />
                    <span className="text-muted-foreground">
                      {provider.displayName}
                    </span>
                    <span className="tabular-nums text-foreground">
                      {formatTokenCount(provider.tokens)}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {Math.round(provider.sharePercent)}%
                    </span>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No tokens reported in the last {windowMinutes} minutes. This
                section counts work BB drives, so an agent run outside BB does
                not appear here.
              </p>
            )}

            {data.threads.length > 0 ? (
              <table className="w-full text-xs">
                <caption className="sr-only">
                  Threads reporting tokens in the last {windowMinutes} minutes
                </caption>
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="pb-1 font-medium">Thread</th>
                    <th className="pb-1 text-right font-medium">Tokens</th>
                    <th className="pb-1 text-right font-medium">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {data.threads.slice(0, 5).map((thread) => (
                    <tr key={thread.threadId} className="border-t border-border">
                      <td className="max-w-0 py-1.5 pr-3">
                        <span className="flex items-center gap-2">
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{
                              background: providerColor(thread.providerId),
                            }}
                          />
                          <span className="truncate text-foreground">
                            {thread.title}
                          </span>
                          {thread.lastAtMs > data.nowMs - 90_000 ? (
                            <span className="shrink-0 text-[10px] text-success">
                              working
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-foreground">
                        {formatTokenCount(thread.tokens)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                        {formatRate(thread.tokensPerMinute)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}

            {error ? (
              <p className="text-xs text-destructive">Refresh failed: {error}</p>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
