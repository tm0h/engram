import { describe, it, expect } from "vite-plus/test";
import { searchEngrams } from "../src/search.js";
import { rankEntries } from "../src/rank.js";
import { parseQuery } from "../src/query.js";
import type { Engram } from "../src/domain.js";
const now = Date.parse("2026-11-16T12:00:00Z");
const entry = (id: string, extra: Partial<Engram> = {}): Engram => ({
  id,
  title: "auth convention",
  type: "decision",
  body: "",
  tags: [],
  aliases: [],
  pinned: false,
  scope: "project",
  schemaVersion: 1,
  created: "2025-01-01T00:00:00Z",
  updated: "2025-01-01T00:00:00Z",
  path: "",
  author: undefined,
  ...extra,
});
const score = (m: Engram) => searchEngrams([m], "auth", undefined, { now, explain: true })[0]!;
describe("lifecycle-aware ranking", () => {
  it("never ages active durable decisions, preferences, or facts", () => {
    for (const type of ["decision", "preference", "fact"] as const) {
      expect(score(entry("a", { type })).score).toBe(
        score(entry("a", { type, updated: new Date(now).toISOString() })).score,
      );
    }
  });
  it("gives bounded freshness only to notes and issues", () => {
    for (const type of ["note", "issue"] as const) {
      const old = score(entry("a", { type }));
      const fresh = score(entry("a", { type, updated: new Date(now).toISOString() }));
      expect(fresh.score - old.score).toBeCloseTo(0.25);
      expect(fresh.explanation?.contributions).toContainEqual({
        field: "freshness",
        component: "metadata",
        token: type,
        score: 0.25,
      });
    }
  });
  it("exposes importance and matching path adjustments without rescuing irrelevant entries", () => {
    const m = entry("a", { importance: 5, appliesTo: ["src/**"] });
    const result = searchEngrams([m], "auth", undefined, {
      now,
      explain: true,
      currentPath: "src/a.ts",
    })[0]!;
    expect(result.explanation?.contributions.map((c) => c.field)).toEqual(
      expect.arrayContaining(["importance", "applicability"]),
    );
    expect(result.explanation!.contributions.reduce((n, c) => n + c.score, 0)).toBe(result.score);
    expect(
      searchEngrams([entry("b", { title: "unrelated", importance: 5 })], "auth", undefined, {
        now,
      }),
    ).toEqual([]);
    expect(
      searchEngrams([entry("c", { status: "archived", importance: 5 })], "auth", undefined, {
        now,
      }),
    ).toEqual([]);
  });
  it("diversifies a duplicate-heavy top five without dropping required memories", () => {
    const body =
      "Always validate incoming authentication tokens before passing any request to the database service";
    const duplicates = Array.from({ length: 6 }, (_, i) => entry(`a${i}`, { body }));
    const required = Array.from({ length: 4 }, (_, i) =>
      entry(`z${i}`, { title: `auth detail ${i}`, body: `Separate required fact ${i}` }),
    );
    const lexicalTop = rankEntries([...duplicates, ...required], parseQuery("auth"), {
      explain: false,
    }).slice(0, 5);
    expect(lexicalTop.filter((r) => r.engram.id.startsWith("z"))).toHaveLength(0);
    const results = searchEngrams([...duplicates, ...required], "auth", 5, { now, explain: true });
    expect(results.filter((r) => r.engram.id.startsWith("a"))).toHaveLength(1);
    expect(results.filter((r) => r.engram.id.startsWith("z"))).toHaveLength(4);
    const all = searchEngrams([...duplicates, ...required], "auth", undefined, {
      now,
      explain: true,
    });
    expect(all).toHaveLength(10);
    expect(
      all
        .find((r) => r.engram.id === "a1")!
        .explanation?.contributions.some((c) => c.field === "diversification" && c.score < 0),
    ).toBe(true);
    for (const r of all)
      expect(r.explanation!.contributions.reduce((n, c) => n + c.score, 0)).toBe(r.score);
  });
  it("preserves explain/plain ordering and deterministic ties", () => {
    const list = [entry("b", { importance: 3 }), entry("a", { importance: 3 })];
    expect(
      searchEngrams(list, "auth", undefined, { now }).map((r) => [r.engram.id, r.score]),
    ).toEqual(
      searchEngrams(list, "auth", undefined, { now, explain: true }).map((r) => [
        r.engram.id,
        r.score,
      ]),
    );
  });
});

it("does not reward invalid, future or old timestamps, and preserves recency-only search", () => {
  for (const updated of [
    "invalid",
    new Date(now + 86400000).toISOString(),
    new Date(now - 31 * 86400000).toISOString(),
  ]) {
    expect(
      score(entry("a", { type: "note", updated })).explanation?.contributions.some(
        (c) => c.field === "freshness",
      ),
    ).toBe(false);
  }
  const list = [entry("b", { importance: 5 }), entry("a")];
  expect(searchEngrams(list, undefined, undefined, { now }).map((r) => r.engram.id)).toEqual([
    "a",
    "b",
  ]);
});
it("recognizes near-duplicates but preserves separate scopes and distinct facts", () => {
  const body =
    "Always validate incoming authentication tokens before passing any request to the database service with the configured credentials";
  const list = [
    entry("a", { body }),
    entry("b", { body: body + " safely" }),
    entry("c", { body, scope: "personal" }),
    entry("d", {
      body: "A distinct authentication policy with independent validation and separate security requirements",
    }),
  ];
  const all = searchEngrams(list, "auth", undefined, { now, explain: true });
  expect(
    all
      .find((r) => r.engram.id === "b")!
      .explanation?.contributions.some((c) => c.field === "diversification"),
  ).toBe(true);
  for (const id of ["c", "d"])
    expect(
      all
        .find((r) => r.engram.id === id)!
        .explanation?.contributions.some((c) => c.field === "diversification"),
    ).toBe(false);
});
