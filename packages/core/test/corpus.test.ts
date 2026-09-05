/**
 * ENG-11 golden retrieval corpus: contract, loader, and seed validation.
 *
 * The corpus lives at the repo root under `corpus/`; the loader API takes
 * an explicit directory (no cwd dependence, no project-root discovery).
 * These tests pin both the pure validator semantics and the shipped seed
 * fixtures, so every contract violation fails loudly here instead of in a
 * downstream benchmark runner.
 */
import { describe, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORPUS_CATEGORIES,
  CORPUS_QUOTAS,
  SUPPORTED_CORPUS_SCHEMA_VERSION,
  evaluateCase,
  loadCorpus,
  validateCorpusCase,
  validateCorpusManifest,
} from "../src/corpus.js";
import type { CorpusCase } from "../src/corpus.js";
import type { Engram } from "../src/domain.js";

const CORPUS_DIR = fileURLToPath(new URL("../../../corpus/", import.meta.url));

/* ------------------------------------------------------------------ */
/* Pure validator unit tests                                           */
/* ------------------------------------------------------------------ */

const validCase = (over: Partial<CorpusCase> = {}): CorpusCase => ({
  id: "case-exact-facts-01",
  query: "metrics endpoint port",
  category: "exact-facts",
  requiredIds: ["01jwpz07000000000000000000"],
  supportingIds: [],
  forbiddenIds: [],
  scope: "project",
  applicablePaths: ["ops/observability"],
  expectEmpty: false,
  notes: "pins the metrics port fact",
  ...over,
});

const issuesOf = (over: Partial<CorpusCase>): ReadonlyArray<string> =>
  validateCorpusCase(validCase(over));

