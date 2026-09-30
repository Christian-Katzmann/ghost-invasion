export type CostPhaseName = "plan" | "scout" | "classify" | "browser" | "api" | "reproduction" | "report";

export interface CostAssumptions {
  version: string;
  currency: "USD";
  llmInputUsdPer1kTokens: number;
  llmOutputUsdPer1kTokens: number;
  localBrowserSessionUsd: number;
  localApiRequestUsd: number;
  localReproductionAttemptUsd: number;
  localReportRenderUsd: number;
}

export interface CostPhase {
  name: CostPhaseName;
  unit: string;
  plannedUnits: number;
  actualUnits: number;
  unitUsd: number;
  estimatedUsd: number;
  actualUsd: number;
  metered: boolean;
  skipped: boolean;
  note: string;
}

export interface CostReport {
  modelVersion: string;
  currency: "USD";
  budgetUsd: number | null;
  estimatedUsd: number;
  actualUsd: number;
  variancePct: number | null;
  withinBudget: boolean;
  degraded: boolean;
  degradations: string[];
  phases: CostPhase[];
  assumptions: CostAssumptions;
}

export interface RunCostShape {
  mode: string;
  browserSessions: number;
  apiRequests: number;
  reproductionAttempts: number;
  reportRenders?: number;
  classifierInputTokens?: number;
  classifierOutputTokens?: number;
}

export interface BudgetDecision {
  shape: RunCostShape;
  cost: CostReport;
  apiRequestBudget?: number;
  reproductionBudget?: number;
}

export const DEFAULT_COST_ASSUMPTIONS: CostAssumptions = {
  version: "2026-05-31",
  currency: "USD",
  llmInputUsdPer1kTokens: 0.005,
  llmOutputUsdPer1kTokens: 0.015,
  localBrowserSessionUsd: 0,
  localApiRequestUsd: 0,
  localReproductionAttemptUsd: 0,
  localReportRenderUsd: 0
};

export function normalizeBudgetUsd(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("--budget-usd must be a non-negative number.");
  }
  return roundUsd(value);
}

export function planRunCost(input: {
  shape: RunCostShape;
  budgetUsd?: number;
  assumptions?: CostAssumptions;
}): BudgetDecision {
  const assumptions = input.assumptions ?? DEFAULT_COST_ASSUMPTIONS;
  const budgetUsd = normalizeBudgetUsd(input.budgetUsd);
  let shape = normalizeShape(input.shape);
  const degradations: string[] = [];

  if (budgetUsd === 0) {
    degradations.push("llm-phases-skipped:replay-committed-plan");
  }

  shape = fitShapeWithinBudget(shape, budgetUsd, assumptions, degradations);
  const cost = estimateRunCost({ shape, budgetUsd, assumptions, degradations });
  return {
    shape,
    cost,
    apiRequestBudget: shape.apiRequests,
    reproductionBudget: shape.reproductionAttempts
  };
}

export function estimateRunCost(input: {
  shape: RunCostShape;
  budgetUsd?: number;
  assumptions?: CostAssumptions;
  degradations?: string[];
}): CostReport {
  const assumptions = input.assumptions ?? DEFAULT_COST_ASSUMPTIONS;
  const shape = normalizeShape(input.shape);
  const budgetUsd = input.budgetUsd === undefined ? null : normalizeBudgetUsd(input.budgetUsd) ?? null;
  const phases = phasesForShape(shape, assumptions, false);
  const estimatedUsd = sumUsd(phases.map((phase) => phase.estimatedUsd));
  return {
    modelVersion: assumptions.version,
    currency: assumptions.currency,
    budgetUsd,
    estimatedUsd,
    actualUsd: 0,
    variancePct: null,
    withinBudget: budgetUsd === null ? true : estimatedUsd <= budgetUsd,
    degraded: Boolean(input.degradations?.length),
    degradations: input.degradations ?? [],
    phases,
    assumptions
  };
}

