/**
 * Shared baseline-vs-live comparison logic for the ENG-8 regression gate.
 *
 * This module owns the gate's comparison semantics as PURE, reusable
 * functions so the gate test, unit tests, and validators exercise the real
 * production logic instead of copied test bodies.
 *
 * Two layers:
 *
 * 1. `projectComparableMetrics` derives the comparable aggregate metrics
 *    from per-case rows using the SAME aggregation semantics as
 *    computeMetrics (metrics.ts): eligibility for Recall/Precision/MRR is
 *    reciprocalRank !== null; abstention-eligible rows are the RR-null
 *    rows (abstention-correct = RR-null with zero returns; false abstain =
 *    RR-non-null with zero returns); means run over eligible rows in
 *    case-id order; ratios round once at the end (round6). The gate
 *    asserts every run that this projection reproduces both the baseline's
 *    and the live run's own comparableMetrics exactly, so projection
 *    formula drift is caught on the real corpus.
 *
 * 2. `compareBaselineToLive` classifies a live run against the checked-in
 *    baseline per the normative gate policy P0-P5 (see baseline-gate.test.ts
 *    docblock): P0 identity/config; P1 outcome regressions rejected; P2
 *    full per-case row equality on non-improvement cases (both still-pass
 *    and still-miss) rejected on any difference; P3 aggregate metrics must
 *    equal a merged-row recomputation (live rows for improvement cases,
 *    baseline rows otherwise) exactly, so no improvement can waive
 *    unrelated drift; P4 improvements surfaced with their attributable
 *    deltas, never blocking; P5 baseline-internal measuredMisses
 *    consistency enforced, live still-missing limitations surfaced
 *    informationally, with NO live-side must-still-fail pin.
 *
 * Not exported from packages/core/src/index.ts: benchmark scaffold, must
 * not affect the CLI bundle.
 */
import { CORPUS_CATEGORIES } from "@engram/core/corpus";
import { byIdAsc, canonicalizeKValues, round6 } from "./metrics.js";

/** One per-case row of the benchmark JSON (baseline and live share it). */
export interface CaseRow {
  category: string;
  passed: boolean;
  returned: number;
  rankedIds: string[];
  staleReturned: number;
  forbiddenReturned: number;
  supportingReturned: number;
  renderedChars: number;
  recall: ReadonlyArray<number | null>;
  precision: ReadonlyArray<number | null>;
  reciprocalRank: number | null;
}

/** The comparable (6-decimal, latency-excluded) aggregate shape. */
export interface ComparableMetrics {
  queryCount: number;
  passedCount: number;
  passRate: number | null;
  mrr: number | null;
  staleRate: number | null;
  forbiddenRate: number | null;
  abstentionAccuracy: number | null;
  falseAbstainRate: number | null;
  eligibleCount: number;
  totalReturned: number;
  staleReturned: number;
  forbiddenReturned: number;
  renderedCharsTotal: number;
  kMetrics: ReadonlyArray<{ k: number; recall: number | null; precision: number | null }>;
  categoryMetrics: ReadonlyArray<{
    category: string;
    cases: number;
    passed: number;
    passRate: number | null;
  }>;
}

/** Structural input for comparison: satisfied by RepoBenchmarkJson and by
 * the checked-in baseline file. */
export interface ComparisonInput {
  corpusVersion: string;
  schemaVersion: number;
  contractHash: string;
  config: { kValues: ReadonlyArray<number>; abstainThreshold: number };
  comparableMetrics: ComparableMetrics;
  measuredMisses: string[];
  cases: Record<string, CaseRow>;
}

/** One rejected per-case difference (policy P2). */
export interface CaseFieldDiff {
  caseId: string;
  field: string;
  baseline: unknown;
  live: unknown;
}

/** One aggregate leaf difference (policy P3 drift / P4 surfacing). */
export interface AggregateDrift {
  field: string;
  baseline: number | string | null;
  live: number | string | null;
  expected?: number | string | null;
}

/** Surfaced improvement with its per-case before/after (policy P4). */
export interface ImprovementEntry {
  caseId: string;
  before: CaseRow;
  after: CaseRow;
}

/** Full gate verdict. `ok` is false exactly when a rejection category is
 * non-empty; `reasons` lists every rejection in deterministic order. */
