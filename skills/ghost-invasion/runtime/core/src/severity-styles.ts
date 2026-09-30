// ---------------------------------------------------------------------------
// Shared severity presentation for the two HTML renderers.
//
// Responsibility: define one source of truth for how a finding's severity is
// shown, so the static report (reporter.ts → summary.html) and the live
// dashboard (dashboard.ts) never drift apart and never convey severity by color
// alone. WCAG 1.4.1 ("use of color") requires a non-color channel: every level
// carries a distinct shape glyph AND the severity word, so the ranking is
// legible in grayscale or to a color-blind reader. The full five-value enum is
// covered, so a `low`/`info` finding is never left unstyled (S-047).
// ---------------------------------------------------------------------------

import type { Finding } from "./schemas/finding.js";

export type Severity = Finding["severity"];

export interface SeverityStyle {
  /** Distinct filled shape, legible without color. */
  glyph: string;
  bg: string;
  fg: string;
  border: string;
}

// Distinct shapes (square/triangle/diamond/circle/arrow) so severity reads from
// the glyph alone; color is a redundant, not sole, channel.
export const SEVERITY_STYLES: Record<Severity, SeverityStyle> = {
  critical: { glyph: "■", bg: "#ffe8e3", fg: "#9b1c0f", border: "#f3b6ad" },
  high: { glyph: "▲", bg: "#fff2d6", fg: "#7a4a00", border: "#f0d29a" },
  medium: { glyph: "◆", bg: "#e8f0ff", fg: "#1e4d9a", border: "#bcd2f5" },
  low: { glyph: "●", bg: "#eef4ee", fg: "#2f6b3a", border: "#c2dcc6" },
  info: { glyph: "▸", bg: "#eef2f6", fg: "#2d3642", border: "#d3dbe4" }
};

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

/** "■ CRITICAL" — the glyph + word that make severity a non-color channel. */
export function severityLabel(severity: Severity): string {
  return `${SEVERITY_STYLES[severity].glyph} ${severity.toUpperCase()}`;
}

/**
 * CSS rules covering every severity, keyed off the caller's selector
 * (e.g. `(s) => ".tag." + s`), so both renderers style all five levels from
 * the same table and `low`/`info` are never missing.
 */
export function severityCss(selector: (severity: Severity) => string): string {
  return SEVERITY_ORDER.map((severity) => {
    const style = SEVERITY_STYLES[severity];
    return `${selector(severity)} { background: ${style.bg}; color: ${style.fg}; border-color: ${style.border}; }`;
  }).join("\n");
}

/** severity → "glyph WORD", for injection into the dashboard's client script. */
export function severityLabelMap(): Record<Severity, string> {
  return Object.fromEntries(SEVERITY_ORDER.map((severity) => [severity, severityLabel(severity)])) as Record<Severity, string>;
}
