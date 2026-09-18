import { describe, expect, it } from "vite-plus/test";
import type { Engram } from "../src/domain.js";
import { searchEngrams } from "../src/search.js";
import { searchReport } from "../src/search-output.js";

const entry = (over: Partial<Engram> = {}): Engram => ({
  id: "0001",
  title: "Café note",
  type: "note",
  tags: ["cafe"],
  scope: "project",
  created: "2026-01-01T00:00:00.000Z",
  updated: "2026-01-01T00:00:00.000Z",
  pinned: true,
  author: "private author",
  schemaVersion: 1,
  body: "cafe PRIVATE_BODY",
  path: "/private/location",
  sourceType: "other",
  sourceRef: "PRIVATE_SOURCE",
  ...over,
});

describe("search explanations and public reports", () => {
  it("accounts for every score contribution without exposing field contents", () => {
    const [r] = searchEngrams([entry()], "café note", undefined, { explain: true });
    const contributions = r.explanation?.contributions ?? [];
    // token-major order, fields tag/title/type/body, pinned last
    expect(contributions.map((c) => [c.field, c.token, c.component])).toEqual([
      ["tag", "cafe", "bm25"],
      ["title", "cafe", "bm25"],
      ["body", "cafe", "bm25"],
      ["title", "note", "bm25"],
      ["type", "note", "bm25"],
      ["pinned", null, "pinned"],
    ]);
    // single-entry corpus: idf = ln(4/3), tfNorm = 1/2.2, points = weight * both
    const unit = 0.1307645783871722;
    expect(contributions[0]?.score).toBeCloseTo(5 * unit, 5);
    expect(contributions[1]?.score).toBeCloseTo(3 * unit, 5);
    expect(contributions[2]?.score).toBeCloseTo(1 * unit, 5);
    expect(contributions[3]?.score).toBeCloseTo(3 * unit, 5);
    expect(contributions[4]?.score).toBeCloseTo(2 * unit, 5);
    expect(contributions[5]?.score).toBe(0.5);
    expect(r.score).toBeCloseTo(14 * unit + 0.5, 5);
    expect(contributions.reduce((s, c) => s + c.score, 0)).toBe(r.score);
    const report = searchReport([r], "café note", 0, 10);
    expect(JSON.stringify(report)).not.toMatch(
      /PRIVATE_BODY|private author|private\/location|PRIVATE_SOURCE/,
    );
    expect(report.results[0]).not.toHaveProperty("path");
    expect(report.results[0]).not.toHaveProperty("sourceRef");
  });

  it("does not change scores/ranking or default result shape", () => {
    const entries = [entry(), entry({ id: "0002", pinned: false })];
    const plain = searchEngrams(entries, "café");
    const explained = searchEngrams(entries, "café", undefined, { explain: true });
    expect(explained.map(({ explanation: _, ...r }) => r)).toEqual(plain);
    expect(plain[0]).not.toHaveProperty("explanation");
  });

  it("explains recency and pinned-only results without invented matches", () => {
    expect(searchEngrams([entry()], "!!!", undefined, { explain: true })[0].explanation).toEqual({
      mode: "recency",
      contributions: [],
    });
    expect(searchEngrams([entry()], "zzzz", undefined, { explain: true })[0].explanation).toEqual({
      mode: "relevance",
      contributions: [{ field: "pinned", token: null, score: 0.5, component: "pinned" }],
    });
  });

  it("keeps explanations deterministic through Unicode, duplicate tokens and lifecycle filtering", () => {
    const entries = [entry(), entry({ id: "0002", status: "archived" })];
    const opts = { explain: true, now: Date.parse("2026-02-01T00:00:00Z") };
    expect(searchEngrams(entries, "cafe\u0301 CAFÉ", undefined, opts)).toEqual(
      searchEngrams(entries, "café", undefined, opts),
    );
    expect(searchEngrams(entries, "cafe", 1, opts)).toHaveLength(1);
    expect(
      searchEngrams(entries, "cafe", undefined, { ...opts, includeInactive: true }),
    ).toHaveLength(2);
  });

  it("paginates scope-qualified summaries and preserves totals past the end", () => {
    const ranked = searchEngrams([entry(), entry({ scope: "personal" })], "cafe");
    const first = searchReport(ranked, "cafe", 0, 1);
    expect(first).toMatchObject({
      schemaVersion: 1,
      query: "cafe",
      total: 2,
      offset: 0,
      limit: 1,
      nextOffset: 1,
    });
    expect(first.results[0]).toMatchObject({ id: "0001", scope: "project" });
    expect(searchReport(ranked, "cafe", 1, 1).results[0].scope).toBe("personal");
    expect(searchReport(ranked, "cafe", 4, 1)).toMatchObject({
      total: 2,
      offset: 4,
      nextOffset: null,
      results: [],
    });
  });

  it.each([-1, 1.5, NaN, Infinity])("rejects invalid offsets %s", (offset) => {
    expect(() => searchReport([], "q", offset, 10)).toThrow();
  });
  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid limits %s", (limit) => {
    expect(() => searchReport([], "q", 0, limit)).toThrow();
  });
});
