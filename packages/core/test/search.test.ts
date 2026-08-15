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
