import { useCallback, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
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
  type ProviderAccountUsage,
  type ProviderUsage,
  type RemainingTone,
  type UsageWindow,
} from "@/lib/dashboard";
import { ProviderLimitsSkeleton } from "@/components/usage-skeletons";

export function toneText(tone: RemainingTone): string {
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
 * Every meter on this page counts the same way: down. The ring, the bars, and
 * the number beside them all show what is LEFT, which is the way each provider
 * states its own limits — a bar that filled as you spent would say the
 * opposite of the "% left" printed next to it.
 */
export function Gauge({
  remainingPercent,
  size = 72,
  caption = "left",
  bare = false,
}: {
  remainingPercent: number;
  size?: number;
  caption?: string;
  /** A ring with no figure inside, for list rows too small to hold one. */
  bare?: boolean;
}) {
  const tone = remainingTone(remainingPercent);
  const radius = 15.5;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - remainingPercent / 100);
  const large = size >= 96;
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
          strokeWidth={bare ? 4.5 : 3.4}
        />
        <circle
          cx="18"
          cy="18"
          r={radius}
          fill="none"
          className={cn("transition-[stroke-dashoffset] duration-500", toneRing(tone))}
          strokeWidth={bare ? 4.5 : 3.4}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      {bare ? null : (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className={cn(
              "font-semibold tabular-nums leading-none tracking-tight",
              large ? "text-3xl" : "text-sm",
              toneText(tone),
            )}
          >
            {Math.round(remainingPercent)}
            {large ? <span className="text-base font-medium">%</span> : null}
          </span>
          <span
            className={cn(
              "uppercase tracking-wide text-muted-foreground",
              large ? "mt-1 text-[11px]" : "mt-0.5 text-[10px]",
            )}
          >
            {caption}
          </span>
        </div>
      )}
    </div>
  );
}

/** The window that decides an account's fate: whichever has least left. */
function tightestWindow(
  windows: UsageWindow[] | undefined,
): UsageWindow | undefined {
  if (!windows || windows.length === 0) return undefined;
  return windows.reduce((tightest, window) =>
    window.remainingPercent < tightest.remainingPercent ? window : tightest,
  );
}

function servingAccount(
  provider: ProviderUsage,
): ProviderAccountUsage | undefined {
  return (
    provider.accounts.find((account) => !account.unavailable) ??
    provider.accounts[0]
  );
}

/**
 * The window a provider's gauge should show. For a pooled provider that is the
 * account which will serve the next request: the host still reports the local
 * login's quota, which can read empty while the pool is routing elsewhere.
 */
export function heroWindow(provider: ProviderUsage): UsageWindow | undefined {
  if (!provider.pooled) return provider.windows[0];
  // The ring answers "how much is left before work stops", which for a pooled
  // provider is the tightest window of the account about to take that work.
  return tightestWindow(servingAccount(provider)?.windows);
}

/** The windows that describe a provider's next request, in reported order. */
function displayWindows(provider: ProviderUsage): UsageWindow[] {
  if (!provider.pooled) return provider.windows;
  return servingAccount(provider)?.windows ?? [];
}

/**
 * A provider is listed as active when it can take work: signed in, or routed
 * through a pool that can serve it whatever the local login says.
 */
function isActive(provider: ProviderUsage): boolean {
  return provider.status === "ok" || provider.pooled;
}

function providerSubtitle(provider: ProviderUsage): string {
  return [
    provider.planLabel,
    provider.pooled
      ? `${provider.accounts.length} accounts`
      : provider.status === "ok"
        ? null
        : statusLabel(provider.status),
  ]
    .filter(Boolean)
    .join(" · ");
}

function emptyStateText(provider: ProviderUsage): string {
  if (provider.status === "ok") {
    return "Signed in, but this provider has not reported a subscription window yet.";
  }
  if (provider.status === "unauthenticated" || provider.status === "expired") {
    return "Sign in under Settings → Providers to see remaining quota and reset times.";
  }
  if (provider.status === "not_installed") {
    return "Install this provider on the selected machine to track its limits.";
  }
  return provider.message ?? "Usage is unavailable right now.";
}

function resetText(iso: string | null): string {
  return iso
    ? `in ${formatResetRelative(iso)} · ${formatResetAbsolute(iso)}`
    : "No reset time reported";
}