export function finalizeRunCost(input: {
  estimate: CostReport;
  actual: RunCostShape;
  degradations?: string[];
}): CostReport {
  const actual = normalizeShape(input.actual);
  const phases = phasesForShape(actual, input.estimate.assumptions, true);
  const estimatedByName = new Map(input.estimate.phases.map((phase) => [phase.name, phase]));
  const merged = phases.map((actualPhase) => {
    const estimate = estimatedByName.get(actualPhase.name);
    return {
      ...actualPhase,
      plannedUnits: estimate?.plannedUnits ?? actualPhase.plannedUnits,
      estimatedUsd: estimate?.estimatedUsd ?? actualPhase.estimatedUsd
    };
  });
  const actualUsd = sumUsd(merged.map((phase) => phase.actualUsd));
  const estimatedUsd = input.estimate.estimatedUsd;
  const variancePct = estimatedUsd === 0 ? (actualUsd === 0 ? 0 : null) : roundPercent(((actualUsd - estimatedUsd) / estimatedUsd) * 100);
  const budgetUsd = input.estimate.budgetUsd;
  const degradations = input.degradations ?? input.estimate.degradations;
  return {
    ...input.estimate,
    actualUsd,
    variancePct,
    withinBudget: budgetUsd === null ? true : actualUsd <= budgetUsd,
    degraded: degradations.length > 0,
    degradations,
    phases: merged
  };
}

export function mergeCostReports(reports: CostReport[]): CostReport {
  if (reports.length === 0) return estimateRunCost({ shape: emptyShape("merged") });
  const first = reports[0]!;
  const phaseNames: CostPhaseName[] = ["plan", "scout", "classify", "browser", "api", "reproduction", "report"];
  const phases = phaseNames.map((name) => {
    const matching = reports.flatMap((report) => report.phases.filter((phase) => phase.name === name));
    const seed = matching[0] ?? phasesForShape(emptyShape("merged"), first.assumptions, true).find((phase) => phase.name === name)!;
    return {
      ...seed,
      plannedUnits: sumNumbers(matching.map((phase) => phase.plannedUnits)),
      actualUnits: sumNumbers(matching.map((phase) => phase.actualUnits)),
      estimatedUsd: sumUsd(matching.map((phase) => phase.estimatedUsd)),
      actualUsd: sumUsd(matching.map((phase) => phase.actualUsd)),
      skipped: matching.every((phase) => phase.skipped)
    };
  });
  const estimatedUsd = sumUsd(reports.map((report) => report.estimatedUsd));
  const actualUsd = sumUsd(reports.map((report) => report.actualUsd));
  const variancePct = estimatedUsd === 0 ? (actualUsd === 0 ? 0 : null) : roundPercent(((actualUsd - estimatedUsd) / estimatedUsd) * 100);
  const budgetUsd = reports.some((report) => report.budgetUsd === null)
    ? null
    : sumUsd(reports.map((report) => report.budgetUsd ?? 0));
  const degradations = [...new Set(reports.flatMap((report) => report.degradations))];
  return {
    ...first,
    budgetUsd,
    estimatedUsd,
    actualUsd,
    variancePct,
    withinBudget: budgetUsd === null ? reports.every((report) => report.withinBudget) : actualUsd <= budgetUsd,
    degraded: degradations.length > 0,
    degradations,
    phases
  };
}

function fitShapeWithinBudget(
  shape: RunCostShape,
  budgetUsd: number | undefined,
  assumptions: CostAssumptions,
  degradations: string[]
): RunCostShape {
  if (budgetUsd === undefined) return shape;
  let next = { ...shape };
  let estimated = estimateRunCost({ shape: next, budgetUsd, assumptions, degradations }).estimatedUsd;
  if (estimated <= budgetUsd) return next;

  const reductions: Array<{
    key: "reproductionAttempts" | "apiRequests" | "browserSessions";
    min: number;
    label: string;
  }> = [
    { key: "reproductionAttempts", min: 0, label: "reproduction-budget-reduced" },
    { key: "apiRequests", min: 0, label: "api-requests-reduced" },
    { key: "browserSessions", min: 1, label: "browser-sessions-reduced" }
  ];

  for (const reduction of reductions) {
    while (next[reduction.key] > reduction.min && estimated > budgetUsd) {
      next = { ...next, [reduction.key]: next[reduction.key] - 1 };
      estimated = estimateRunCost({ shape: next, budgetUsd, assumptions, degradations }).estimatedUsd;
    }
    if (next[reduction.key] !== shape[reduction.key]) {
      degradations.push(`${reduction.label}:${shape[reduction.key]}->${next[reduction.key]}`);
    }
    if (estimated <= budgetUsd) return next;
  }

  if (estimated > budgetUsd) {
    throw new Error(`--budget-usd ${budgetUsd} is below the minimum estimated run cost ${estimated}.`);
  }
  return next;
}