export interface GateComparison {
  ok: boolean;
  reasons: string[];
  identityProblems: string[];
  outcomeRegressions: string[];
  unchangedCaseChanges: CaseFieldDiff[];
  unattributedAggregateDrift: AggregateDrift[];
  improvements: ImprovementEntry[];
  improvementAggregateDeltas: AggregateDrift[];
  stillMissingLimitations: string[];
  baselineInternalProblems: string[];
}

/* ------------------------------------------------------------------ */
/* Projection: per-case rows -> comparable aggregates.                 */
/* ------------------------------------------------------------------ */

const rate = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

function mean(values: ReadonlyArray<number>): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

const round = (value: number | null): number | null => (value === null ? null : round6(value));

/**
 * Derive the comparable aggregate metrics from per-case rows using the
 * computeMetrics aggregation semantics (see module docblock). `kValues`
 * canonicalizes exactly like the runner; recall/precision arrays are
 * indexed in that canonical order. Row iteration is case-id sorted so
 * floating-point summation order matches computeMetrics.
 */
export function projectComparableMetrics(
  cases: Record<string, CaseRow>,
  kValues: ReadonlyArray<number>,
): ComparableMetrics {
  const ks = canonicalizeKValues(kValues);
  const ids = Object.keys(cases).sort(byIdAsc);
  const rows = ids.map((id) => cases[id] as CaseRow);

  const queryCount = rows.length;
  const passedCount = rows.reduce((sum, r) => sum + (r.passed ? 1 : 0), 0);

  const eligible = rows.filter((r) => r.reciprocalRank !== null);
  const eligibleCount = eligible.length;

  const kMetrics = ks.map((k, i) => ({
    k,
    recall: eligibleCount === 0 ? null : round6(mean(eligible.map((r) => r.recall[i] ?? 0))),
    precision: eligibleCount === 0 ? null : round6(mean(eligible.map((r) => r.precision[i] ?? 0))),
  }));
  const mrr = eligibleCount === 0 ? null : round6(mean(eligible.map((r) => r.reciprocalRank ?? 0)));

  const categoryMetrics = CORPUS_CATEGORIES.map((category) => {
    const members = rows.filter((r) => r.category === category);
    const passed = members.reduce((sum, r) => sum + (r.passed ? 1 : 0), 0);
    return {
      category,
      cases: members.length,
      passed,
      passRate: round(rate(passed, members.length)),
    };
  });

  const totalReturned = rows.reduce((sum, r) => sum + r.returned, 0);
  const staleReturned = rows.reduce((sum, r) => sum + r.staleReturned, 0);
  const forbiddenReturned = rows.reduce((sum, r) => sum + r.forbiddenReturned, 0);
  const renderedCharsTotal = rows.reduce((sum, r) => sum + r.renderedChars, 0);

  const abstentionRows = rows.filter((r) => r.reciprocalRank === null);
  const abstentionCorrect = abstentionRows.filter((r) => r.returned === 0).length;
  const nonAbstention = rows.filter((r) => r.reciprocalRank !== null);
  const falseAbstain = nonAbstention.filter((r) => r.returned === 0).length;

  return {
    queryCount,
    passedCount,
    passRate: round(rate(passedCount, queryCount)),
    mrr,
    staleRate: round(rate(staleReturned, totalReturned)),
    forbiddenRate: round(rate(forbiddenReturned, totalReturned)),
    abstentionAccuracy: round(rate(abstentionCorrect, abstentionRows.length)),
    falseAbstainRate: round(rate(falseAbstain, nonAbstention.length)),
    eligibleCount,
    totalReturned,
    staleReturned,
    forbiddenReturned,
    renderedCharsTotal,
    kMetrics,
    categoryMetrics,
  };
}

/* ------------------------------------------------------------------ */
/* Leaf-wise comparison of two comparable shapes.                      */
/* ------------------------------------------------------------------ */

function leafDrift(
  field: string,
  baseline: number | string | null,
  live: number | string | null,
  expected?: number | string | null,
): AggregateDrift | undefined {
  if (baseline === live) return undefined;
  return expected === undefined ? { field, baseline, live } : { field, baseline, live, expected };
}

