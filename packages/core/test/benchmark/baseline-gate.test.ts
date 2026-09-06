/**
 * Regression gate for the ENG-8 retrieval benchmark.
 *
 * Compares a live benchmark run over the in-repo corpus (wired search)
 * against the checked-in versioned baseline (baseline-v0.3.1.json) using
 * the SHARED comparison logic in src/benchmark/baseline-compare.ts (the
 * same pure functions unit-tested in baseline-compare.test.ts and available
 * to validators; no copied test bodies).
 *
 * Normative gate policy (P0-P5, reviewer-approved gate-8 remediation):
 *
 * - P0 identity/config: corpusVersion, schemaVersion, contractHash (live
 *   recomputed from disk via corpusSnapshotHash), config kValues and
 *   abstainThreshold equal; identical case-id sets.
 * - P1 FAIL on any outcome regression: a case that passes in the baseline
 *   but misses in the live run. Regressions require leader disposition;
 *   no relabeling.
 * - P2 FAIL on any per-case data change on non-improvement cases, full row
 *   (category, passed, returned, rankedIds, staleReturned,
 *   forbiddenReturned, supportingReturned, renderedChars, recall,
 *   precision, reciprocalRank), covering both still-pass and still-miss
 *   cases. An improvement can never mask an unrelated case's drift.
 * - P3 FAIL on any aggregate metric drift not exactly attributable to
 *   improvements: expected aggregates are recomputed from merged rows
 *   (live rows for improvement cases, baseline rows otherwise) through the
 *   shared projection; every leaf where live deviates is unattributed
 *   drift. Latency is excluded everywhere. With zero improvements this is
 *   exact 6-decimal equality with the baseline aggregates. No waiver path,
 *   no early return.
 * - P4 improvements (baseline miss -> live pass) NEVER block: they are
 *   surfaced here with their per-case before/after and the attributable
 *   aggregate deltas, and they trigger the documented regeneration policy
 *   (explicit review of the full delta; regressions require disposition;
 *   corpus labels are never edited to make a ranker pass). A genuine
 *   improvement on a case listed in measuredMisses passes this gate.
 * - P5 baseline-internal consistency: measuredMisses must equal exactly
 *   the baseline's own failing case ids. Live side is informational:
 *   still-missing measured misses surface as measured retrieval
 *   limitations; there is NO live-side must-still-fail pin.
 *
 * Gate-time self-consistency (amendment A2): every run asserts that the
 * shared projection reproduces BOTH the baseline's and the live run's own
 * comparableMetrics from their per-case rows, so projection formula drift
 * is caught on the real corpus by the gate itself.
 *
 * Baseline regeneration: run the repo benchmark command (documented in
 * run.ts), review the full delta (this gate names every drift), and update
 * source SHAs in the same reviewed change. Latency is never stored.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  compareBaselineToLive,
  projectComparableMetrics,
  type ComparisonInput,
} from "../../src/benchmark/baseline-compare.js";
import { corpusSnapshotHash, runRepoBenchmark } from "../../src/benchmark/run.js";

const baseline = JSON.parse(
  readFileSync(new URL("./baseline-v0.3.1.json", import.meta.url), "utf8"),
) as ComparisonInput;

const live = runRepoBenchmark();

const verdict = compareBaselineToLive(baseline, live);

describe("retrieval baseline regression gate (corpus v0.3.1)", () => {
  it("pins the corpus snapshot identity (P0)", () => {
    expect(live.corpusVersion).toBe(baseline.corpusVersion);
    expect(live.schemaVersion).toBe(baseline.schemaVersion);
    expect(live.contractHash).toBe(baseline.contractHash);
    // belt and braces: recompute from disk
    expect(`sha256:${corpusSnapshotHash()}`).toBe(baseline.contractHash);
    expect(verdict.identityProblems).toEqual([]);
  });

  it("projection self-consistency: baseline and live aggregates are reproducible from their rows (A2)", () => {
    expect(projectComparableMetrics(baseline.cases, baseline.config.kValues)).toEqual(
      baseline.comparableMetrics,
    );
    expect(projectComparableMetrics(live.cases, live.config.kValues)).toEqual(
      live.comparableMetrics,
    );
  });

  it("fails on any regression (baseline pass -> live miss) (P1)", () => {
    expect(
      verdict.outcomeRegressions,
      `regressions vs baseline (pass -> miss): ${verdict.outcomeRegressions.join(", ") || "none"}`,
    ).toEqual([]);
  });

  it("fails on any per-case data change on non-improvement cases, full row, including still-missing cases (P2)", () => {
    expect(
      verdict.unchangedCaseChanges,
      `per-case changes on non-improvement cases: ${
        verdict.unchangedCaseChanges.map((c) => `${c.caseId}.${c.field}`).join(", ") || "none"
      }`,
    ).toEqual([]);
  });

  it("fails on any aggregate metric drift not attributable to improvements, latency excluded (P3)", () => {
    expect(
      verdict.unattributedAggregateDrift,
      `unattributed aggregate drift: ${
        verdict.unattributedAggregateDrift
          .map((d) => `${d.field} ${d.baseline} -> ${d.live} (expected ${d.expected})`)
          .join("; ") || "none"
      }`,
    ).toEqual([]);
  });

  it("surfaces improvements without blocking them, with their attributable deltas (P4)", () => {
    if (verdict.improvements.length > 0) {
      console.log(
        `[baseline-gate] improvements (baseline miss -> live pass): ${verdict.improvements
          .map((i) => i.caseId)
          .join(", ")}`,
      );
      console.log(
        `[baseline-gate] attributable aggregate deltas: ${
          verdict.improvementAggregateDeltas
            .map((d) => `${d.field} ${d.baseline} -> ${d.live}`)
            .join("; ") || "none"
        }`,
      );
    }
    expect(Array.isArray(verdict.improvements)).toBe(true);
  });

  it("baseline measuredMisses are internally consistent; still-missing limitations stay visible (P5)", () => {
    expect(
      verdict.baselineInternalProblems,
      `measuredMisses consistency: ${verdict.baselineInternalProblems.join("; ") || "ok"}`,
    ).toEqual([]);
    // Live side is informational: limitations that persist are surfaced,
    // never enforced as must-still-fail (a genuine improvement passes P4).
    if (verdict.stillMissingLimitations.length > 0) {
      console.log(
        `[baseline-gate] measured retrieval limitations still missing live: ${verdict.stillMissingLimitations.join(", ")}`,
      );
    }
    expect(Array.isArray(verdict.stillMissingLimitations)).toBe(true);
  });

  it("overall gate verdict is clean on the current state", () => {
    expect(verdict.ok).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });
});