function phasesForShape(shape: RunCostShape, assumptions: CostAssumptions, actual: boolean): CostPhase[] {
  const classifierTokens = (shape.classifierInputTokens ?? 0) + (shape.classifierOutputTokens ?? 0);
  const classifierUsd =
    ((shape.classifierInputTokens ?? 0) / 1000) * assumptions.llmInputUsdPer1kTokens +
    ((shape.classifierOutputTokens ?? 0) / 1000) * assumptions.llmOutputUsdPer1kTokens;
  return [
    phase("plan", "phase", 0, 0, 0, true, "Committed plan replay; no model call during run.", actual),
    phase("scout", "phase", 0, 0, 0, true, "Scout work is precompiled into the committed plan.", actual),
    phase("classify", "token", classifierTokens, classifierTokens, classifierUsd / Math.max(1, classifierTokens), classifierTokens === 0, "Deterministic classifier fallback; no LLM call required.", actual),
    phase("browser", "session", shape.browserSessions, shape.browserSessions, assumptions.localBrowserSessionUsd, false, "Local Playwright browser sessions are measured but not externally billed.", actual),
    phase("api", "request", shape.apiRequests, shape.apiRequests, assumptions.localApiRequestUsd, shape.apiRequests === 0, "Local API tier requests are measured but not externally billed.", actual),
    phase("reproduction", "attempt", shape.reproductionAttempts, shape.reproductionAttempts, assumptions.localReproductionAttemptUsd, shape.reproductionAttempts === 0, "Per-fingerprint reruns are deterministic local browser work.", actual),
    phase("report", "render", shape.reportRenders ?? 1, shape.reportRenders ?? 1, assumptions.localReportRenderUsd, false, "Report rendering is deterministic local file generation.", actual)
  ];
}

function phase(
  name: CostPhaseName,
  unit: string,
  plannedUnits: number,
  actualUnits: number,
  unitUsd: number,
  skipped: boolean,
  note: string,
  actual: boolean
): CostPhase {
  const estimatedUsd = roundUsd(plannedUnits * unitUsd);
  const actualUsd = actual ? roundUsd(actualUnits * unitUsd) : 0;
  return {
    name,
    unit,
    plannedUnits,
    actualUnits: actual ? actualUnits : 0,
    unitUsd: roundUsd(unitUsd),
    estimatedUsd,
    actualUsd,
    metered: unitUsd > 0,
    skipped,
    note
  };
}

function normalizeShape(shape: RunCostShape): RunCostShape {
  return {
    ...shape,
    browserSessions: nonNegativeInteger(shape.browserSessions),
    apiRequests: nonNegativeInteger(shape.apiRequests),
    reproductionAttempts: nonNegativeInteger(shape.reproductionAttempts),
    reportRenders: nonNegativeInteger(shape.reportRenders ?? 1),
    classifierInputTokens: nonNegativeInteger(shape.classifierInputTokens ?? 0),
    classifierOutputTokens: nonNegativeInteger(shape.classifierOutputTokens ?? 0)
  };
}

function emptyShape(mode: string): RunCostShape {
  return { mode, browserSessions: 0, apiRequests: 0, reproductionAttempts: 0, reportRenders: 0 };
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function sumNumbers(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sumUsd(values: number[]): number {
  return roundUsd(sumNumbers(values));
}

function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function roundPercent(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