/** Every differing leaf of two ComparableMetrics, deterministically
 * ordered (scalars in declaration order, then kMetrics, then
 * categoryMetrics in canonical category order). */ export function diffComparable(
  baseline: ComparableMetrics,
  live: ComparableMetrics,
): AggregateDrift[] {
  const drift: AggregateDrift[] = [];
  const scalar: Array<[string, number | string | null]> = [
    ["queryCount", baseline.queryCount],
    ["passedCount", baseline.passedCount],
    ["passRate", baseline.passRate],
    ["mrr", baseline.mrr],
    ["staleRate", baseline.staleRate],
    ["forbiddenRate", baseline.forbiddenRate],
    ["abstentionAccuracy", baseline.abstentionAccuracy],
    ["falseAbstainRate", baseline.falseAbstainRate],
    ["eligibleCount", baseline.eligibleCount],
    ["totalReturned", baseline.totalReturned],
    ["staleReturned", baseline.staleReturned],
    ["forbiddenReturned", baseline.forbiddenReturned],
    ["renderedCharsTotal", baseline.renderedCharsTotal],
  ];
  const liveScalar = new Map<string, number | string | null>([
    ["queryCount", live.queryCount],
    ["passedCount", live.passedCount],
    ["passRate", live.passRate],
    ["mrr", live.mrr],
    ["staleRate", live.staleRate],
    ["forbiddenRate", live.forbiddenRate],
    ["abstentionAccuracy", live.abstentionAccuracy],
    ["falseAbstainRate", live.falseAbstainRate],
    ["eligibleCount", live.eligibleCount],
    ["totalReturned", live.totalReturned],
    ["staleReturned", live.staleReturned],
    ["forbiddenReturned", live.forbiddenReturned],
    ["renderedCharsTotal", live.renderedCharsTotal],
  ]);
  for (const [field, before] of scalar) {
    const d = leafDrift(field, before, liveScalar.get(field) ?? null);
    if (d !== undefined) drift.push(d);
  }
  const liveK = new Map(live.kMetrics.map((k) => [k.k, k] as const));
  for (const k of baseline.kMetrics) {
    const other = liveK.get(k.k);
    for (const leaf of ["recall", "precision"] as const) {
      const before = k[leaf];
      const after = other === undefined ? null : other[leaf];
      const d = leafDrift(`kMetrics.${leaf}@${k.k}`, before, after);
      if (d !== undefined) drift.push(d);
    }
  }
  const liveC = new Map(live.categoryMetrics.map((c) => [c.category, c] as const));
  for (const c of baseline.categoryMetrics) {
    const other = liveC.get(c.category);
    const fields: Array<[string, number | string | null]> = [
      ["cases", c.cases],
      ["passed", c.passed],
      ["passRate", c.passRate],
    ];
    for (const [leaf, before] of fields) {
      const after =
        other === undefined
          ? null
          : leaf === "cases"
            ? other.cases
            : leaf === "passed"
              ? other.passed
              : other.passRate;
      const d = leafDrift(`categoryMetrics.${c.category}.${leaf}`, before, after);
      if (d !== undefined) drift.push(d);
    }
  }
  return drift;
}

