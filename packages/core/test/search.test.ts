import { describe, it, expect } from "vite-plus/test";
import { searchEngrams, searchEngramsLegacy } from "../src/search.js";
import type { Engram } from "../src/domain.js";

const mem = (over: Partial<Engram> & { id: string; title: string }): Engram => ({
  type: "note",
  tags: [],
  scope: "project",
  created: "2025-01-01T00:00:00.000Z",
  updated: "2025-01-01T00:00:00.000Z",
  author: undefined,
  pinned: false,
  body: "",
  path: "",
  ...over,
});

const sample: Engram[] = [
  mem({
    id: "0001",
    title: "Replaced libfoo with libbar",
    type: "decision",
    tags: ["deps", "auth"],
    body: "libfoo had an engram leak",
  }),
  mem({
    id: "0002",
    title: "Use pnpm for installs",
    type: "preference",
    tags: ["tooling"],
    body: "",
  }),
  mem({
    id: "0003",
    title: "Auth is handled by libbar",
    type: "fact",
    tags: ["auth"],
    body: "tokens in cookies",
  }),
];

describe("searchEngrams", () => {
  it("scores tag + title matches highest", () => {
    const r = searchEngrams(sample, "auth");
    // 0003: tag 'auth' (+5) AND title contains 'auth' (+3) = 8
    // 0001: tag 'auth' (+5) only = 5
    expect(r[0].engram.id).toBe("0003");
    expect(r.map((x) => x.engram.id)).toEqual(["0003", "0001"]);
  });

  it("matches words in body", () => {
    const r = searchEngrams(sample, "leak");
    expect(r.map((x) => x.engram.id)).toEqual(["0001"]);
  });

  it("excludes non-matches", () => {
    const r = searchEngrams(sample, "pnpm");
    expect(r.map((x) => x.engram.id)).toEqual(["0002"]);
  });

  it("returns all (recency-sorted) when no query", () => {
    const list = [
      mem({ id: "0001", title: "old", updated: "2025-01-01T00:00:00.000Z" }),
      mem({ id: "0002", title: "new", updated: "2025-06-01T00:00:00.000Z" }),
    ];
    const r = searchEngrams(list, undefined);
    expect(r.map((x) => x.engram.id)).toEqual(["0002", "0001"]);
  });

  it("respects a limit", () => {
    const r = searchEngrams(sample, "auth", 1);
    expect(r.length).toBe(1);
  });

  it("gives pinned a boost", () => {
    const list = [
      mem({ id: "0001", title: "config note", body: "config", pinned: false }),
      mem({ id: "0002", title: "config note", body: "config", pinned: true }),
    ];
    const r = searchEngrams(list, "config");
    expect(r[0].engram.id).toBe("0002");
  });
});

describe("searchEngrams / inactive filtering (ENG-17)", () => {
  const now = Date.parse("2026-01-15T12:00:00.000Z");
  const iso = (ms: number): string => new Date(ms).toISOString();

  const lifecycle: Engram[] = [
    mem({ id: "0001", title: "active note", body: "config" }),
    // the tag makes 0002 the top scorer among "config" matches, so a limit
    // applied before filtering would keep the superseded entry
    mem({ id: "0002", title: "superseded note", tags: ["config"], status: "superseded" }),
    mem({ id: "0003", title: "archived note", body: "config", status: "archived" }),
    mem({ id: "0004", title: "expired note", body: "config", expires: iso(now - 1) }),
    mem({ id: "0005", title: "future-expiry note", body: "config", expires: iso(now + 1) }),
  ];

  it("excludes inactive entries from query results by default", () => {
    const r = searchEngrams(lifecycle, "config", undefined, { now });
    expect(r.map((x) => x.engram.id)).toEqual(["0001", "0005"]);
  });

  it("excludes inactive entries when no query is given", () => {
    const r = searchEngrams(lifecycle, undefined, undefined, { now });
    expect(r.map((x) => x.engram.id)).toEqual(["0001", "0005"]);
  });

  it("expiry boundary is inclusive: expires == now counts as inactive", () => {
    const list = [mem({ id: "0001", title: "edge", expires: iso(now) })];
    expect(searchEngrams(list, undefined, undefined, { now })).toEqual([]);
  });

  it("explicit active status stays active", () => {
    const list = [mem({ id: "0001", title: "explicit", status: "active" })];
    expect(searchEngrams(list, "explicit", undefined, { now })).toHaveLength(1);
  });

  it("includeInactive re-includes inactive entries", () => {
    const r = searchEngrams(lifecycle, "config", undefined, { now, includeInactive: true });
    expect(r.map((x) => x.engram.id)).toEqual(["0002", "0001", "0003", "0004", "0005"]);
  });

  it("filters before limit slicing", () => {
    // Without default filtering, limit 1 would keep the top-scoring entry,
    // the superseded 0002 (tag boost). Filtering first leaves 0001.
    const r = searchEngrams(lifecycle, "config", 1, { now });
    expect(r.map((x) => x.engram.id)).toEqual(["0001"]);
  });

  it("entries without lifecycle fields are unaffected (backward compatible)", () => {
    const r = searchEngrams(sample, "auth");
    expect(r.map((x) => x.engram.id)).toEqual(["0003", "0001"]);
  });
});

