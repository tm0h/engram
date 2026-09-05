/**
 * Unit tests for the shared baseline-comparison logic
 * (src/benchmark/baseline-compare.ts).
 *
 * The matrix encodes the approved gate policy P0-P5 (see
 * baseline-gate.test.ts docblock) and the gate-8 remediation brief's six
 * required TDD evidence items:
 *
 *   brief-1 genuine recorded-miss improvement alone -> allowed (matrix 1)
 *   brief-2 one improvement must NOT waive unrelated degradation:
 *          still-miss rank degradation rejected (matrix 2), unrelated
 *          aggregate degradation rejected (matrix 3)
 *   brief-3 pass -> miss rejected (matrix 4)
 *   brief-4 passing-case ranked-id drift rejected (matrix 5a) and, per
 *          amendment A1, any non-ranked per-case field drift on a
 *          non-improvement case rejected (matrix 5b)
 *   brief-5 unexplained 1e-6 metric drift rejected (matrix 6)
 *   brief-6 unchanged baseline accepted (matrix 7)
 *   plus the baseline-doctoring guard (matrix 8) and the real-data pins
 *   (projection identity; amendment A3 eligibility equivalence).
 *
 * Fixtures are internally consistent: every synthetic input's
 * comparableMetrics are DERIVED by running the shared projection over its
 * rows, never hand-typed; scenario 3/6 doctors exactly one aggregate leaf
 * to create the intended inconsistency. Negative tests assert the specific
 * verdict field so each failure is for its intended reason.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  compareBaselineToLive,
  projectComparableMetrics,
  type CaseRow,
  type ComparisonInput,
} from "../../src/benchmark/baseline-compare.js";
import { runRepoBenchmark } from "../../src/benchmark/run.js";

const K_VALUES = [1, 3, 5] as const;

/* ------------------------------------------------------------------ */
/* Real-data pins                                                      */
/* ------------------------------------------------------------------ */

const baseline = JSON.parse(
  readFileSync(new URL("./baseline-v0.3.1.json", import.meta.url), "utf8"),
) as ComparisonInput;
const live = runRepoBenchmark();

describe("projection pins on real data (gate-8 A2/A3)", () => {
  it("reproduces the baseline's own comparableMetrics from its rows", () => {
    expect(projectComparableMetrics(baseline.cases, baseline.config.kValues)).toEqual(
      baseline.comparableMetrics,
    );
  });

  it("reproduces the live run's own comparableMetrics from its rows", () => {
    expect(projectComparableMetrics(live.cases, live.config.kValues)).toEqual(
      live.comparableMetrics,
    );
  });

  it("pins the eligibility equivalence the projection relies on (A3)", () => {
    const ids = Object.keys(baseline.cases);
    const rrNull = ids.filter((id) => baseline.cases[id]!.reciprocalRank === null).sort();
    const abstentionCategory = ids
      .filter((id) => baseline.cases[id]!.category === "abstention")
      .sort();
    expect(rrNull).toEqual(abstentionCategory);
    expect(rrNull).toHaveLength(14);
    for (const id of rrNull) expect(id).toMatch(/^case-abstention-\d+$/);
    const projection = projectComparableMetrics(baseline.cases, baseline.config.kValues);
    expect(projection.eligibleCount).toBe(173);
    expect(projection.queryCount).toBe(187);
  });

  it("accepts the current unchanged state (matrix 7 / brief-6)", () => {
    const verdict = compareBaselineToLive(baseline, live);
    expect(verdict.ok).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.outcomeRegressions).toEqual([]);
    expect(verdict.unchangedCaseChanges).toEqual([]);
    expect(verdict.unattributedAggregateDrift).toEqual([]);
    expect(verdict.improvements).toEqual([]);
    expect(verdict.baselineInternalProblems).toEqual([]);
    expect(verdict.stillMissingLimitations).toEqual([...baseline.measuredMisses].sort());
  });
});

/* ------------------------------------------------------------------ */
/* Synthetic fixtures                                                  */
/* ------------------------------------------------------------------ */

function row(overrides: Partial<CaseRow>): CaseRow {
  return {
    category: "code-identifiers",
    passed: true,
    returned: 1,
    rankedIds: ["e1"],
    staleReturned: 0,
    forbiddenReturned: 0,
    supportingReturned: 0,
    renderedChars: 10,
    recall: [1, 1, 1],
    precision: [1, 1 / 3, 0.2],
    reciprocalRank: 1,
    ...overrides,
  };
}

