import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { computeMetrics } from "../../src/benchmark/metrics.js";
import {
  buildBenchmarkJson,
  outArgError,
  runRepoBenchmark,
  serializeBenchmarkJson,
  writeBenchmarkJson,
  type RepoBenchmarkJson,
} from "../../src/benchmark/run.js";
import type { BenchmarkResult, QueryOutcome } from "../../src/benchmark/types.js";
import { engram, queryCase } from "./helpers.js";

const baselinePath = fileURLToPath(new URL("./baseline-v0.3.1.json", import.meta.url));

const outcome = (over: Partial<QueryOutcome> & { queryId: string }): QueryOutcome => ({
  rankedIds: [],
  abstained: true,
  latencyNs: 0,
  renderedChars: 0,
  ...over,
});

/** Smallest valid BenchmarkResult (same shape as run.test.ts) so writer
 * tests can build real RepoBenchmarkJson values without a corpus run. */
const fixtureResult = (): BenchmarkResult => {
  const queries = [queryCase({ id: "qx", query: "x", relevantIds: ["e1"] })];
  const outcomes = [
    outcome({
      queryId: "qx",
      rankedIds: ["e1"],
      abstained: false,
      latencyNs: 10,
      renderedChars: 3,
    }),
  ];
  const metrics = computeMetrics(queries, outcomes, [1], new Map([["e1", engram({ id: "e1" })]]));
  return {
    corpus: { name: "fixture", corpusVersion: "0.0.0-test", schemaVersion: 1 },
    config: { kValues: [1], abstainThreshold: 0 },
    outcomes,
    metrics,
  };
};

const distinctiveSource = {
  branch: "feat/eng-76-carry-check",
  integrationHead: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  pickedShas: { alpha: "0a0a0a0a", beta: "0b0b0b0b" },
  generatedWith: "test harness (ENG-76 writer test) via buildBenchmarkJson",
  note: "distinctive block, comma and unicode: café ✓",
};

let tmp = "";

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-out-writer-"));
});

afterAll(() => {
  if (tmp !== "") fs.rmSync(tmp, { recursive: true, force: true });
});

const target = (name: string): string => path.join(tmp, name);

