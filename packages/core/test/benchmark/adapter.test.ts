import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { ContractCorpusAdapter, renderEntry } from "../../src/benchmark/adapter.js";
import type { LoadedCorpusMirror } from "../../src/benchmark/types.js";
import { DEFAULT_NOW_MS, loadFixtureRaw } from "./helpers.js";

const fixturePath = fileURLToPath(
  new URL("../fixtures/benchmark/benchmark-eval-fixture.json", import.meta.url),
);

const readFixture = (): Record<string, unknown> =>
  JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;

/** Build a LoadedCorpusMirror-shaped object from the raw fixture (the real
 * loadCorpus output has this shape; the adapter is the consumer). */
const asLoaded = (raw: unknown): LoadedCorpusMirror => {
  const f = raw as {
    manifest: LoadedCorpusMirror["manifest"];
    engrams: LoadedCorpusMirror["engrams"];
    cases: LoadedCorpusMirror["cases"];
  };
  return { manifest: f.manifest, engrams: f.engrams, cases: f.cases, issues: [] };
};

describe("fixture contract", () => {
  it("README marks the fixture as synthetic and not the golden corpus", () => {
    const readme = readFileSync(
      fileURLToPath(new URL("../fixtures/benchmark/README.md", import.meta.url)),
      "utf8",
    );
    expect(readme.split("\n")[0]).toBe(
      "Synthetic benchmark-internal fixture for runner and metric tests; NOT the golden corpus.",
    );
  });

  it("is not the golden corpus (different name and version)", () => {
    const raw = readFixture();
    const manifest = raw["manifest"] as Record<string, unknown>;
    expect(manifest["name"]).toBe("benchmark-internal-eval-fixture");
    expect(manifest["corpusVersion"]).toBe("0.0.1");
    expect(manifest["schemaVersion"]).toBe(1);
    expect(manifest["defaultNow"]).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("ContractCorpusAdapter", () => {
  it("maps the loaded corpus into canonical runner input", () => {
    const adapter = new ContractCorpusAdapter(asLoaded(loadFixtureRaw()));
    const input = adapter.toRunInput();
    expect(input.entries).toHaveLength(11);
    expect(input.queries).toHaveLength(10);
    expect(input.queries.map((q) => q.id)).toEqual([
      "case-abstention-01",
      "case-ambiguity-01",
      "case-ambiguity-02",
      "case-distractors-01",
      "case-exact-facts-01",
      "case-paraphrase-01",
      "case-superseded-01",
      "case-superseded-02",
      "case-temporal-01",
      "case-temporal-02",
    ]);
    expect(input.meta).toEqual({
      name: "benchmark-internal-eval-fixture",
      corpusVersion: "0.0.1",
      schemaVersion: 1,
    });
    expect(input.defaultNowMs).toBe(DEFAULT_NOW_MS);
    // entries sorted id-ascending, mixed id shapes (0001 < 0002 < 01js...)
    expect(input.entries.map((e) => e.id)[0]).toBe("0001");
    expect(input.entries.map((e) => e.id)[1]).toBe("0002");
    expect(input.entries.map((e) => e.id)[2]).toBe("01js9x5e0000000000000000aa");
  });

  it("maps requiredIds -> relevantIds, expectEmpty -> expectAbstain, keeps supportingIds", () => {
    const adapter = new ContractCorpusAdapter(asLoaded(loadFixtureRaw()));
    const input = adapter.toRunInput();
    const sup = input.queries.find((q) => q.id === "case-superseded-01");
    expect([...(sup?.relevantIds ?? [])]).toEqual(["01js9x5e0000000000000000ab"]);
    expect([...(sup?.forbiddenIds ?? [])]).toEqual(["01js9x5e0000000000000000aa"]);
    expect([...(sup?.supportingIds ?? [])]).toEqual([]);
    expect(sup?.expectAbstain).toBe(false);
    expect(sup?.category).toBe("superseded");
    expect(sup?.scope).toBe("project");
    const amb2 = input.queries.find((q) => q.id === "case-ambiguity-02");
    expect([...(amb2?.supportingIds ?? [])]).toEqual(["01js9x5e0000000000000000ac"]);
    const abstain = input.queries.find((q) => q.id === "case-abstention-01");
    expect(abstain?.relevantIds).toEqual([]);
    expect(abstain?.expectAbstain).toBe(true);
  });

  it("resolves nowMs from case.now, else from manifest.defaultNow", () => {
    const adapter = new ContractCorpusAdapter(asLoaded(loadFixtureRaw()));
    const input = adapter.toRunInput();
    const temporal = input.queries.find((q) => q.id === "case-temporal-01");
    expect(temporal?.nowMs).toBe(Date.parse("2026-03-15T00:00:00.000Z"));
    const exact = input.queries.find((q) => q.id === "case-exact-facts-01");
    expect(exact?.nowMs).toBe(DEFAULT_NOW_MS);
  });

  it("keeps the source mirror case for the injected evaluate fn", () => {
    const adapter = new ContractCorpusAdapter(asLoaded(loadFixtureRaw()));
    const input = adapter.toRunInput();
    const inc = input.queries.find((q) => q.id === "case-superseded-02");
    expect(inc?.source.includeInactive).toBe(true);
    expect(inc?.source.limit).toBeUndefined();
    expect(inc?.source.query).toBe("esbuild speed");
  });

  it("load() returns the exact payload it was built with", () => {
    const loaded = asLoaded(loadFixtureRaw());
    const adapter = new ContractCorpusAdapter(loaded);
    expect(adapter.load()).toBe(loaded);
  });

  it("refuses evaluation when issues exist (deterministic full list)", () => {
    const loaded = asLoaded(loadFixtureRaw());
    const broken: LoadedCorpusMirror = {
      ...loaded,
      issues: [
        { file: "cases/b.json", message: "zeta defect" },
        { file: "cases/a.json", message: "alpha defect" },
      ],
    };
    // Sorts by file then message, full list, no truncation (ruling Q2).
    expect(() => new ContractCorpusAdapter(broken).toRunInput()).toThrow(
      /2 issue\(s\).*cases\/a\.json: alpha defect.*cases\/b\.json: zeta defect/s,
    );
  });

  it("refuses a corpus without a manifest", () => {
    const loaded = asLoaded(loadFixtureRaw());
    expect(() =>
      new ContractCorpusAdapter({ ...loaded, manifest: undefined }).toRunInput(),
    ).toThrow(/manifest/);
  });

  it("refuses a case with no resolvable instant instead of reading the wall clock", () => {
    const loaded = asLoaded(loadFixtureRaw());
    const noDefault: LoadedCorpusMirror = {
      ...loaded,
      manifest: { ...loaded.manifest!, defaultNow: undefined },
    };
    expect(() => new ContractCorpusAdapter(noDefault).toRunInput()).toThrow(
      /case-exact-facts-01.*no fixed timestamp/,
    );
  });

  it("rejects duplicate entry or case ids defensively", () => {
    const loaded = asLoaded(loadFixtureRaw());
    const dupEntry: LoadedCorpusMirror = {
      ...loaded,
      engrams: [...loaded.engrams, loaded.engrams[0]!],
    };
    expect(() => new ContractCorpusAdapter(dupEntry).toRunInput()).toThrow(/duplicate entry id/);
    const dupCase: LoadedCorpusMirror = {
      ...loaded,
      cases: [...loaded.cases, loaded.cases[0]!],
    };
    expect(() => new ContractCorpusAdapter(dupCase).toRunInput()).toThrow(/duplicate case id/);
  });
});

describe("renderEntry (benchmark-owned consumer rule)", () => {
  it("joins title, body, and tags deterministically", () => {
    const adapter = new ContractCorpusAdapter(asLoaded(loadFixtureRaw()));
    const input = adapter.toRunInput();
    const ac = input.entries.find((e) => e.id === "01js9x5e0000000000000000ac");
    expect(renderEntry(ac!)).toBe("Page cache\nthe page cache stores rendered html\ncache");
    expect(renderEntry(ac!).length).toBe(52); // 10 + 1 + 35 + 1 + 5
  });
});
