import type { ReportJson } from "./schemas/report.js";
import type { Finding } from "./schemas/finding.js";

export type ExitCodeOnSeverity = Finding["severity"];

const severityRank: Record<ExitCodeOnSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1
};

export function parseExitCodeOnSeverity(value: string): ExitCodeOnSeverity {
  const normalized = value.trim().toLowerCase();
  if (normalized in severityRank) return normalized as ExitCodeOnSeverity;
  throw new Error(`Invalid --exit-code-on "${value}". Use critical, high, medium, low, or info.`);
}

export function confirmedFindingMeetsSeverity(finding: Finding, threshold: ExitCodeOnSeverity): boolean {
  return finding.category === "confirmed-bug" && severityRank[finding.severity] >= severityRank[threshold];
}

export function reportMeetsExitCodeThreshold(report: ReportJson, threshold: ExitCodeOnSeverity): boolean {
  // An unclean run (dry-run / circuit-broken / egress-unproven / quarantined / evidence-
  // degraded) must exit non-zero even with zero confirmed findings — CI keys off exactly
  // this surface, and a false all-clear here is the dishonest-green hole (F3, S-038, R1).
  if (!report.runStatus.clean) return true;
  return report.findings.some((finding) => confirmedFindingMeetsSeverity(finding, threshold));
}
