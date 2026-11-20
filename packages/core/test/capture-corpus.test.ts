import { describe, expect, it } from "vite-plus/test";
import { fileURLToPath } from "node:url";
import { loadCaptureCorpus, scoreCapture, validateCaptureSession } from "../src/capture-corpus.js";

const root = fileURLToPath(new URL("../../../corpus/capture/", import.meta.url));

describe("capture evaluation corpus", () => {
  it("loads the synthetic snapshot deterministically with diverse labels", () => {
    const corpus = loadCaptureCorpus(root);
    expect(corpus).toEqual(loadCaptureCorpus(root));
    expect(corpus.manifest).toMatchObject({ schemaVersion: 1, corpusVersion: "1.0.0" });
    expect(new Set(corpus.sessions.flatMap((s) => s.expected.map((e) => e.signal)))).toEqual(
      new Set(["remember", "correction", "decision", "gotcha", "convention", "environment"]),
    );
    expect(new Set(corpus.sessions.flatMap((s) => s.rejected.map((e) => e.reason)))).toEqual(
      new Set([
        "progress",
        "speculation",
        "tool-output",
        "recalled",
        "external",
        "injection",
        "secret",
        "duplicate",
      ]),
    );
    expect(corpus.sessions.filter((s) => !s.expected.length)).toHaveLength(3);
    expect(corpus.sessions.some((s) => s.expected.length > 1 && s.rejected.length > 0)).toBe(true);
    expect(corpus.sessions.flatMap((s) => s.expected.flatMap((e) => e.conflicts))).toHaveLength(1);
  });

  it("rejects unsupported provenance, cross-references, and unlabelled items", () => {
    const session = loadCaptureCorpus(root).sessions.find((s) => s.id === "mixed-release")!;
    const [label] = session.expected;
    expect(() =>
      validateCaptureSession({
        ...session,
        expected: [
          { ...label, evidence: [{ messageId: label.evidence[0].messageId, origin: "external" }] },
        ],
      }),
    ).toThrow(/provenance/);
    expect(() =>
      validateCaptureSession({
        ...session,
        expected: [{ ...label, conflicts: ["missing"] }],
      }),
    ).toThrow(/existing memory/);
    expect(() => validateCaptureSession({ ...session, rejected: [] })).toThrow(/unlabelled/);
  });

  it("scores incomplete evidence, scope errors, repeats and abstentions", () => {
    const { sessions } = loadCaptureCorpus(root);
    const session = sessions.find((s) => s.id === "repeated-gotcha")!;
    const [label] = session.expected;
    const proposal = { candidateId: label.id, scope: label.scope, evidence: label.evidence };
    const empty = sessions.find((s) => s.id === "external-injection")!;
    const unrelated = { candidateId: null, scope: label.scope, evidence: [] };
    const result = scoreCapture([session, empty], {
      [session.id]: [
        { ...proposal, evidence: proposal.evidence.slice(0, 1) },
        { ...proposal, evidence: proposal.evidence.map((ref) => ({ ...ref, origin: "external" })) },
        { ...proposal, scope: "personal" },
        proposal,
        proposal,
      ],
      [empty.id]: [unrelated],
    });
    expect(result).toEqual({ tp: 1, fp: 5, fn: 0, precision: 1 / 6, recall: 1 });
    expect(scoreCapture([session], { [session.id]: [{ ...proposal, evidence: [] }] })).toEqual({
      tp: 0,
      fp: 1,
      fn: 1,
      precision: 0,
      recall: 0,
    });
    expect(scoreCapture([empty], {})).toEqual({
      tp: 0,
      fp: 0,
      fn: 0,
      precision: null,
      recall: null,
    });
    expect(() => scoreCapture([empty], { typo: [] })).toThrow(/unknown session/);
  });
});
