import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { captureFingerprint } from "../../../scripts/capture-fingerprint.js";
import fingerprint from "../src/capture-fingerprint.json" with { type: "json" };
import { loadCaptureCorpus } from "../src/capture-corpus.js";
import { measureCaptureCorpus } from "../src/capture-score.js";
import {
  durableClasses,
  harnesses,
  measureProjectSample,
  syntheticBaseline,
  type CaptureReport,
  type Sample,
} from "../src/capture-policy.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const samples: Sample[] = harnesses.flatMap((harness) =>
  Array.from({ length: 10 }, (_, index) =>
    durableClasses.map((type) => ({
      id: randomUUID(),
      at: 0,
      harness,
      type,
      provenance: "direct_user" as const,
      session: hash(harness + index),
    })),
  ).flat(),
);
const reportFor = (rows: readonly Sample[]): CaptureReport => ({
  schemaVersion: 1,
  project: hash("project"),
  policy: hash("policy"),
  through: rows.at(-1)!.id,
  assessments: rows.map(({ id }) => ({ id, outcome: "accurate" })),
  reviewedSessions: [...new Set(rows.map(({ session }) => session))],
  coverage: [],
});

describe("project capture evidence", () => {
  it("pins the implementation and scores the embedded corpus against the checked-in benchmark", () => {
    expect(fingerprint.fingerprint).toBe(captureFingerprint());
    const directory = fileURLToPath(new URL("../../../corpus/capture/", import.meta.url));
    const corpus = measureCaptureCorpus(loadCaptureCorpus(directory));
    expect(syntheticBaseline()).toEqual({
      corpusVersion: corpus.corpusVersion,
      tp: corpus.tp,
      fp: corpus.fp,
      fn: corpus.fn,
      duplicates: corpus.duplicateSuggestions,
      unsupported: corpus.unsupportedAssertions,
      passed: true,
    });
  });

  it("requires full review coverage, diversity, and the minimum counts in every segment", () => {
    expect(measureProjectSample(samples, reportFor(samples)).passed).toBe(true);
    const small = samples.slice(0, 59);
    expect(measureProjectSample(small, reportFor(small)).passed).toBe(false);
    const report = reportFor(samples);
    expect(
      measureProjectSample(samples, {
        ...report,
        reviewedSessions: report.reviewedSessions.slice(1),
      }).complete,
    ).toBe(false);
    expect(
      measureProjectSample(samples, {
        ...report,
        assessments: [...report.assessments.slice(1), report.assessments.at(-1)!],
      }).complete,
    ).toBe(false);
    const oneSession = samples.map((row) => ({ ...row, session: hash(row.harness) }));
    expect(measureProjectSample(oneSession, reportFor(oneSession)).passed).toBe(false);
  });

  it("fails when overall precision passes but a harness or content class falls below the threshold", () => {
    const report = reportFor(samples);
    const score = measureProjectSample(samples, {
      ...report,
      assessments: report.assessments.map((row, index) =>
        index === 0 ? { ...row, outcome: "false_positive" } : row,
      ),
    });
    expect(score.segments.find(({ name }) => name === "overall")?.passed).toBe(true);
    expect(score.segments.find(({ name }) => name === "pi/fact")?.passed).toBe(false);
    expect(score.passed).toBe(false);
  });

  it.each([
    "unsupported",
    "secret_escape",
    "injection_escape",
    "duplicate",
    "conflict",
    "schema_error",
    "lifecycle_error",
    "override",
  ] as const)("requires zero %s outcomes", (outcome) => {
    const report = reportFor(samples);
    const score = measureProjectSample(samples, {
      ...report,
      assessments: [{ id: samples[0].id, outcome }, ...report.assessments.slice(1)],
    });
    expect(score.segments.find(({ name }) => name === "overall")?.passed).toBe(false);
  });

  it("reports abstentions and misses separately and gates recall", () => {
    const score = measureProjectSample(samples, {
      ...reportFor(samples),
      coverage: Array.from({ length: 3 }, (_, index) => ({
        id: hash("coverage-" + index),
        harness: "pi",
        type: "fact",
        provenance: "direct_user",
        outcome: index === 0 ? "abstained" : "missed",
      })),
    });
    expect(score.segments.find(({ name }) => name === "pi/fact")).toMatchObject({
      abstained: 1,
      missed: 2,
      passed: false,
    });
    expect(score.passed).toBe(false);
  });
});