function MeterBar({
  remainingPercent,
  label,
  className,
}: {
  remainingPercent: number;
  label: string;
  className?: string;
}) {
  const tone = remainingTone(remainingPercent);
  return (
    <div
      className={cn("h-1.5 overflow-hidden rounded-full", toneTrack(tone), className)}
      role="meter"
      aria-valuenow={Math.round(remainingPercent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${label} remaining`}
    >
      <div
        className={cn("h-full rounded-full transition-all duration-500", toneFill(tone))}
        style={{ width: `${remainingPercent}%` }}
      />
    </div>
  );
}

export function ProviderMark({
  name,
  logoUrl,
  size = "md",
}: {
  name: string;
  logoUrl: string | null;
  size?: "sm" | "md";
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden border border-border bg-muted/40",
        size === "sm" ? "size-8 rounded-lg" : "size-10 rounded-xl",
      )}
    >
      {logoUrl && !failed ? (
        <img
          src={logoUrl}
          alt=""
          className={cn("object-contain", size === "sm" ? "size-[18px]" : "size-6")}
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

/** One limit window as a tile: what is left, how it is trending, when it returns. */
function WindowTile({ window }: { window: UsageWindow }) {
  const tone = remainingTone(window.remainingPercent);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border/70 bg-muted/20 px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 truncate pt-0.5 text-[13px] font-medium">
          {window.label}
        </p>
        <p
          className={cn(
            "shrink-0 text-xl font-semibold leading-none tabular-nums tracking-tight",
            toneText(tone),
          )}
        >
          {Math.round(window.remainingPercent)}
          <span className="text-sm font-medium">%</span>
        </p>
      </div>
      <MeterBar remainingPercent={window.remainingPercent} label={window.label} />
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <span className="tabular-nums">{resetText(window.resetsAt)}</span>
        {window.cost ? (
          <span className="tabular-nums">
            {formatUsdCents(window.cost.usedUsdCents)} of{" "}
            {formatUsdCents(window.cost.limitUsdCents)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function WindowGrid({ windows }: { windows: UsageWindow[] }) {
  return (
    <div className="grid gap-2.5 sm:grid-cols-2">
      {windows.map((window, index) => (
        <WindowTile key={`${window.label}-${window.resetsAt ?? index}`} window={window} />
      ))}
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
        : provider.resetCredits.description,
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
    <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
      {rows.map((row) => (
        <div
          key={row.label}
          className="rounded-xl border border-dashed border-border px-3.5 py-2.5"
        >
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {row.label}
          </p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums">{row.value}</p>
          {row.hint ? (
            <p className="mt-0.5 text-[11px] text-muted-foreground">{row.hint}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

type AccountRole = "serving" | "standby" | "unavailable";

function accountRole(
  account: ProviderAccountUsage,
  servingId: string | null,
): AccountRole {
  if (account.id === servingId) return "serving";
  return account.unavailable ? "unavailable" : "standby";
}

const ROLE_LABEL: Record<AccountRole, string> = {
  serving: "Serving now",
  standby: "Standby",
  unavailable: "Unavailable",
};

/**
 * One pooled account, collapsed to the line that answers "can this account
 * take work?" and expanded to the windows behind that answer. The account
 * serving new requests opens by default, because it is the only one whose
 * numbers describe the next request.
 */
function PoolAccountRow({
  account,
  role,
  provider,
  open,
  onToggle,
}: {
  account: ProviderAccountUsage;
  role: AccountRole;
  provider: ProviderUsage;
  open: boolean;
  onToggle: () => void;
}) {
  const tightest = tightestWindow(account.windows);
  const tone = tightest ? remainingTone(tightest.remainingPercent) : null;
  const statusText = role === "unavailable" ? account.status : ROLE_LABEL[role];
  // Provider-wide extras (credits, banked resets, on-demand spend) are read
  // from the local login, so they belong to that account rather than floating
  // underneath the pool as though they covered every account in it.
  const hasProviderDetail = Boolean(
    provider.credits ?? provider.resetCredits ?? provider.spendControl,
  );
  const showsProviderDetail = account.local && hasProviderDetail;
  // Only worth saying when the signed-in account is showing extras this one
  // cannot; otherwise it is a note about nothing.
  const explainsMissingDetail = !account.local && hasProviderDetail;

  return (
    <div className="[&:not(:last-child)]:border-b border-border/60">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
      >
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            role === "serving"
              ? "bg-emerald-500"
              : role === "standby"
                ? "bg-muted-foreground/40"
                : "bg-destructive/70",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{account.label}</span>
            {account.local ? (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                this machine
              </span>
            ) : null}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {statusText}
            {tightest ? ` · ${tightest.label}` : ""}
          </span>
        </span>
        {tightest ? (
          <span
            className={cn("shrink-0 text-sm font-semibold tabular-nums", toneText(tone!))}
          >
            {formatPercent(tightest.remainingPercent)}
          </span>
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">—</span>
        )}
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div className="space-y-3 px-3 pb-3.5 pt-1">
          {account.message ? (
            <p className="text-xs text-destructive">{account.message}</p>
          ) : null}
          {account.windows.length > 0 ? (
            <WindowGrid windows={account.windows} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {account.local
                ? "Signed in on this machine, but no limit window was reported."
                : "The pool has not seen a limit window for this account yet."}
            </p>
          )}
          {showsProviderDetail ? <ProviderDetails provider={provider} /> : null}
          {explainsMissingDetail ? (
            <p className="text-xs text-muted-foreground">
              Credit balance and banked resets come from the provider CLI, which
              only reports on the account this machine is signed into. The pool
              does not publish them per account.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The pool as an overview: what it is routing across, how much of it is still
 * available, and one row per account in failover order. Detail stays folded
 * away until asked for, because the question this pane usually answers is
 * simply whether there is capacity left somewhere.
 */
function PoolAccounts({ provider }: { provider: ProviderUsage }) {
  const accounts = provider.accounts;
  const servingId = accounts.find((account) => !account.unavailable)?.id ?? null;
  const [openIds, setOpenIds] = useState<readonly string[]>(() =>
    servingId ? [servingId] : accounts.slice(0, 1).map((row) => row.id),
  );
  const availableCount = accounts.filter((account) => !account.unavailable).length;

  const toggle = useCallback((id: string) => {
    setOpenIds((current) =>
      current.includes(id) ? current.filter((row) => row !== id) : [...current, id],
    );
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">
          Pooled across {accounts.length} accounts
        </p>
        <p className="text-xs tabular-nums text-muted-foreground">
          {availableCount} of {accounts.length} available
        </p>
      </div>
      <div className="overflow-hidden rounded-xl border border-border/70">
        {accounts.map((account) => (
          <PoolAccountRow
            key={account.id}
            account={account}
            role={accountRole(account, servingId)}
            provider={provider}
            open={openIds.includes(account.id)}
            onToggle={() => toggle(account.id)}
          />
        ))}
      </div>
    </div>
  );
}

const OVERVIEW = "overview";

function ListHeading({ children }: { children: string }) {
  return (
    <p className="px-2.5 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80">
      {children}
    </p>
  );
}

function ListButton({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
        selected ? "bg-background ring-1 ring-border shadow-sm" : "hover:bg-muted/50",
      )}
    >
      {children}
    </button>
  );
}

function ProviderListItem({
  provider,
  selected,
  onSelect,
}: {
  provider: ProviderUsage;
  selected: boolean;
  onSelect: () => void;
}) {
  const hero = heroWindow(provider);
  const active = isActive(provider);
  const subtitle = providerSubtitle(provider);
  return (
    <ListButton selected={selected} onSelect={onSelect}>
      <span className={cn(!active && "opacity-60 grayscale")}>
        <ProviderMark name={provider.displayName} logoUrl={provider.logoUrl} size="sm" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-sm font-medium">
            {provider.displayName}
            {subtitle ? (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                {subtitle}
              </span>
            ) : null}
          </span>
          {hero ? (
            <span
              className={cn(
                "shrink-0 text-xs font-semibold tabular-nums",
                toneText(remainingTone(hero.remainingPercent)),
              )}
            >
              {formatPercent(hero.remainingPercent)}
            </span>
          ) : (
            <span className="shrink-0 text-xs text-muted-foreground">—</span>
          )}
        </span>
        {hero ? (
          <MeterBar
            remainingPercent={hero.remainingPercent}
            label={`${provider.displayName} ${hero.label}`}
            className="mt-1.5 h-1"
          />
        ) : (
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            {active ? "No window reported yet" : statusLabel(provider.status)}
          </span>
        )}
      </span>
    </ListButton>
  );
}

function OverviewListItem({
  data,
  selected,
  onSelect,
}: {
  data: DashboardSnapshot;
  selected: boolean;
  onSelect: () => void;
}) {
  const remaining = data.totals.cumulativeRemainingPercent;
  return (
    <ListButton selected={selected} onSelect={onSelect}>
      {remaining === null ? (
        <span className="size-8 shrink-0 rounded-full border-[3px] border-muted" />
      ) : (
        <Gauge remainingPercent={remaining} size={32} bare />
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">Overview</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {data.totals.okProviders} signed in
          {data.totals.nextResetAt
            ? ` · next reset in ${formatResetRelative(data.totals.nextResetAt)}`
            : ""}
        </span>
      </span>
      {remaining === null ? null : (
        <span
          className={cn(
            "shrink-0 text-xs font-semibold tabular-nums",
            toneText(remainingTone(remaining)),
          )}
        >
          {formatPercent(remaining)}
        </span>
      )}
    </ListButton>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string | null;
  tone?: RemainingTone;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-1 truncate text-[15px] font-semibold tabular-nums tracking-tight",
          tone ? toneText(tone) : "text-foreground",
        )}
      >
        {value}
      </dd>
      {hint ? (
        <dd className="truncate text-[11px] text-muted-foreground">{hint}</dd>
      ) : null}
    </div>
  );
}

/** One window, small: enough to compare providers at a glance. */
function MiniMeter({ window }: { window: UsageWindow }) {
  const tone = remainingTone(window.remainingPercent);
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="truncate text-muted-foreground">{window.label}</span>
        <span className={cn("shrink-0 font-semibold tabular-nums", toneText(tone))}>
          {formatPercent(window.remainingPercent)}
        </span>
      </div>
      <MeterBar
        remainingPercent={window.remainingPercent}
        label={window.label}
        className="mt-1 h-1"
      />
    </div>
  );
}

/**
 * Every provider on one screen, reduced to what answers "where can work go
 * right now": the overall figure the sidebar shows, the window closest to
 * running out, the next refill, and each provider's windows side by side.
 */
function LimitsOverview({
  data,
  onSelect,
}: {
  data: DashboardSnapshot;
  onSelect: (id: string) => void;
}) {
  const { totals } = data;
  const active = data.providers.filter(isActive);
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-7">
        {totals.cumulativeRemainingPercent === null ? null : (
          <Gauge
            remainingPercent={totals.cumulativeRemainingPercent}
            size={112}
            caption="overall"
          />
        )}
        <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-4">
          <Stat
            label="Tightest window"
            value={
              totals.tightest
                ? `${formatPercent(totals.tightest.remainingPercent)} left`
                : "—"
            }
            hint={
              totals.tightest
                ? `${totals.tightest.providerName} · ${totals.tightest.windowLabel}`
                : null
            }
            tone={
              totals.tightest
                ? remainingTone(totals.tightest.remainingPercent)
                : undefined
            }
          />
          <Stat
            label="Next reset"
            value={
              totals.nextResetAt
                ? `in ${formatResetRelative(totals.nextResetAt)}`
                : "—"
            }
            hint={
              totals.nextResetAt ? formatResetAbsolute(totals.nextResetAt) : null
            }
          />
          <Stat
            label="Providers"
            value={`${totals.okProviders} of ${totals.trackedProviders} signed in`}
            hint={`${totals.windowCount} limit windows`}
          />
          {totals.spend ? (
            <Stat
              label="On-demand spend"
              value={`${formatUsdCents(totals.spend.usedUsdCents)} of ${formatUsdCents(totals.spend.limitUsdCents)}`}
              hint={`${formatUsdCents(totals.spend.remainingUsdCents)} left`}
            />
          ) : (
            <Stat
              label="Window average"
              value={
                totals.averageRemainingPercent === null
                  ? "—"
                  : `${formatPercent(totals.averageRemainingPercent)} left`
              }
              hint="Across every reported window"
            />
          )}
        </dl>
      </div>

      {active.length > 0 ? (
        <div className="divide-y divide-border/60 rounded-xl border border-border/70">
          {active.map((provider) => {
            const windows = displayWindows(provider);
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => onSelect(provider.id)}
                className="grid w-full grid-cols-1 items-center gap-3 px-3.5 py-3 text-left transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-muted/40 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-5"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <ProviderMark
                    name={provider.displayName}
                    logoUrl={provider.logoUrl}
                    size="sm"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {provider.displayName}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {providerSubtitle(provider) || statusLabel(provider.status)}
                    </span>
                  </span>
                </span>
                {windows.length > 0 ? (
                  <span className="grid grid-cols-2 gap-x-4 gap-y-2 lg:grid-cols-3">
                    {windows.map((window, index) => (
                      <MiniMeter
                        key={`${window.label}-${window.resetsAt ?? index}`}
                        window={window}
                      />
                    ))}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    No subscription window reported yet
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No provider is signed in on this machine.
        </p>
      )}
    </div>
  );
}

function ProviderDetail({ provider }: { provider: ProviderUsage }) {
  const hero = heroWindow(provider);
  const meta = [
    provider.planLabel,
    provider.pooled ? null : provider.accountEmail,
    provider.pooled ? `Pooled · ${provider.accounts.length} accounts` : statusLabel(provider.status),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3.5">
        <ProviderMark name={provider.displayName} logoUrl={provider.logoUrl} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold tracking-tight">
            {provider.displayName}
          </h3>
          <p className="truncate text-xs text-muted-foreground">{meta}</p>
        </div>
        {hero ? (
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {provider.pooled ? "Serving account" : hero.label}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {hero.resetsAt ? `resets in ${formatResetRelative(hero.resetsAt)}` : " "}
              </p>
            </div>
            <Gauge remainingPercent={hero.remainingPercent} size={56} />
          </div>
        ) : null}
      </div>

      {provider.pooled ? (
        <PoolAccounts key={provider.id} provider={provider} />
      ) : provider.status === "ok" && provider.windows.length > 0 ? (
        <WindowGrid windows={provider.windows} />
      ) : (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {emptyStateText(provider)}
        </p>
      )}
      {provider.status === "ok" && !provider.pooled ? (
        <ProviderDetails provider={provider} />
      ) : null}
    </div>
  );
}

/**
 * A list of providers on the left and the selected one's detail on the right,
 * so the section stays one screen tall however many providers and pooled
 * accounts there are. Overview is the default: the cross-provider picture is
 * what most visits are for, and any provider is one click away from it.
 */
export function ProviderLimitsSection({
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
  const [selectedId, setSelectedId] = useState<string>(OVERVIEW);
  const providers = data?.providers ?? [];
  // A provider can drop out when the machine changes; fall back to the overview.
  const selected = providers.find((provider) => provider.id === selectedId) ?? null;
  const active = providers.filter(isActive);
  const inactive = providers.filter((provider) => !isActive(provider));

  return (
    <Card className="overflow-hidden shadow-none">
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
      <CardContent className="p-0" aria-busy={loading && !data}>
        {loading && !data ? (
          <ProviderLimitsSkeleton />
        ) : error && !data ? (
          <div className="space-y-3 border-t border-border p-5 text-sm text-muted-foreground">
            <p>{error}</p>
            <Button size="sm" variant="outline" onClick={() => void onReload()}>
              Try again
            </Button>
          </div>
        ) : data ? (
          <div className="grid border-t border-border md:grid-cols-3">
            <nav
              aria-label="Providers"
              className="space-y-0.5 border-b border-border bg-muted/15 p-2 md:border-b-0 md:border-r"
            >
              <OverviewListItem
                data={data}
                selected={selected === null}
                onSelect={() => setSelectedId(OVERVIEW)}
              />
              {active.length > 0 ? <ListHeading>Active</ListHeading> : null}
              {active.map((provider) => (
                <ProviderListItem
                  key={provider.id}
                  provider={provider}
                  selected={selected?.id === provider.id}
                  onSelect={() => setSelectedId(provider.id)}
                />
              ))}
              {inactive.length > 0 ? <ListHeading>Not signed in</ListHeading> : null}
              {inactive.map((provider) => (
                <ProviderListItem
                  key={provider.id}
                  provider={provider}
                  selected={selected?.id === provider.id}
                  onSelect={() => setSelectedId(provider.id)}
                />
              ))}
            </nav>
            <div className="min-w-0 p-5 md:col-span-2">
              {selected ? (
                <ProviderDetail provider={selected} />
              ) : (
                <LimitsOverview data={data} onSelect={setSelectedId} />
              )}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