describe("validateCorpusCase", () => {
  it("accepts a fully valid case", () => {
    expect(validateCorpusCase(validCase())).toEqual([]);
  });

  it("rejects unknown fields (typos must not pass silently)", () => {
    const raw = validCase() as unknown as Record<string, unknown>;
    raw.requiredId = ["x"];
    expect(validateCorpusCase(raw as unknown as CorpusCase).length).toBeGreaterThan(0);
  });

  it("rejects a category outside the fixed list", () => {
    expect(issuesOf({ category: "vibes" as CorpusCase["category"] }).length).toBeGreaterThan(0);
  });

  it("rejects an id that does not follow case-<category>-<nn>", () => {
    expect(issuesOf({ id: "exact-facts-01" }).length).toBeGreaterThan(0);
    expect(issuesOf({ id: "case-paraphrase-01" }).length).toBeGreaterThan(0); // category mismatch
    expect(issuesOf({ id: "case-exact-facts-1" }).length).toBeGreaterThan(0);
  });

  it("keeps required, supporting, and forbidden disjoint", () => {
    expect(issuesOf({ forbiddenIds: ["01jwpz07000000000000000000"] }).length).toBeGreaterThan(0);
    expect(issuesOf({ supportingIds: ["01jwpz07000000000000000000"] }).length).toBeGreaterThan(0);
  });

  it("rejects duplicate ids inside one list", () => {
    expect(
      issuesOf({ supportingIds: ["01jwpz07000000000000000000", "01jwpz07000000000000000000"] })
        .length,
    ).toBeGreaterThan(0);
  });

  it("ties expectEmpty to the abstention category in both directions", () => {
    expect(issuesOf({ category: "abstention", expectEmpty: false }).length).toBeGreaterThan(0);
    expect(issuesOf({ expectEmpty: true }).length).toBeGreaterThan(0);
  });

  it("abstention cases must have empty required and supporting ids", () => {
    expect(
      issuesOf({
        category: "abstention",
        expectEmpty: true,
        requiredIds: ["01jwpz07000000000000000000"],
      }).length,
    ).toBeGreaterThan(0);
    expect(
      issuesOf({
        category: "abstention",
        expectEmpty: true,
        supportingIds: ["01jwpz07000000000000000000"],
      }).length,
    ).toBeGreaterThan(0);
  });

  it("allows duplicateOf only inside the ambiguity category", () => {
    expect(
      validateCorpusCase(
        validCase({
          category: "ambiguity",
          id: "case-ambiguity-01",
          duplicateOf: "case-ambiguity-02",
        }),
      ),
    ).toEqual([]);
    expect(issuesOf({ duplicateOf: "case-exact-facts-02" }).length).toBeGreaterThan(0);
  });

  it("rejects self-referencing duplicateOf", () => {
    expect(
      validateCorpusCase(
        validCase({
          category: "ambiguity",
          id: "case-ambiguity-01",
          duplicateOf: "case-ambiguity-01",
        }),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("enforces the applicablePaths grammar", () => {
    expect(issuesOf({ applicablePaths: ["/core"] }).length).toBeGreaterThan(0);
    expect(issuesOf({ applicablePaths: ["core/"] }).length).toBeGreaterThan(0);
    expect(issuesOf({ applicablePaths: ["Core/Parser"] }).length).toBeGreaterThan(0);
    expect(issuesOf({ applicablePaths: ["core//parser"] }).length).toBeGreaterThan(0);
    expect(issuesOf({ applicablePaths: [] }).length).toBeGreaterThan(0);
    expect(
      validateCorpusCase(validCase({ applicablePaths: ["core/parser", "cli-commands"] })),
    ).toEqual([]);
  });

  it("requires a positive integer limit when present", () => {
    expect(issuesOf({ limit: 0 }).length).toBeGreaterThan(0);
    expect(issuesOf({ limit: 1.5 }).length).toBeGreaterThan(0);
    expect(validateCorpusCase(validCase({ limit: 5 }))).toEqual([]);
  });

  it("rejects a vacuous non-abstention case with empty requiredIds", () => {
    expect(issuesOf({ requiredIds: [] }).length).toBeGreaterThan(0);
  });

  it("requires ISO timestamps with zone for now", () => {
    expect(issuesOf({ now: "2026-06-01" }).length).toBeGreaterThan(0);
    expect(issuesOf({ now: "2026-06-01T00:00:00Z" }).length).toBe(0);
  });
});

describe("validateCorpusManifest", () => {
  const validManifest = {
    schemaVersion: 1,
    corpusVersion: "0.1.0",
    name: "mothlight-retrieval-corpus",
    description: "Golden retrieval corpus for the fictional mothlight project.",
    defaultNow: "2026-06-01T00:00:00.000Z",
  };

  it("accepts a valid manifest", () => {
    expect(validateCorpusManifest(validManifest)).toEqual([]);
  });

  it("rejects an unsupported schemaVersion", () => {
    const messages = validateCorpusManifest({ ...validManifest, schemaVersion: 2 });
    expect(messages.join("\n")).toMatch(/unsupported/i);
    expect(messages.join("\n")).toMatch(String(SUPPORTED_CORPUS_SCHEMA_VERSION));
  });

  it("rejects a non-semver corpusVersion", () => {
    expect(
      validateCorpusManifest({ ...validManifest, corpusVersion: "1.0" }).length,
    ).toBeGreaterThan(0);
  });

  it("rejects unknown fields and bad defaultNow", () => {
    const raw = { ...validManifest, extra: true };
    expect(validateCorpusManifest(raw).length).toBeGreaterThan(0);
    expect(
      validateCorpusManifest({ ...validManifest, defaultNow: "2026-06-01" }).length,
    ).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Shipped seed fixtures                                               */
/* ------------------------------------------------------------------ */

const corpus = loadCorpus(CORPUS_DIR);
const corpusAgain = loadCorpus(CORPUS_DIR);
const engramIds = new Set(corpus.engrams.map((e) => e.engram.id));
const engrams = corpus.engrams.map((e) => e.engram);

const perCategory = (): Map<string, number> => {
  const counts = new Map<string, number>(CORPUS_CATEGORIES.map((c) => [c, 0]));
  for (const c of corpus.cases) counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
  return counts;
};

describe("corpus fixtures: manifest", () => {
  it("loads a manifest at the supported schema version", () => {
    expect(corpus.manifest).toBeDefined();
    expect(corpus.manifest?.schemaVersion).toBe(SUPPORTED_CORPUS_SCHEMA_VERSION);
    expect(corpus.manifest?.corpusVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(corpus.manifest?.defaultNow).toBeDefined();
  });

  it("loader rejects a manifest whose schemaVersion differs from the supported one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "engram-corpus-test-"));
    try {
      mkdirSync(path.join(dir, "engrams"), { recursive: true });
      mkdirSync(path.join(dir, "cases"), { recursive: true });
      writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({
          schemaVersion: SUPPORTED_CORPUS_SCHEMA_VERSION + 1,
          corpusVersion: "9.9.9",
          name: "bad",
          description: "bad",
        }),
      );
      const loaded = loadCorpus(dir);
      expect(loaded.issues.map((i) => i.message).join("\n")).toMatch(/unsupported/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("corpus fixtures: engram files", () => {
  it("loads at least 20 fixture engrams with zero issues", () => {
    expect(corpus.engrams.length).toBeGreaterThanOrEqual(20);
    expect(corpus.issues).toEqual([]);
  });

  it("fixture ids are unique and valid", () => {
    expect(engramIds.size).toBe(corpus.engrams.length);
  });

  it("every fixture passes the same validation the store scan uses", () => {
    // loadCorpus runs validateEntry plus the filename/duplicate/supersedes
    // cross-checks; a non-empty issue list fails above. Assert the
    // cross-check inputs directly so the guarantee is visible here too.
    for (const e of engrams) {
      expect(e.id).toMatch(/^([0-9]{4}|[0-9a-hjkmnp-tv-z]{26})$/);
      expect(e.path).toMatch(new RegExp(`${e.id}-[^/]+\\.md$`));
    }
  });

  it("no fixture supersedes a missing id", () => {
    for (const e of engrams) {
      if (e.supersedes !== undefined) {
        expect(engramIds.has(e.supersedes), `${e.id} supersedes missing ${e.supersedes}`).toBe(
          true,
        );
      }
    }
  });

  it("fixtures exist in both scopes", () => {
    expect(engrams.some((e) => e.scope === "personal")).toBe(true);
    expect(engrams.some((e) => e.scope === "project")).toBe(true);
  });
});

describe("corpus fixtures: case files", () => {
  it("loads at least 15 seed cases with zero issues", () => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(15);
    expect(corpus.issues).toEqual([]);
  });

  it("case ids are unique and follow the convention", () => {
    const ids = corpus.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("queries are unique except duplicateOf pairs inside ambiguity", () => {
    const byQuery = new Map<string, number>();
    for (const c of corpus.cases) byQuery.set(c.query, (byQuery.get(c.query) ?? 0) + 1);
    for (const [query, count] of byQuery) {
      if (count < 2) continue;
      const members = corpus.cases.filter((c) => c.query === query);
      for (const c of members) {
        expect(c.category, `${c.id} duplicates a query outside ambiguity`).toBe("ambiguity");
      }
      const canonicals = members.filter((c) => c.duplicateOf === undefined);
      expect(
        canonicals.length,
        `query ${JSON.stringify(query)} must have exactly one canonical case`,
      ).toBe(1);
    }
    expect(byQuery.size).toBeLessThan(corpus.cases.length); // the pair exists
  });

  it("every referenced id resolves to a fixture engram", () => {
    for (const c of corpus.cases) {
      for (const id of [...c.requiredIds, ...c.supportingIds, ...c.forbiddenIds]) {
        expect(engramIds.has(id), `${c.id} references missing engram ${id}`).toBe(true);
      }
    }
  });

  it("every referenced id matches the case scope", () => {
    const scopeById = new Map(engrams.map((e) => [e.id, e.scope]));
    for (const c of corpus.cases) {
      for (const id of [...c.requiredIds, ...c.supportingIds, ...c.forbiddenIds]) {
        expect(scopeById.get(id), `${c.id} references ${id} across scopes`).toBe(c.scope);
      }
    }
  });

  it("covers all 10 categories with at least one case each", () => {
    const counts = perCategory();
    for (const category of CORPUS_CATEGORIES) {
      expect(counts.get(category) ?? 0, `category ${category} missing`).toBeGreaterThanOrEqual(1);
    }
  });

  it("has at least 5 cases beyond the 10 category representatives", () => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(15);
  });

  it("abstention cases expect empty results with empty required and supporting ids", () => {
    const abstention = corpus.cases.filter((c) => c.category === "abstention");
    expect(abstention.length).toBeGreaterThanOrEqual(1);
    for (const c of abstention) {
      expect(c.expectEmpty).toBe(true);
      expect(c.requiredIds).toEqual([]);
      expect(c.supportingIds).toEqual([]);
    }
  });

  it("includes at least one personal-scope case", () => {
    expect(corpus.cases.some((c) => c.scope === "personal")).toBe(true);
  });

  it("pins both superseded visibility modes", () => {
    const superseded = corpus.cases.filter((c) => c.category === "superseded");
    expect(superseded.some((c) => c.includeInactive === true)).toBe(true);
    expect(superseded.some((c) => c.includeInactive !== true)).toBe(true);
  });

  it("loading the corpus twice yields deep-equal output", () => {
    expect(corpusAgain).toEqual(corpus);
  });
});

describe("corpus fixtures: loader cross-checks", () => {
  it("loader rejects duplicate case ids across files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "engram-corpus-dup-"));
    try {
      mkdirSync(path.join(dir, "engrams"));
      mkdirSync(path.join(dir, "cases"));
      writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({
          schemaVersion: SUPPORTED_CORPUS_SCHEMA_VERSION,
          corpusVersion: "0.3.0",
          name: "dup-check",
          description: "dup-check",
        }),
      );
      const body = {
        id: "case-exact-facts-01",
        query: "q one",
        category: "exact-facts",
        requiredIds: ["0001"],
        supportingIds: [],
        forbiddenIds: [],
        scope: "project",
        applicablePaths: ["x/y"],
        expectEmpty: false,
        notes: "dup probe",
      };
      writeFileSync(path.join(dir, "cases", "case-exact-facts-01.json"), JSON.stringify(body));
      writeFileSync(
        path.join(dir, "cases", "case-exact-facts-01-copy.json"),
        JSON.stringify({ ...body, query: "q two" }),
      );
      const loaded = loadCorpus(dir);
      expect(loaded.issues.map((i) => i.message).join("\n")).toMatch(/duplicate_case_id/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("evaluateCase mechanics (small fixtures, no corpus)", () => {
  const mem = (over: Partial<Engram> & { id: string }): Engram => ({
    title: over.id,
    type: "note",
    tags: [],
    scope: "project",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    author: undefined,
    pinned: false,
    body: "",
    path: "",
    ...over,
  });
  const fixtures = [
    mem({ id: "u1", title: "Project cache notes", tags: ["cache"], body: "shard cache files" }),
    mem({
      id: "u2",
      title: "Personal cache notes",
      tags: ["cache"],
      scope: "personal",
      body: "shard cache files",
    }),
    mem({
      id: "u3",
      title: "Retired cache decision",
      tags: ["cache"],
      status: "superseded",
      body: "old shard cache files",
    }),
    mem({
      id: "u4",
      title: "Expired cache fact",
      tags: ["cache"],
      body: "expired shard cache files",
      expires: "2026-02-01T00:00:00.000Z",
    }),
  ];
  const probe = (over: Partial<CorpusCase>): CorpusCase => ({
    id: "case-multi-token-01",
    query: "cache",
    category: "multi-token",
    requiredIds: [],
    supportingIds: [],
    forbiddenIds: [],
    scope: "project",
    applicablePaths: ["x/y"],
    expectEmpty: false,
    notes: "unit probe",
    ...over,
  });
  const ids = (results: ReturnType<typeof evaluateCase>): string[] =>
    results.map((r) => r.engram.id);

  it("filters candidates to the case scope", () => {
    expect(
      ids(
        evaluateCase(
          fixtures,
          probe({ scope: "personal" }),
          Date.parse("2026-06-01T00:00:00.000Z"),
        ),
      ),
    ).toEqual(["u2"]);
  });

  it("honors the fixed now for time-derived expiry", () => {
    const before = ids(evaluateCase(fixtures, probe({}), Date.parse("2026-01-15T00:00:00.000Z")));
    const after = ids(evaluateCase(fixtures, probe({}), Date.parse("2026-06-01T00:00:00.000Z")));
    expect(before).toContain("u4");
    expect(after).not.toContain("u4");
  });

  it("includeInactive re-includes superseded entries", () => {
    const withInactive = ids(
      evaluateCase(
        fixtures,
        probe({ includeInactive: true }),
        Date.parse("2026-06-01T00:00:00.000Z"),
      ),
    );
    expect(withInactive).toContain("u3");
  });

  it("limit truncates deterministically", () => {
    const caseWithLimit = probe({ limit: 2, includeInactive: true });
    const first = evaluateCase(fixtures, caseWithLimit, Date.parse("2026-01-15T00:00:00.000Z"));
    const second = evaluateCase(fixtures, caseWithLimit, Date.parse("2026-01-15T00:00:00.000Z"));
    expect(first).toEqual(second);
    expect(first.length).toBe(2);
  });
});

describe("corpus fixtures: counts", () => {
  it("reports seed and per-category counts", () => {
    const counts = perCategory();
    console.log(
      `[corpus] corpus scale: ${corpus.cases.length} cases, ${corpus.engrams.length} engram fixtures, ` +
        `corpusVersion ${corpus.manifest?.corpusVersion}`,
    );
    for (const category of CORPUS_CATEGORIES) {
      console.log(`[corpus] category ${category}: ${counts.get(category)} case(s)`);
    }
    expect(counts.size).toBe(CORPUS_CATEGORIES.length);
  });
});

describe("corpus fixtures: snapshot identity", () => {
  /** The recorded snapshot hash per the README "Snapshot identity"
   * recipe: sha256 over manifest.json, every cases/*.json, every
   * engrams/*.md in code-unit lexicographic path order, fed as
   * <relpath>\n<byte length>\n<bytes>. Any byte change to the corpus
   * requires updating this constant in the same reviewed change. */
  const RECORDED_SNAPSHOT_SHA256 =
    "a44acee44bc1c6658635ce265432a31f2cb0aa235906410ca94def1437adf09b";

  const snapshotHash = (dir: string): string => {
    const entries: Array<{ rel: string; bytes: Buffer }> = [
      { rel: "manifest.json", bytes: readFileSync(path.join(dir, "manifest.json")) },
    ];
    for (const sub of ["cases", "engrams"]) {
      for (const name of readdirSync(path.join(dir, sub)).sort()) {
        entries.push({
          rel: `${sub}/${name}`,
          bytes: readFileSync(path.join(dir, sub, name)),
        });
      }
    }
    entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const hash = createHash("sha256");
    for (const { rel, bytes } of entries) {
      hash.update(`${rel}\n${bytes.length}\n`);
      hash.update(bytes);
    }
    return hash.digest("hex");
  };

  it("recomputes the recorded snapshot hash", () => {
    const hash = snapshotHash(CORPUS_DIR);
    console.log(`[corpus] snapshot sha256: ${hash}`);
    expect(hash).toBe(RECORDED_SNAPSHOT_SHA256);
  });
});

describe("corpus fixtures: binding quotas (turn 2)", () => {
  it("meets the per-category quota floor and the quota-sum total", () => {
    const counts = perCategory();
    const shortfalls: string[] = [];
    for (const category of CORPUS_CATEGORIES) {
      const quota = CORPUS_QUOTAS[category];
      const have = counts.get(category) ?? 0;
      if (have < quota) shortfalls.push(`${category}: ${have}/${quota}`);
    }
    const quotaSum = CORPUS_CATEGORIES.reduce((sum, c) => sum + CORPUS_QUOTAS[c], 0);
    if (corpus.cases.length < quotaSum) {
      shortfalls.push(`total: ${corpus.cases.length}/${quotaSum}`);
    }
    console.log(
      shortfalls.length === 0
        ? `[corpus] quotas met: ${corpus.cases.length} cases (floor ${quotaSum})`
        : `[corpus] quota shortfalls: ${shortfalls.join(", ")}`,
    );
    expect(shortfalls, "per-category quota shortfalls").toEqual([]);
  });
});