const fixtureRows: Record<string, CaseRow> = {
  "case-alpha": row({}),
  "case-beta": row({
    category: "abstention",
    passed: false,
    returned: 2,
    rankedIds: ["n1", "n2"],
    renderedChars: 20,
    recall: [null, null, null],
    precision: [null, null, null],
    reciprocalRank: null,
  }),
  "case-gamma": row({
    category: "paraphrase",
    passed: false,
    returned: 3,
    rankedIds: ["r1", "x2", "x3"],
    renderedChars: 30,
    recall: [0.5, 0.5, 0.5],
    precision: [1, 1 / 3, 0.2],
    reciprocalRank: 1,
  }),
  "case-delta": row({
    category: "exact-facts",
    returned: 2,
    rankedIds: ["d1", "d2"],
    renderedChars: 40,
  }),
  "case-epsilon": row({
    category: "abstention",
    passed: false,
    returned: 2,
    rankedIds: ["m1", "m2"],
    renderedChars: 25,
    recall: [null, null, null],
    precision: [null, null, null],
    reciprocalRank: null,
  }),
};

function buildInput(
  cases: Record<string, CaseRow>,
  overrides: Partial<ComparisonInput> = {},
): ComparisonInput {
  return {
    corpusVersion: "0.3.1",
    schemaVersion: 1,
    contractHash: "sha256:fixture",
    config: { kValues: [...K_VALUES], abstainThreshold: 0 },
    comparableMetrics: projectComparableMetrics(cases, [...K_VALUES]),
    measuredMisses: Object.keys(cases)
      .filter((id) => !cases[id]!.passed)
      .sort(),
    cases,
    ...overrides,
  };
}

/** Deep-copy rows for scenario mutation. */
function cloneRows(rows: Record<string, CaseRow>): Record<string, CaseRow> {
  return JSON.parse(JSON.stringify(rows)) as Record<string, CaseRow>;
}

const fixtureBaseline = buildInput(cloneRows(fixtureRows));

/** Live variant 1: genuine improvement on the recorded abstention miss
 * (case-beta returns zero results = correct abstention), nothing else
 * changes. Aggregates derived through the projection. */
function improvedLive(): ComparisonInput {
  const rows = cloneRows(fixtureRows);
  rows["case-beta"] = {
    ...rows["case-beta"]!,
    passed: true,
    returned: 0,
    rankedIds: [],
    renderedChars: 0,
  };
  return buildInput(rows);
}