describe("searchEngrams / Unicode normalization (ENG-21 remediation)", () => {
  const uni: Engram[] = [
    mem({ id: "u1", title: "Café menu" }), // precomposed e-acute in title
    mem({ id: "u2", title: "Kitchen notes", body: "café au lait" }), // precomposed in body
    mem({ id: "u3", title: "Decomposed notes", body: "cafe\u0301 corner" }), // decomposed
    mem({ id: "u4", title: "Plain Cafe", tags: ["résumé"] }), // ASCII title, accented tag
    mem({ id: "u5", title: "Такой порядок" }), // Cyrillic target
    mem({ id: "u6", title: "Unrelated entry", body: "nothing here" }),
  ];

  it("precomposed query matches precomposed and decomposed documents", () => {
    // same match set as the legacy ranker; u3 (shorter body) now outranks
    // u2 under BM25 length normalization
    expect(searchEngrams(uni, "Café").map((x) => x.engram.id)).toEqual(["u1", "u4", "u3", "u2"]);
  });

  it("plain ASCII query matches precomposed documents (finding 1)", () => {
    const ids = searchEngrams(uni, "cafe").map((x) => x.engram.id);
    expect(ids).toContain("u1");
    expect(ids).toContain("u2");
  });

  it("decomposed query matches precomposed documents", () => {
    expect(searchEngrams(uni, "cafe\u0301").map((x) => x.engram.id)).toEqual([
      "u1",
      "u4",
      "u3",
      "u2",
    ]);
  });

  it("ASCII query also matches decomposed documents (pinned explicitly)", () => {
    expect(searchEngrams(uni, "cafe").map((x) => x.engram.id)).toContain("u3");
  });

  it("accented tag matches exactly at score level, both query forms", () => {
    const r = searchEngrams(uni, "resume");
    expect(r.map((x) => x.engram.id)).toEqual(["u4"]);
    expect(r[0]?.score).toBeGreaterThan(0);
    expect(r[0]?.explanation).toBeUndefined();
    const symmetric = searchEngrams(uni, "résumé");
    expect(symmetric.map((x) => x.engram.id)).toEqual(["u4"]);
    expect(symmetric[0]?.score).toBe(r[0]?.score);
  });

  it("non-ASCII query filters instead of degenerating to the recency list (C3)", () => {
    const r = searchEngrams(uni, "такой");
    expect(r.map((x) => x.engram.id)).toEqual(["u5"]);
  });

  it("ASCII scoring is unchanged (regression set)", () => {
    const r = searchEngrams(sample, "auth tokens");
    // 0003 matches tag + title; 0001 matches tag only
    expect(r.map((x) => x.engram.id)).toEqual(["0003", "0001"]);
    expect(r[0]?.score).toBeGreaterThan(r[1]?.score ?? 0);
    expect(r[0]?.score).toBeGreaterThan(0);
  });

  it("empty query still returns the recency list", () => {
    expect(searchEngrams(uni, "").map((x) => x.engram.id)).toEqual([
      "u1",
      "u2",
      "u3",
      "u4",
      "u5",
      "u6",
    ]);
  });

  it("operator-only queries fall back to the recency list", () => {
    expect(searchEngrams(uni, "AND OR").map((x) => x.engram.id)).toEqual([
      "u1",
      "u2",
      "u3",
      "u4",
      "u5",
      "u6",
    ]);
    expect(searchEngrams(uni, "AND OR", undefined, { explain: true })[0]?.explanation?.mode).toBe(
      "recency",
    );
  });

  it("path queries match on components and basename", () => {
    const list = [
      mem({ id: "p1", title: "Fix parse in packages/core/src/search.ts" }),
      mem({ id: "p2", title: "Unrelated" }),
    ];
    const r = searchEngrams(list, "packages/core/src/search.ts");
    expect(r.map((x) => x.engram.id)).toEqual(["p1"]);
  });
});

