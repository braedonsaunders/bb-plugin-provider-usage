// Live navigation-rail icon.
//
// BB 0.46 made the navigation rail icon-only, so `experimental_sidebarAccessory`
// no longer has a host surface that mounts it. What the rail still renders is
// the panel's icon *name* — and the host resolves a name registered through
// `app.experimental_icons` to plugin artwork before any built-in. So the
// panel's icon is now the live surface: the same glyph, with the number as a
// small badge that overhangs into the rail button's padding.
//
// Registered artwork is rendered by the host's shared <Icon>, outside every
// plugin slot, so SDK hooks (useRpc, useRealtime) throw there. The value is
// fetched instead by an invisible `experimental_appOverlay` — a real slot,
// mounted once per window with plugin context — and handed to the icon
// through the module-level store below. Both live in this one bundle, so they
// share the module.
//
// The badge is styled inline, against the host's theme variables. The plugin
// stylesheet is scoped under `[data-bb-plugin=<id>]`, and the rail is host DOM
// outside that scope, so a Tailwind class here would silently match nothing.
import { useSyncExternalStore, type CSSProperties } from "react";
import { experimental_Icon as HostIcon } from "@get-bb/plugin-sdk/app";

export type RailTone = "calm" | "warn" | "critical";

export interface RailReading {
  /** 0..1; rendered as a whole percent without the sign, to fit the rail. */
  fraction: number;
  tone: RailTone;
}

let current: RailReading | null = null;
const listeners = new Set<() => void>();

export function publishRailReading(next: RailReading | null): void {
  if (
    next === current ||
    (next !== null &&
      current !== null &&
      next.tone === current.tone &&
      Math.round(next.fraction * 100) === Math.round(current.fraction * 100))
  ) {
    return;
  }
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): RailReading | null {
  return current;
}

/**
 * Escalates in three steps so the rail stays quiet until it matters: a muted
 * number, then a tinted number, then a filled pill. The calm and warn pills
 * sit on the sidebar colour, which reads as a notch cut out of the glyph.
 */
const badgeTone: Record<RailTone, CSSProperties> = {
  calm: { background: "var(--sidebar)", color: "var(--muted-foreground)" },
  warn: { background: "var(--sidebar)", color: "var(--destructive)" },
  critical: { background: "var(--destructive)", color: "var(--background)" },
};

/** Overhangs the 16px glyph into the rail button's 6px padding, bottom-right. */
const badgeBase: CSSProperties = {
  position: "absolute",
  right: -7,
  bottom: -5,
  minWidth: 13,
  padding: "0 2px",
  borderRadius: 3,
  fontSize: 8.5,
  lineHeight: "10px",
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
  letterSpacing: "-0.02em",
  textAlign: "center",
  pointerEvents: "none",
};

/** Artwork for `experimental_icons.register`: the host glyph plus the live badge. */
export function railIcon(glyph: string) {
  function RailIcon({ className }: { className?: string }) {
    const reading = useSyncExternalStore(subscribe, snapshot, snapshot);
    return (
      <span className={className} style={{ position: "relative", display: "inline-flex" }}>
        <HostIcon name={glyph} className="size-full" aria-hidden />
        {reading === null ? null : (
          <span style={{ ...badgeBase, ...badgeTone[reading.tone] }}>
            {Math.min(100, Math.max(0, Math.round(reading.fraction * 100)))}
          </span>
        )}
      </span>
    );
  }
  return RailIcon;
}