describe("gate comparison matrix (approved policy P0-P5)", () => {
  it("matrix 1 (brief-1): a genuine recorded-miss improvement alone is allowed", () => {
    const verdict = compareBaselineToLive(fixtureBaseline, improvedLive());
    expect(verdict.improvements.map((i) => i.caseId)).toEqual(["case-beta"]);
    expect(verdict.ok).toBe(true);
    expect(verdict.reasons).toEqual([]);
    // attributable aggregate deltas are surfaced, never blocking
    expect(verdict.improvementAggregateDeltas.map((d) => d.field)).toContain("passedCount");
  });

  it("matrix 2a (brief-2): improvement + still-miss row change that cannot move aggregates is rejected via per-case drift only", () => {
    const rows = cloneRows(fixtureRows);
    rows["case-beta"] = {
      ...rows["case-beta"]!,
      passed: true,
      returned: 0,
      rankedIds: [],
      renderedChars: 0,
    };
    // case-epsilon still misses; its noise rows reorder (same ids, same
    // counts) so no aggregate can move: the rejection must come from P2.
    rows["case-epsilon"] = { ...rows["case-epsilon"]!, rankedIds: ["m2", "m1"] };
    const verdict = compareBaselineToLive(fixtureBaseline, buildInput(rows));
    expect(verdict.improvements.map((i) => i.caseId)).toEqual(["case-beta"]);
    expect(verdict.ok).toBe(false);
    expect(verdict.unchangedCaseChanges.map((c) => `${c.caseId}.${c.field}`)).toEqual([
      "case-epsilon.rankedIds",
    ]);
    // fails for the intended reason: aggregates are consistent here
    expect(verdict.unattributedAggregateDrift).toEqual([]);
  });

  it("matrix 2b (brief-2, documented belt-and-braces): improvement + eligible still-miss rank degradation is rejected by BOTH per-case drift and unattributed drift", () => {
    const rows = cloneRows(fixtureRows);
    rows["case-beta"] = {
      ...rows["case-beta"]!,
      passed: true,
      returned: 0,
      rankedIds: [],
      renderedChars: 0,
    };
    // case-gamma is still a miss but eligible: its rr/recall degrade, and
    // because non-improvement rows must be stable, the merged projection
    // (baseline gamma row) also flags the aggregate movement as
    // unattributed. Both rejections name the same case.
    rows["case-gamma"] = {
      ...rows["case-gamma"]!,
      rankedIds: ["x2", "r1", "x3"],
      recall: [0, 0.5, 0.5],
      precision: [0, 1 / 3, 0.2],
      reciprocalRank: 0.5,
    };
    const verdict = compareBaselineToLive(fixtureBaseline, buildInput(rows));
    expect(verdict.ok).toBe(false);
    expect(verdict.unchangedCaseChanges.map((c) => `${c.caseId}.${c.field}`)).toContain(
      "case-gamma.reciprocalRank",
    );
    expect(verdict.unattributedAggregateDrift.map((d) => d.field)).toContain("mrr");
    for (const d of verdict.unattributedAggregateDrift) {
      // every unattributed movement is explained as "should have stayed at
      // the baseline value" (the degraded row is itself unauthorized)
      expect(d.expected).toBe(d.baseline);
    }
  });

  it("matrix 3 (brief-2): improvement + unrelated aggregate degradation is rejected via unattributed drift", () => {
    const doctored = improvedLive();
    const mrr = doctored.comparableMetrics.mrr;
    expect(mrr).not.toBeNull();
    doctored.comparableMetrics = {
      ...doctored.comparableMetrics,
      mrr: (mrr as number) - 0.01,
    };
    const verdict = compareBaselineToLive(fixtureBaseline, doctored);
    expect(verdict.improvements.map((i) => i.caseId)).toEqual(["case-beta"]);
    expect(verdict.ok).toBe(false);
    const mrrDrift = verdict.unattributedAggregateDrift.find((d) => d.field === "mrr");
    expect(mrrDrift).toBeDefined();
    expect(mrrDrift?.baseline).toBe(fixtureBaseline.comparableMetrics.mrr);
    expect(mrrDrift?.expected).toBe(fixtureBaseline.comparableMetrics.mrr);
    // fails for the intended reason: no per-case drift exists
    expect(verdict.unchangedCaseChanges).toEqual([]);
  });

  it("matrix 4 (brief-3): pass -> miss is rejected", () => {
    const rows = cloneRows(fixtureRows);
    rows["case-alpha"] = { ...rows["case-alpha"]!, passed: false };
    const verdict = compareBaselineToLive(fixtureBaseline, buildInput(rows));
    expect(verdict.ok).toBe(false);
    expect(verdict.outcomeRegressions).toEqual(["case-alpha"]);
  });

  it("matrix 5a (brief-4): passing-case ranked-id drift (pure reorder) is rejected", () => {
    const rows = cloneRows(fixtureRows);
    rows["case-delta"] = {
      ...rows["case-delta"]!,
      rankedIds: ["d2", "d1"],
      recall: [0, 1, 1],
      precision: [0, 1 / 3, 0.2],
      reciprocalRank: 0.5,
    };
    const verdict = compareBaselineToLive(fixtureBaseline, buildInput(rows));
    expect(verdict.ok).toBe(false);
    expect(verdict.unchangedCaseChanges.map((c) => `${c.caseId}.${c.field}`)).toContain(
      "case-delta.rankedIds",
    );
  });

  it("matrix 5b (amendment A1): non-ranked per-case field drift on a passing case is rejected", () => {
    const rows = cloneRows(fixtureRows);
    rows["case-delta"] = { ...rows["case-delta"]!, supportingReturned: 1 };
    const verdict = compareBaselineToLive(fixtureBaseline, buildInput(rows));
    expect(verdict.ok).toBe(false);
    expect(verdict.unchangedCaseChanges.map((c) => `${c.caseId}.${c.field}`)).toContain(
      "case-delta.supportingReturned",
    );
    // supportingReturned feeds no aggregate; aggregates are consistent
    expect(verdict.unattributedAggregateDrift).toEqual([]);
  });

  it("matrix 6 (brief-5): unexplained 1e-6 metric drift with no improvements is rejected", () => {
    const doctored = buildInput(cloneRows(fixtureRows));
    const mrr = doctored.comparableMetrics.mrr;
    expect(mrr).not.toBeNull();
    doctored.comparableMetrics = {
      ...doctored.comparableMetrics,
      mrr: (mrr as number) + 0.000001,
    };
    const verdict = compareBaselineToLive(fixtureBaseline, doctored);
    expect(verdict.improvements).toEqual([]);
    expect(verdict.ok).toBe(false);
    expect(verdict.unattributedAggregateDrift.map((d) => d.field)).toContain("mrr");
  });

  it("matrix 8 (doctoring guard): measuredMisses omitting a failing case is rejected", () => {
    const doctoredBaseline = buildInput(cloneRows(fixtureRows), {
      measuredMisses: ["case-beta"],
    });
    const verdict = compareBaselineToLive(doctoredBaseline, buildInput(cloneRows(fixtureRows)));
    expect(verdict.ok).toBe(false);
    expect(verdict.baselineInternalProblems.some((p) => p.includes("case-gamma"))).toBe(true);
  });

  it("matrix 8b (doctoring guard): measuredMisses listing an unknown case is rejected", () => {
    const doctoredBaseline = buildInput(cloneRows(fixtureRows), {
      measuredMisses: ["case-beta", "case-ghost"],
    });
    const verdict = compareBaselineToLive(doctoredBaseline, buildInput(cloneRows(fixtureRows)));
    expect(verdict.ok).toBe(false);
    expect(verdict.baselineInternalProblems.some((p) => p.includes("case-ghost"))).toBe(true);
  });
});