describe("searchEngrams / ENG-18 BM25 ranker and query syntax", () => {
  it("boosts a contiguous quoted phrase over scattered tokens", () => {
    const list = [
      mem({ id: "0001", title: "release the new checklist" }),
      mem({ id: "0002", title: "release checklist for v2" }),
    ];
    const r = searchEngrams(list, '"release checklist"');
    expect(r.map((x) => x.engram.id)).toEqual(["0002", "0001"]);
  });

  it("keeps the default multi-token semantics OR-compatible (D2)", () => {
    const list = [
      mem({ id: "0001", title: "alpha only" }),
      mem({ id: "0002", title: "beta only" }),
      mem({ id: "0003", title: "alpha and beta" }),
    ];
    expect(searchEngrams(list, "alpha beta").map((x) => x.engram.id)).toEqual([
      "0003",
      "0001",
      "0002",
    ]);
  });

  it("requires every term across explicit AND groups", () => {
    const list = [
      mem({ id: "0001", title: "alpha only" }),
      mem({ id: "0002", title: "beta only" }),
      mem({ id: "0003", title: "alpha beta" }),
    ];
    expect(searchEngrams(list, "alpha AND beta").map((x) => x.engram.id)).toEqual(["0003"]);
  });

  it("expands a bounded prefix to field tokens with the stem kept in explanations", () => {
    const list = [
      mem({ id: "0001", title: "kubernetes cluster notes" }),
      mem({ id: "0002", title: "k8s notes" }),
    ];
    const r = searchEngrams(list, "kuber*", undefined, { explain: true });
    expect(r.map((x) => x.engram.id)).toEqual(["0001"]);
    const c = r[0]?.explanation?.contributions[0];
    expect(c).toMatchObject({ field: "title", token: "kuber", component: "prefix" });
  });

  it("scopes field filters; AND composition makes them hard requirements", () => {
    const list = [
      mem({ id: "0001", title: "auth everywhere", tags: ["ops"] }),
      mem({ id: "0002", title: "unrelated title", tags: ["auth"] }),
    ];
    expect(searchEngrams(list, "tag:auth").map((x) => x.engram.id)).toEqual(["0002"]);
    // no entry carries auth in both fields
    expect(searchEngrams(list, "tag:auth AND title:auth").map((x) => x.engram.id)).toEqual([]);
  });

  it("combines field filters with OR groups and AND precedence", () => {
    const list = [
      mem({ id: "0001", title: "deploy guide", tags: ["ops"] }),
      mem({ id: "0002", title: "runbook", body: "deploy the proxy" }),
    ];
    // (tag:ops OR body:deploy) AND title:deploy
    const r = searchEngrams(list, "tag:ops OR body:deploy AND title:deploy");
    expect(r.map((x) => x.engram.id)).toEqual(["0001"]);
  });

  it("exposes BM25 components in explanations that sum to the score", () => {
    const list = [
      mem({
        id: "0001",
        title: "auth guide",
        type: "note",
        tags: ["auth"],
        body: "auth note",
        pinned: true,
      }),
    ];
    const r = searchEngrams(list, "auth note", undefined, { explain: true });
    const contributions = r[0]?.explanation?.contributions ?? [];
    expect(contributions.map((c) => [c.field, c.component])).toEqual([
      ["tag", "bm25"],
      ["title", "bm25"],
      ["body", "bm25"],
      ["type", "bm25"],
      ["body", "bm25"],
      ["pinned", "pinned"],
    ]);
    expect(contributions.reduce((s, c) => s + c.score, 0)).toBe(r[0]?.score);
  });

  it("breaks score ties by engram id ascending", () => {
    const list = [
      mem({ id: "0002", title: "same words here" }),
      mem({ id: "0001", title: "same words here" }),
    ];
    const r = searchEngrams(list, "same words");
    expect(r.map((x) => x.engram.id)).toEqual(["0001", "0002"]);
    expect(r[0]?.score).toBe(r[1]?.score);
  });

  it("searchEngramsLegacy keeps the pre-ENG-18 fixed-points behavior for shadow comparison", () => {
    const r = searchEngramsLegacy(sample, "auth");
    expect(r.map((x) => x.engram.id)).toEqual(["0003", "0001"]);
    expect(r[0]?.score).toBe(8);
    expect(r[1]?.score).toBe(5);
    const uni = searchEngramsLegacy(
      [mem({ id: "u4", title: "Plain Cafe", tags: ["résumé"] })],
      "resume",
    );
    expect(uni[0]?.score).toBe(5);
    // substring semantics: a single letter matches inside words
    const sub = searchEngramsLegacy(sample, "a", 1);
    expect(sub).toHaveLength(1);
    // legacy explanations carry no component field
    const explained = searchEngramsLegacy(sample, "auth", undefined, { explain: true });
    expect(explained[0]?.explanation?.contributions[0]).not.toHaveProperty("component");
  });
});
