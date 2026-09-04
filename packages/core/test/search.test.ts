import { describe, it, expect } from "vite-plus/test";
import { searchEngrams } from "../src/search.js";
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
    const r = searchEngrams(sample, "a", 1);
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
