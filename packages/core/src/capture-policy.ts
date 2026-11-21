import { Schema } from "effect";
import implementation from "./capture-fingerprint.json" with { type: "json" };
import manifest from "../../../corpus/capture/manifest.json" with { type: "json" };
import external from "../../../corpus/capture/sessions/external-injection.json" with { type: "json" };
import release from "../../../corpus/capture/sessions/mixed-release.json" with { type: "json" };
import personal from "../../../corpus/capture/sessions/personal-remember.json" with { type: "json" };
import recall from "../../../corpus/capture/sessions/recall-and-duplicate.json" with { type: "json" };
import gotcha from "../../../corpus/capture/sessions/repeated-gotcha.json" with { type: "json" };
import sensitive from "../../../corpus/capture/sessions/sensitive-task.json" with { type: "json" };
import setup from "../../../corpus/capture/sessions/workspace-setup.json" with { type: "json" };
import { validateCaptureManifest, validateCaptureSession } from "./capture-corpus.js";
import { CAPTURE_RULES_VERSION } from "./capture-rules.js";
import { measureCaptureCorpus } from "./capture-score.js";
import { SUPPORTED_CONFIG_VERSION, SUPPORTED_ENTRY_SCHEMA_VERSION } from "./domain.js";

export const capturePolicy = {
  version: 1,
  implementation: {
    fingerprint: implementation.fingerprint,
    extractor: CAPTURE_RULES_VERSION,
    admission: CAPTURE_RULES_VERSION,
    entry: SUPPORTED_ENTRY_SCHEMA_VERSION,
    config: SUPPORTED_CONFIG_VERSION,
    scanner: 1,
    pi: 1,
    opencode: 1,
    canonicalWrite: 1,
  },
  corpusVersion: manifest.corpusVersion,
  windowDays: 30,
  expiryDays: 14,
  maxUnassessed: 24,
  maxPopulation: 240,
  minOverall: 60,
  minPerHarness: 25,
  minPerClass: 15,
  minPerHarnessClass: 5,
  minSessionsPerHarness: 10,
  minPrecision: 0.98,
  minRecall: 0.9,
  maxUnsafeOrInvalid: 0,
} as const;

export const day = 86_400_000;
export const harnesses = ["pi", "opencode"] as const;
export const durableClasses = ["fact", "decision", "issue"] as const;
export const Harness = Schema.Literals(harnesses);
export const DurableClass = Schema.Literals(durableClasses);
export const Provenance = Schema.Literals(["direct_user", "other"]);

const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const AuditId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
);
const Assessment = Schema.Literals([
  "accurate",
  "false_positive",
  "unsupported",
  "secret_escape",
  "injection_escape",
  "duplicate",
  "conflict",
  "schema_error",
  "lifecycle_error",
  "override",
]);

const Coverage = Schema.Struct({
  id: digest,
  harness: Harness,
  type: DurableClass,
  provenance: Provenance,
  outcome: Schema.Literals(["missed", "abstained"]),
});

export const CaptureReport = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  project: digest,
  policy: digest,
  through: AuditId,
  assessments: Schema.Array(Schema.Struct({ id: AuditId, outcome: Assessment })).check(
    Schema.isMaxLength(capturePolicy.maxPopulation),
  ),
  reviewedSessions: Schema.Array(digest).check(Schema.isMaxLength(capturePolicy.maxPopulation)),
  coverage: Schema.Array(Coverage).check(Schema.isMaxLength(capturePolicy.maxPopulation)),
});

export type CaptureReport = typeof CaptureReport.Type;
export type Sample = {
  readonly id: string;
  readonly at: number;
  readonly harness: typeof Harness.Type;
  readonly type: typeof DurableClass.Type;
  readonly provenance: typeof Provenance.Type;
  readonly session: string;
};

let baseline: ReturnType<typeof measureCaptureCorpus> | undefined;
export function syntheticBaseline() {
  baseline ??= measureCaptureCorpus({
    manifest: validateCaptureManifest(manifest),
    sessions: [external, release, personal, recall, gotcha, sensitive, setup].map(
      validateCaptureSession,
    ),
  });
  return {
    corpusVersion: baseline.corpusVersion,
    tp: baseline.tp,
    fp: baseline.fp,
    fn: baseline.fn,
    duplicates: baseline.duplicateSuggestions,
    unsupported: baseline.unsupportedAssertions,
    passed:
      baseline.tp > 0 &&
      baseline.fp === 0 &&
      baseline.fn === 0 &&
      baseline.duplicateSuggestions === 0 &&
      baseline.unsupportedAssertions === 0,
  };
}