/** Read one leaf of a ComparableMetrics by its drift field name. */
function leafValue(metrics: ComparableMetrics, field: string): number | string | null {
  const scalar: Record<string, number | string | null> = {
    queryCount: metrics.queryCount,
    passedCount: metrics.passedCount,
    passRate: metrics.passRate,
    mrr: metrics.mrr,
    staleRate: metrics.staleRate,
    forbiddenRate: metrics.forbiddenRate,
    abstentionAccuracy: metrics.abstentionAccuracy,
    falseAbstainRate: metrics.falseAbstainRate,
    eligibleCount: metrics.eligibleCount,
    totalReturned: metrics.totalReturned,
    staleReturned: metrics.staleReturned,
    forbiddenReturned: metrics.forbiddenReturned,
    renderedCharsTotal: metrics.renderedCharsTotal,
  };
  if (field in scalar) return scalar[field] ?? null;
  const kMatch = /^kMetrics\.(recall|precision)@(\d+)$/.exec(field);
  if (kMatch !== null) {
    const entry = metrics.kMetrics.find((k) => k.k === Number(kMatch[2]));
    if (entry === undefined) return null;
    return kMatch[1] === "recall" ? entry.recall : entry.precision;
  }
  const cMatch = /^categoryMetrics\.(.+)\.(cases|passed|passRate)$/.exec(field);
  if (cMatch !== null) {
    const entry = metrics.categoryMetrics.find((c) => c.category === cMatch[1]);
    if (entry === undefined) return null;
    return cMatch[2] === "cases"
      ? entry.cases
      : cMatch[2] === "passed"
        ? entry.passed
        : entry.passRate;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Stage 2: the approved gate policy P0-P5 (reviewer preflight         */
/* reviews/gate8-fix-preflight.md, binding).                           */
/* ------------------------------------------------------------------ */

/** Per-case fields the unchanged-case rule compares (P2, full row per
 * amendment A1), in deterministic order. */
const CASE_FIELDS: ReadonlyArray<keyof CaseRow> = [
  "category",
  "passed",
  "returned",
  "rankedIds",
  "staleReturned",
  "forbiddenReturned",
  "supportingReturned",
  "renderedChars",
  "recall",
  "precision",
  "reciprocalRank",
];

function caseFieldDiff(
  caseId: string,
  field: keyof CaseRow,
  baseline: CaseRow,
  live: CaseRow,
): CaseFieldDiff | undefined {
  const before = baseline[field];
  const after = live[field];
  const equal =
    Array.isArray(before) || Array.isArray(after)
      ? JSON.stringify(before) === JSON.stringify(after)
      : before === after;
  return equal ? undefined : { caseId, field, baseline: before, live: after };
}

export function compareBaselineToLive(
  baseline: ComparisonInput,
  live: ComparisonInput,
): GateComparison {
  const identityProblems: string[] = [];
  if (live.corpusVersion !== baseline.corpusVersion) {
    identityProblems.push(`corpusVersion ${baseline.corpusVersion} -> ${live.corpusVersion}`);
  }
  if (live.schemaVersion !== baseline.schemaVersion) {
    identityProblems.push(`schemaVersion ${baseline.schemaVersion} -> ${live.schemaVersion}`);
  }
  if (live.contractHash !== baseline.contractHash) {
    identityProblems.push(`contractHash ${baseline.contractHash} -> ${live.contractHash}`);
  }
  if (
    canonicalizeKValues(live.config.kValues).join(",") !==
      canonicalizeKValues(baseline.config.kValues).join(",") ||
    live.config.abstainThreshold !== baseline.config.abstainThreshold
  ) {
    identityProblems.push(
      `config ${JSON.stringify(baseline.config)} -> ${JSON.stringify(live.config)}`,
    );
  }
  const baselineIds = Object.keys(baseline.cases).sort(byIdAsc);
  const liveIds = Object.keys(live.cases).sort(byIdAsc);
  const missingInLive = baselineIds.filter((id) => !(id in live.cases));
  const extraInLive = liveIds.filter((id) => !(id in baseline.cases));
  if (missingInLive.length > 0)
    identityProblems.push(`cases missing in live: ${missingInLive.join(", ")}`);
  if (extraInLive.length > 0)
    identityProblems.push(`cases unknown to baseline: ${extraInLive.join(", ")}`);

  const outcomeRegressions = baselineIds.filter(
    (id) => baseline.cases[id]!.passed && live.cases[id] !== undefined && !live.cases[id]!.passed,
  );

  /* P4: improvements first; their cases are exempt from P2 row stability
   * and their live rows drive the P3 merged projection. */
  const improvementIds = baselineIds.filter(
    (id) => !baseline.cases[id]!.passed && live.cases[id] !== undefined && live.cases[id]!.passed,
  );
  const improvements: ImprovementEntry[] = improvementIds.map((id) => ({
    caseId: id,
    before: baseline.cases[id]!,
    after: live.cases[id]!,
  }));
  const improvementSet = new Set(improvementIds);

  /* P2 (amendment A1): full per-case row equality on every case that is
   * neither an improvement nor an already-rejected outcome regression,
   * covering both still-pass and still-miss cases. No waiver, no early
   * return. */
  const unchangedCaseChanges: CaseFieldDiff[] = [];
  for (const id of baselineIds) {
    if (improvementSet.has(id) || outcomeRegressions.includes(id)) continue;
    const before = baseline.cases[id]!;
    const after = live.cases[id];
    if (after === undefined) continue;
    for (const field of CASE_FIELDS) {
      const diff = caseFieldDiff(id, field, before, after);
      if (diff !== undefined) unchangedCaseChanges.push(diff);
    }
  }

  /* P3: expected aggregates = projection over merged rows (live rows for
   * improvement cases, baseline rows otherwise). Every aggregate leaf
   * where live deviates from that expectation is unattributed drift
   * (baseline value attached for context). With zero improvements this is
   * exact equality with the baseline aggregates. No waiver path. */
  const mergedRows: Record<string, CaseRow> = {};
  for (const id of baselineIds) {
    mergedRows[id] = improvementSet.has(id) ? live.cases[id]! : baseline.cases[id]!;
  }
  const expectedMetrics = projectComparableMetrics(mergedRows, baseline.config.kValues);
  const unattributedAggregateDrift: AggregateDrift[] = diffComparable(
    expectedMetrics,
    live.comparableMetrics,
  ).map((d) => ({
    field: d.field,
    baseline: leafValue(baseline.comparableMetrics, d.field),
    live: d.live,
    expected: d.baseline,
  }));

  /* P5: baseline-internal measuredMisses consistency (exact equality with
   * the baseline's own failing set); live side stays informational with
   * NO must-still-fail pin (F1 fix). */
  const baselineInternalProblems: string[] = [];
  const baselineFailing = baselineIds.filter((id) => !baseline.cases[id]!.passed).sort();
  const recorded = [...baseline.measuredMisses].sort();
  for (const id of recorded) {
    if (!(id in baseline.cases)) {
      baselineInternalProblems.push(`measuredMisses lists unknown case ${id}`);
    }
  }
  if (JSON.stringify(recorded) !== JSON.stringify(baselineFailing)) {
    const omitted = baselineFailing.filter((id) => !recorded.includes(id));
    const extra = recorded.filter(
      (id) => baselineFailing.includes(id) === false && id in baseline.cases,
    );
    if (omitted.length > 0) {
      baselineInternalProblems.push(`measuredMisses omits failing case(s): ${omitted.join(", ")}`);
    }
    if (extra.length > 0) {
      baselineInternalProblems.push(
        `measuredMisses lists non-failing case(s): ${extra.join(", ")}`,
      );
    }
  }
  const stillMissingLimitations = recorded.filter(
    (id) => live.cases[id] !== undefined && !live.cases[id]!.passed,
  );

  const improvementAggregateDeltas = diffComparable(
    baseline.comparableMetrics,
    live.comparableMetrics,
  );

  const reasons: string[] = [];
  if (identityProblems.length > 0) reasons.push(`identity/config: ${identityProblems.join("; ")}`);
  if (outcomeRegressions.length > 0) {
    reasons.push(
      `outcome regressions (baseline pass -> live miss): ${outcomeRegressions.join(", ")}`,
    );
  }
  if (unchangedCaseChanges.length > 0) {
    reasons.push(
      `per-case changes on non-improvement cases: ${unchangedCaseChanges
        .map((c) => `${c.caseId}.${c.field}`)
        .join(", ")}`,
    );
  }
  if (unattributedAggregateDrift.length > 0) {
    reasons.push(
      `unattributed aggregate drift: ${unattributedAggregateDrift
        .map((d) => `${d.field} ${d.baseline} -> ${d.live}`)
        .join("; ")}`,
    );
  }
  if (baselineInternalProblems.length > 0) {
    reasons.push(`measured-misses consistency: ${baselineInternalProblems.join("; ")}`);
  }

  const ok =
    identityProblems.length === 0 &&
    outcomeRegressions.length === 0 &&
    unchangedCaseChanges.length === 0 &&
    unattributedAggregateDrift.length === 0 &&
    baselineInternalProblems.length === 0;

  return {
    ok,
    reasons,
    identityProblems,
    outcomeRegressions,
    unchangedCaseChanges,
    unattributedAggregateDrift,
    improvements,
    improvementAggregateDeltas,
    stillMissingLimitations,
    baselineInternalProblems,
  };
}