describe("canonical serializer (ENG-76 criterion 2a)", () => {
  it("round-trips the checked-in baseline byte-identically, trailing newline included", () => {
    const bytes = fs.readFileSync(baselinePath, "utf8");
    const parsed = JSON.parse(bytes) as RepoBenchmarkJson;
    expect(serializeBenchmarkJson(parsed)).toBe(bytes);
  });

  it("inlines a primitive-array member exactly at the pinned 96-char budget and expands one char over", () => {
    // label `"kk": ` is 6 chars; bracket-inclusive content of three
    // 26-char strings is 90; 6+90=96 stays inline, one char over expands.
    const elem = "a".repeat(26);
    const at = `{\n  "kk": [${JSON.stringify(elem)}, ${JSON.stringify(elem)}, ${JSON.stringify(elem)}]\n}\n`;
    const overElem = `${elem}x`;
    const over = [
      "{",
      '  "kk": [',
      `    ${JSON.stringify(overElem)},`,
      `    ${JSON.stringify(overElem)},`,
      `    ${JSON.stringify(overElem)}`,
      "  ]",
      "}",
      "",
    ].join("\n");
    expect(serializeBenchmarkJson(JSON.parse(at))).toBe(at);
    expect(serializeBenchmarkJson(JSON.parse(over))).toBe(over);
  });

  it("always expands non-empty objects and object-element arrays, inlines empty containers", () => {
    const json = {
      empty: [] as unknown[],
      nothing: {} as Record<string, unknown>,
      tinyObjectArray: [{ a: 1 }],
    };
    const text = serializeBenchmarkJson(json);
    expect(text).toBe(
      [
        "{",
        '  "empty": [],',
        '  "nothing": {},',
        '  "tinyObjectArray": [',
        "    {",
        '      "a": 1',
        "    }",
        "  ]",
        "}",
        "",
      ].join("\n"),
    );
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("--out carry-forward (ENG-76 criteria 1 and 4)", () => {
  it("carries a distinctive source block byte-for-byte and in position", () => {
    const seed = buildBenchmarkJson(fixtureResult(), {
      contractHash: "sha256:seed",
      generatedAtUtc: "2026-09-28T00:00:00.000Z",
      source: distinctiveSource,
    });
    const seedText = serializeBenchmarkJson(seed);
    const file = target("carry.json");
    fs.writeFileSync(file, seedText);

    const fresh = buildBenchmarkJson(fixtureResult(), {
      contractHash: "sha256:seed",
      generatedAtUtc: "2026-09-28T01:00:00.000Z",
    });
    const outText = writeBenchmarkJson(fresh, file);

    // The source block survives byte-for-byte (same slice of text) and in
    // position; everything except generatedAtUtc is otherwise identical.
    const blockOf = (s: string): string =>
      s.slice(s.indexOf('"source": {'), s.indexOf('\n  "config"'));
    expect(blockOf(outText)).toBe(blockOf(seedText));
    const normalize = (s: string): string =>
      s.replace(/"generatedAtUtc": "[^"]*"/, '"generatedAtUtc": "X"');
    expect(normalize(outText)).toBe(normalize(seedText));
    expect(outText.indexOf('"contractHash"')).toBeLessThan(outText.indexOf('"source"'));
    expect(outText.indexOf('"source"')).toBeLessThan(outText.indexOf('"config"'));
  });

  it("carries source even when the target lacks the benchmark discriminator", () => {
    const file = target("no-discriminator.json");
    fs.writeFileSync(file, '{\n  "hello": "world",\n  "source": { "branch": "carried" }\n}\n');
    const json = buildBenchmarkJson(fixtureResult(), {
      contractHash: "sha256:x",
      generatedAtUtc: "2026-09-28T00:00:00.000Z",
    });
    const outText = writeBenchmarkJson(json, file);
    expect(outText).toContain('"source": {');
    expect(outText).toContain('"branch": "carried"');
  });

  it("carries an empty plain-object source block", () => {
    const file = target("empty-source.json");
    fs.writeFileSync(file, '{"source": {}}');
    const json = buildBenchmarkJson(fixtureResult(), {
      contractHash: "sha256:x",
      generatedAtUtc: "2026-09-28T00:00:00.000Z",
    });
    const outText = writeBenchmarkJson(json, file);
    expect(outText).toContain('"source": {}');
  });

  it.each([
    ["source-is-string", '{"source": "x"}'],
    ["source-is-array", '{"source": [1, 2]}'],
    ["source-is-number", '{"source": 42}'],
    ["source-is-null", '{"source": null}'],
    ["unparseable-target", "{ not json"],
    ["empty-file", ""],
    ["json-array", "[1, 2, 3]"],
    ["json-number", "42"],
    ["json-string", '"text"'],
    ["json-null", "null"],
  ])("omits silently for %s", (name, seedText) => {
    const file = target(`malformed-${name}.json`);
    fs.writeFileSync(file, seedText);
    const json = buildBenchmarkJson(fixtureResult(), {
      contractHash: "sha256:x",
      generatedAtUtc: "2026-09-28T00:00:00.000Z",
    });
    const outText = writeBenchmarkJson(json, file);
    expect(outText).not.toContain('"source"');
  });

  it("produces fresh-generation output for a nonexistent target and creates the file", () => {
    const file = target("fresh-missing.json");
    const json = buildBenchmarkJson(fixtureResult(), {
      contractHash: "sha256:x",
      generatedAtUtc: "2026-09-28T00:00:00.000Z",
    });
    const outText = writeBenchmarkJson(json, file);
    expect(outText).not.toContain('"source"');
    expect(outText).toBe(serializeBenchmarkJson(json));
    expect(fs.readFileSync(file, "utf8")).toBe(outText);
  });

  it("produces fresh-generation output for a parseable target without source", () => {
    const file = target("fresh-no-source.json");
    fs.writeFileSync(file, '{"config": 1}\n');
    const json = buildBenchmarkJson(fixtureResult(), {
      contractHash: "sha256:x",
      generatedAtUtc: "2026-09-28T00:00:00.000Z",
    });
    const outText = writeBenchmarkJson(json, file);
    expect(outText).not.toContain('"source"');
  });
});

describe("--out CLI argument validation (ENG-76 criterion 4, F3)", () => {
  it("keeps the exact error messages", () => {
    expect(outArgError(undefined)).toBe("--out requires a path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-out-dir-"));
    try {
      expect(outArgError(dir)).toBe(`--out points at a directory: ${dir}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(outArgError(target("does-not-exist.json"))).toBeNull();
  });
});

describe("full-regeneration identity (ENG-76 criterion 2b)", () => {
  it("regenerating over the checked-in baseline is byte-identical except generatedAtUtc", () => {
    const file = target("regen.json");
    fs.copyFileSync(baselinePath, file);
    const text = writeBenchmarkJson(runRepoBenchmark(), file);
    const normalize = (s: string): string =>
      s.replace(/"generatedAtUtc": "[^"]*"/, '"generatedAtUtc": "X"');
    expect(normalize(text)).toBe(normalize(fs.readFileSync(baselinePath, "utf8")));
  }, 240_000);
});

describe("type surface (ENG-76 criterion 5)", () => {
  it("RepoBenchmarkJson accepts emitted JSON with and without source", () => {
    const withSource: RepoBenchmarkJson = buildBenchmarkJson(fixtureResult(), {
      contractHash: "sha256:x",
      generatedAtUtc: "2026-09-28T00:00:00.000Z",
      source: distinctiveSource,
    });
    const withoutSource: RepoBenchmarkJson = buildBenchmarkJson(fixtureResult(), {
      contractHash: "sha256:x",
      generatedAtUtc: "2026-09-28T00:00:00.000Z",
    });
    expect(withSource.source).toEqual(distinctiveSource);
    expect(withoutSource.source).toBeUndefined();
  });
});
