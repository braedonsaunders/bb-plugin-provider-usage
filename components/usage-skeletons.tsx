import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Skeleton({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

function ChartGrid({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn("relative w-full overflow-hidden", className)}>
      {[18, 42, 66].map((top) => (
        <div
          key={top}
          className="absolute inset-x-0 border-t border-border/80"
          style={{ top: `${top}%` }}
        />
      ))}
      <div className="absolute inset-x-0 bottom-7 border-t border-border/80" />
      {children}
    </div>
  );
}

function LegendPill() {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Skeleton className="size-2 rounded-full" />
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-3 w-10" />
    </span>
  );
}

/** Live throughput body: hero rate, three stats, bar chart, legend. */
export function LiveThroughputSkeleton() {
  const bars = [18, 32, 14, 46, 22, 38, 12, 28, 54, 20, 16, 34, 24, 42, 18, 30, 12, 26, 20, 36, 14, 22, 18, 10];
  return (
    <div className="space-y-4" aria-hidden>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div>
          <Skeleton className="h-10 w-28" />
          <Skeleton className="mt-2 h-3 w-40" />
        </div>
        <div className="flex flex-1 flex-wrap justify-end gap-x-8 gap-y-3">
          {["Peak", "15m total", "Working"].map((label) => (
            <div key={label} className="min-w-16">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {label}
              </p>
              <Skeleton className="mt-1 h-4 w-16" />
              <Skeleton className="mt-1.5 h-3 w-12" />
            </div>
          ))}
        </div>
      </div>

      <ChartGrid className="h-[168px]">
        <div className="absolute inset-x-12 bottom-7 top-3.5 flex items-end justify-between gap-1">
          {bars.map((height, index) => (
            <Skeleton
              key={index}
              className="w-full max-w-2 rounded-t-sm"
              style={{ height: `${height}%` }}
            />
          ))}
        </div>
      </ChartGrid>

      <div className="flex flex-wrap gap-x-5 gap-y-1.5">
        <LegendPill />
        <LegendPill />
        <LegendPill />
      </div>
    </div>
  );
}

/** Token usage body: four metric tiles, line chart, legend, footer. */
export function TokenUsageSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {["Total", "Input", "Output", "Cached"].map((label) => (
          <div
            key={label}
            className="space-y-1 rounded-lg border border-border bg-card p-4"
          >
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {label}
            </p>
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-3 w-28" />
          </div>
        ))}
      </div>

      <div className="flex w-full">
        <div className="relative h-64 w-10 shrink-0" aria-hidden>
          {[8, 50, 89].map((top) => (
            <Skeleton
              key={top}
              className="absolute right-1.5 h-2.5 w-6 -translate-y-1/2"
              style={{ top: `${top}%` }}
            />
          ))}
        </div>
        <ChartGrid className="h-64 min-w-0 flex-1">
        <svg
          viewBox="0 0 960 260"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
        >
          <path
            d="M12,168 C160,150 280,132 420,140 C560,148 700,96 948,88"
            fill="none"
            className="stroke-muted-foreground/25"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
          <path
            d="M12,188 C180,176 300,160 460,172 C620,184 780,150 948,142"
            fill="none"
            className="stroke-muted-foreground/20"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
          <path
            d="M12,206 C200,198 340,190 520,196 C700,202 820,186 948,180"
            fill="none"
            className="stroke-muted-foreground/15"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
        </svg>
      </ChartGrid>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <LegendPill />
          <LegendPill />
          <LegendPill />
          <LegendPill />
        </div>
        <Skeleton className="h-3 w-24" />
      </div>
      <Skeleton className="h-3 w-56" />
    </div>
  );
}

function ProviderLimitRowSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-5 md:flex-row md:items-start md:gap-6">
      <div className="flex min-w-0 shrink-0 items-center gap-3 md:w-60">
        <Skeleton className="size-10 rounded-xl" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-36" />
        </div>
        <Skeleton className="size-14 shrink-0 rounded-full" />
      </div>
      <div className="min-w-0 flex-1 space-y-4">
        {[0, 1].map((index) => (
          <div key={index} className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-48" />
              </div>
              <Skeleton className="h-4 w-16" />
            </div>
            <Skeleton className="h-1.5 w-full rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Provider limits list: three rows of mark, copy, gauge, and two bars. */
export function ProviderLimitsSkeleton() {
  return (
    <div className="divide-y divide-border" aria-hidden>
      <ProviderLimitRowSkeleton />
      <ProviderLimitRowSkeleton />
      <ProviderLimitRowSkeleton />
    </div>
  );
}

export function HomepageUsageSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-3" aria-hidden>
      {Array.from({ length: 3 }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 rounded-xl border border-border p-4"
        >
          <Skeleton className="size-[60px] rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
      ))}
    </div>
  );
}
