/**
 * The categorical palette both charts draw from.
 *
 * BB's theme deliberately ships no chart ramp — `--primary` is a near-neutral
 * ink and `--chart-N` is undefined — so a chart that borrows UI tokens ends up
 * with a series that has no hue at all. These slots are therefore fixed values
 * rather than theme tokens, with a separate step chosen for each mode instead
 * of one set flipped automatically.
 *
 * Both sets are validated, not eyeballed: every slot sits inside its mode's
 * OKLCH lightness band, clears the chroma floor, holds >= 3:1 against the mode
 * surface, and keeps adjacent slots >= 8 OKLab ΔE apart under simulated
 * protanopia and deuteranopia. The order below IS the stacking order, so the
 * pairs that sit next to each other in a chart are the pairs that were checked.
 * Orange and blue lead because Claude Code and Codex are the two series most
 * often on screen together, and that pair separates most strongly of all.
 *
 * Slots are assigned per provider, never per rank, so a provider keeps its
 * colour when the series around it come and go.
 */

export interface SeriesSlot {
  /** CSS custom property name, without the `var()` wrapper. */
  token: string;
  light: string;
  dark: string;
}

export const SERIES_SLOTS: readonly SeriesSlot[] = [
  { token: "--pu-series-1", light: "#d66919", dark: "#db7431" },
  { token: "--pu-series-2", light: "#1570d1", dark: "#3280dd" },
  { token: "--pu-series-3", light: "#006d23", dark: "#00762c" },
  { token: "--pu-series-4", light: "#b10074", dark: "#bf2a82" },
  { token: "--pu-series-5", light: "#00a0a1", dark: "#00a7a7" },
  { token: "--pu-series-6", light: "#7d40c8", dark: "#8e57d8" },
];

/** Slot for the folded tail. Grey is the de-emphasis channel, never a hue. */
export const OTHER_SERIES_ID = "other";
const OTHER_TOKEN = "--pu-series-other";

/** Past this, further providers fold into "Other" rather than inventing hues. */
export const MAX_SERIES = SERIES_SLOTS.length;

/**
 * Providers with a seat of their own. Everything else is hashed into the
 * overflow slots, so an agent this plugin has never heard of still draws in a
 * stable colour instead of sharing one grey with every other unknown.
 */
const PROVIDER_SLOTS: Record<string, number> = {
  "claude-code": 0,
  codex: 1,
  cursor: 2,
  opencode: 3,
  muse: 4,
};

const OVERFLOW_SLOTS = [5];

export function providerSlotIndex(providerId: string): number {
  const seated = PROVIDER_SLOTS[providerId];
  if (seated !== undefined) return seated;
  let hash = 0;
  for (let index = 0; index < providerId.length; index += 1) {
    hash = (hash * 31 + providerId.charCodeAt(index)) >>> 0;
  }
  return OVERFLOW_SLOTS[hash % OVERFLOW_SLOTS.length]!;
}

/** The `var(...)` reference to paint a provider's marks with. */
export function providerColor(providerId: string): string {
  if (providerId === OTHER_SERIES_ID) return `var(${OTHER_TOKEN})`;
  return `var(${SERIES_SLOTS[providerSlotIndex(providerId)]!.token})`;
}

/**
 * The palette as a stylesheet. BB marks dark mode with a `.dark` class on the
 * document root and treats bare `:root` as light — the same convention its own
 * stylesheet uses — so mirroring it here keeps the series in step with the
 * theme without watching the DOM for class changes.
 */
export const SERIES_STYLESHEET = [
  ":root{",
  ...SERIES_SLOTS.map((slot) => `${slot.token}:${slot.light};`),
  `${OTHER_TOKEN}:#6b6b6b;`,
  "}",
  ".dark{",
  ...SERIES_SLOTS.map((slot) => `${slot.token}:${slot.dark};`),
  `${OTHER_TOKEN}:#9a9a9a;`,
  "}",
].join("");