export function measureProjectSample(population: readonly Sample[], report: CaptureReport) {
  const reviewedSessions = new Set(report.reviewedSessions);
  const emittedSessions = new Set(population.map(({ session }) => session));
  const assessments = new Map(report.assessments.map(({ id, outcome }) => [id, outcome]));
  const covered = new Set(report.coverage.map(({ id }) => id));
  const complete =
    assessments.size === report.assessments.length &&
    covered.size === report.coverage.length &&
    assessments.size === population.length &&
    population.every(({ id }) => assessments.has(id)) &&
    reviewedSessions.size === report.reviewedSessions.length &&
    [...emittedSessions].every((session) => reviewedSessions.has(session));

  const segments = [
    { name: "overall", minimum: capturePolicy.minOverall },
    ...harnesses.map((harness) => ({
      name: harness,
      harness,
      minimum: capturePolicy.minPerHarness,
    })),
    ...durableClasses.map((type) => ({ name: type, type, minimum: capturePolicy.minPerClass })),
    ...harnesses.flatMap((harness) =>
      durableClasses.map((type) => ({
        name: harness + "/" + type,
        harness,
        type,
        minimum: capturePolicy.minPerHarnessClass,
      })),
    ),
    { name: "direct_user", provenance: "direct_user", minimum: capturePolicy.minOverall },
    { name: "other", provenance: "other", minimum: 0 },
    ...harnesses.flatMap((harness) => [
      {
        name: harness + "/direct_user",
        harness,
        provenance: "direct_user",
        minimum: capturePolicy.minPerHarness,
      },
      { name: harness + "/other", harness, provenance: "other", minimum: 0 },
    ]),
  ];
  const results = segments.map((segment) => {
    const matches = (row: Pick<Sample, "harness" | "type" | "provenance">) =>
      (!("harness" in segment) || segment.harness === row.harness) &&
      (!("type" in segment) || segment.type === row.type) &&
      (!("provenance" in segment) || segment.provenance === row.provenance);
    const rows = population.filter(matches);
    const outcomes = rows.map(({ id }) => assessments.get(id));
    const count = (outcome: typeof Assessment.Type) =>
      outcomes.filter((value) => value === outcome).length;
    const accurate = count("accurate");
    const coverage = report.coverage.filter(matches);
    const missed = coverage.filter(({ outcome }) => outcome === "missed").length;
    const abstained = coverage.length - missed;
    const bad = {
      falsePositives: rows.length - accurate,
      unsupported: count("unsupported"),
      secretEscapes: count("secret_escape"),
      injectionEscapes: count("injection_escape"),
      duplicates: count("duplicate"),
      conflicts: count("conflict"),
      schemaErrors: count("schema_error"),
      lifecycleErrors: count("lifecycle_error"),
      overrides: count("override"),
    };
    const sessions = new Set(rows.map(({ session }) => session)).size;
    const precision = rows.length ? accurate / rows.length : null;
    const recall = accurate + missed ? accurate / (accurate + missed) : null;
    const passed =
      rows.length >= segment.minimum &&
      (!("harness" in segment) ||
        "type" in segment ||
        ("provenance" in segment && segment.provenance === "other") ||
        sessions >= capturePolicy.minSessionsPerHarness) &&
      (precision === null || precision >= capturePolicy.minPrecision) &&
      (recall === null ? missed === 0 : recall >= capturePolicy.minRecall) &&
      bad.unsupported +
        bad.secretEscapes +
        bad.injectionEscapes +
        bad.duplicates +
        bad.conflicts +
        bad.schemaErrors +
        bad.lifecycleErrors +
        bad.overrides <=
        capturePolicy.maxUnsafeOrInvalid;
    return {
      name: segment.name,
      samples: rows.length,
      sessions,
      accurate,
      precision,
      recall,
      missed,
      abstained,
      ...bad,
      passed,
    };
  });
  return { complete, passed: complete && results.every(({ passed }) => passed), segments: results };
}
