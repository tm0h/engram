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
  schemaVersion: 1,
  aliases: [],
  body: "",
  path: "",
  ...over,
});

/** Same shape as the ENG-59 corpus misses: a natural-language query whose
 * alternatives are mostly absent from the candidate set, with entries that
 * graze one mid-frequency token ("bravo"). The best entry covers almost
 * none of the query's informative mass, so the wired path abstains. */
const list: Engram[] = [
  mem({ id: "m1", title: "Bravo report shipped", tags: ["bravo"], body: "status notes" }),
  mem({ id: "m2", title: "Bravo archive moved", tags: ["bravo"], body: "storage" }),
  mem({ id: "m3", title: "Filler one", body: "regular status update" }),
  mem({ id: "m4", title: "Filler two", body: "another routine item" }),
  mem({ id: "m5", title: "Filler three", body: "more workspace chatter" }),
];
/** Only m1/m2 match ("bravo"); the five other alternatives are absent. */
const nearMatchQuery = "alpha bravo charlie delta echo";

const answeringList: Engram[] = [
  mem({
    id: "g1",
    title: "Gallery guide",
    tags: ["gallery"],
    body: "alpha bravo charlie delta echo all covered here",
  }),
  mem({ id: "g2", title: "Partial note", body: "bravo mention" }),
];

describe("searchEngrams abstention (ENG-59)", () => {
  it("abstains a near-match query exactly like a no-match query", () => {
    const abstained = searchEngrams(list, nearMatchQuery);
    const noMatch = searchEngrams(list, "wordthatisnowhereinthelist");
    expect(abstained).toEqual([]);
    expect(abstained).toEqual(noMatch);
  });

  it("respects limit on an abstained query", () => {
    expect(searchEngrams(list, nearMatchQuery, 5)).toEqual([]);
  });

  it("abstains under explain mode too (surface unchanged)", () => {
    expect(searchEngrams(list, nearMatchQuery, undefined, { explain: true })).toEqual([]);
  });

  it("keeps answering queries and their scores unchanged", () => {
    const r = searchEngrams(answeringList, "alpha bravo charlie delta echo");
    expect(r.map((x) => x.engram.id)).toEqual(["g1", "g2"]);
    // Scores are the plain BM25 contributions; explanation absent by default.
    expect(r[0]?.score).toBeGreaterThan(0);
    expect("explanation" in (r[0] as object)).toBe(false);
  });

  it("keeps the public explanation surface intact when asked", () => {
    const r = searchEngrams(answeringList, "alpha bravo charlie delta echo", undefined, {
      explain: true,
    });
    expect(r[0]?.explanation?.mode).toBe("relevance");
    expect(r[0]?.explanation?.contributions.length ?? 0).toBeGreaterThan(0);
    // Contributions sum to the score exactly (documented invariant).
    const sum = (r[0]?.explanation?.contributions ?? []).reduce((s, c) => s + c.score, 0);
    expect(sum).toBeCloseTo(r[0]?.score ?? 0, 10);
  });

  it("passes explanations through for ineligible query shapes when asked", () => {
    // Single-term, AND, and phrase shapes are ineligible for abstention;
    // they must still explain when the caller asks (Greptile finding 1).
    for (const query of ["bravo", "bravo AND here", '"bravo charlie" echo']) {
      const r = searchEngrams(answeringList, query, undefined, { explain: true });
      expect(r.length).toBeGreaterThan(0);
      for (const row of r) {
        expect(row.explanation?.mode).toBe("relevance");
        expect(row.explanation?.contributions.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it("collects no explanations for ineligible shapes by default", () => {
    for (const query of ["bravo", "bravo AND here", '"bravo charlie" echo']) {
      const r = searchEngrams(answeringList, query);
      expect(r.length).toBeGreaterThan(0);
      for (const row of r) {
        expect("explanation" in (row as object)).toBe(false);
      }
    }
  });

  it("never abstains single-term queries with a match", () => {
    const r = searchEngrams(list, "bravo");
    expect(r.map((x) => x.engram.id)).toEqual(["m1", "m2"]);
  });

  it("never abstains structured queries: AND, phrase, prefix, field scope", () => {
    // AND binds tighter: one conjunctive alternative, g2 lacks "here".
    const and = searchEngrams(answeringList, "bravo AND here");
    expect(and.map((x) => x.engram.id)).toEqual(["g1"]);
    // Whitespace separates alternatives: phrase-OR-echo. g2 matches the
    // phrase alternative via its "bravo" word token. Shape gate: any phrase
    // term makes the query ineligible for abstention.
    const phrase = searchEngrams(answeringList, '"bravo charlie" echo');
    expect(phrase.map((x) => x.engram.id)).toEqual(["g1", "g2"]);
    // Prefix OR word: g2 matches neither.
    const prefix = searchEngrams(answeringList, "galler* guide");
    expect(prefix.map((x) => x.engram.id)).toEqual(["g1"]);
    // Field-scoped OR word: g2 matches via plain "bravo".
    const scoped = searchEngrams(answeringList, "title:gallery bravo");
    expect(scoped.map((x) => x.engram.id)).toEqual(["g1", "g2"]);
  });

  it("leaves the recency path untouched (no searchable tokens)", () => {
    const empty = searchEngrams(list, "");
    const undefinedQuery = searchEngrams(list, undefined);
    const punctuation = searchEngrams(list, "!!! ???");
    // Identical updated timestamps: recency sort falls back to id ascending.
    expect(empty.map((x) => x.engram.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(empty).toEqual(undefinedQuery);
    expect(empty).toEqual(punctuation);
  });

  it("keeps genuine emptiness empty (zero matches never becomes results)", () => {
    expect(searchEngrams(list, "wordthatisnowhereinthelist")).toEqual([]);
  });

  it("leaves the legacy ranker untouched (no abstention there)", () => {
    const legacy = searchEngramsLegacy(list, nearMatchQuery);
    expect(legacy.length).toBeGreaterThan(0);
  });
});
