import type { ThemeMode } from "../../core/themes.js";

/**
 * The board's background and the text drawn on it. The person may give the board a colour of their
 * own (a palette of twelve that suit the theme's lightness, or any colour); the columns' cards keep
 * the theme's surfaces, and the colour is the backdrop only. The text drawn on the backdrop (the
 * columns' titles, counts and notes) keeps the theme's ink while it reads at 4.5:1 or more there, and
 * otherwise switches to the theme's text for a light or a dark ground, whichever reads better. The
 * contrast is WCAG 2's.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A colour as CSS writes it (`#rrggbb`, `#rgb`, `rgb()`, `rgba()`, `color(srgb …)`), or undefined. */
export function parseColour(text: string): Rgba | undefined {
  const value = text.trim().toLowerCase();
  let match = /^#([0-9a-f]{6})$/.exec(value);
  if (match) return { r: parseInt(match[1]!.slice(0, 2), 16), g: parseInt(match[1]!.slice(2, 4), 16), b: parseInt(match[1]!.slice(4, 6), 16), a: 1 };
  match = /^#([0-9a-f]{3})$/.exec(value);
  if (match) return { r: parseInt(match[1]![0]!.repeat(2), 16), g: parseInt(match[1]![1]!.repeat(2), 16), b: parseInt(match[1]![2]!.repeat(2), 16), a: 1 };
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  match = /^rgba?\(([^)]+)\)$/.exec(value);
  if (match) {
    const parts = match[1]!.split(/[\s,/]+/).filter((part) => part !== "").map((part) => (part.endsWith("%") ? (Number(part.slice(0, -1)) / 100) * 255 : Number(part)));
    if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return undefined;
    return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 };
  }
  match = /^color\(srgb ([^)]+)\)$/.exec(value);
  if (match) {
    const parts = match[1]!.split(/[\s/]+/).filter((part) => part !== "").map(Number);
    if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return undefined;
    return { r: parts[0]! * 255, g: parts[1]! * 255, b: parts[2]! * 255, a: parts[3] ?? 1 };
  }
  return undefined;
}

/** `top` drawn over `bottom` (bottom taken as opaque). */
export function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
}

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(colour: Rgba): number {
  return 0.2126 * channel(colour.r) + 0.7152 * channel(colour.g) + 0.0722 * channel(colour.b);
}

/** WCAG 2's contrast ratio, from 1 to 21. */
export function contrast(first: Rgba, second: Rgba): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

export function toHex(colour: Rgba): string {
  return `#${[colour.r, colour.g, colour.b].map((value) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, "0")).join("")}`;
}

/** What the text on the backdrop needs of the theme: its tokens, as CSS gives them. */
export interface BackdropTokens {
  ink: string;
  muted: string;
  inkOnLight: string;
  inkOnDark: string;
  mutedOnLight: string;
  mutedOnDark: string;
}

/** The least contrast of text drawn on the board's backdrop. */
export const BACKDROP_CONTRAST = 4.5;

/**
 * The ink and the muted text for the columns' titles and counts on a picked background: undefined
 * while the theme's own read at 4.5:1 there; otherwise the theme's text for a light or a dark ground,
 * whichever reads better (the muted one falls back to the ink when it would not read).
 */
export function backdropText(tokens: BackdropTokens, background: string): { ink: string; muted: string } | undefined {
  const ground = parseColour(background);
  if (!ground) return undefined;
  const behind = { ...ground, a: 1 };
  const reads = (text: string): number => {
    const colour = parseColour(text);
    return colour ? contrast(colour, behind) : 0;
  };
  const inkReads = reads(tokens.ink) >= BACKDROP_CONTRAST;
  const mutedReads = reads(tokens.muted) >= BACKDROP_CONTRAST;
  if (inkReads && mutedReads) return undefined;
  const ink = inkReads ? tokens.ink : reads(tokens.inkOnLight) >= reads(tokens.inkOnDark) ? tokens.inkOnLight : tokens.inkOnDark;
  if (mutedReads) return { ink, muted: tokens.muted };
  const mutedCandidate = reads(tokens.mutedOnLight) >= reads(tokens.mutedOnDark) ? tokens.mutedOnLight : tokens.mutedOnDark;
  return { ink, muted: reads(mutedCandidate) >= BACKDROP_CONTRAST ? mutedCandidate : ink };
}

export interface BackgroundColour {
  hex: string;
  name: string;
}

/** Twelve backgrounds for each lightness: soft tints for the light themes, deep shades for the dark ones. */
export const BACKGROUNDS: Record<ThemeMode, readonly BackgroundColour[]> = {
  light: [
    { hex: "#e7eaee", name: "mist" },
    { hex: "#ece8e2", name: "stone" },
    { hex: "#dcebf7", name: "sky" },
    { hex: "#ddf0f2", name: "ice" },
    { hex: "#dff1e6", name: "mint" },
    { hex: "#e4ecd9", name: "sage" },
    { hex: "#f6f1d2", name: "butter" },
    { hex: "#f3ead6", name: "sand" },
    { hex: "#f8e3d6", name: "peach" },
    { hex: "#f6e0e3", name: "rose" },
    { hex: "#ebe3f4", name: "lilac" },
    { hex: "#e1e5f8", name: "periwinkle" }
  ],
  dark: [
    { hex: "#1f2328", name: "graphite" },
    { hex: "#2a231d", name: "umber" },
    { hex: "#121a2e", name: "midnight" },
    { hex: "#0f2a2c", name: "deep teal" },
    { hex: "#13261b", name: "forest" },
    { hex: "#1f2616", name: "moss" },
    { hex: "#2e2414", name: "bronze" },
    { hex: "#33201a", name: "rust" },
    { hex: "#301a22", name: "wine" },
    { hex: "#261c33", name: "plum" },
    { hex: "#1a1d3a", name: "indigo" },
    { hex: "#1d2733", name: "slate" }
  ]
};
