import { describe, it, expect } from "vite-plus/test";
import {
  DEFAULT_ABSTENTION_PARAMS,
  abstainPolicy,
  abstentionEligible,
  evaluateAbstention,
  separatorPieces,
} from "../src/abstention.js";
import { parseQuery } from "../src/query.js";
import { normalizeText, tokenizeQuery } from "../src/tokenize.js";
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

/** Near-match fixture: six single-word alternatives, filler candidates that
 * each graze one common token, and one entry matching the mid-frequency
 * "bravo". "alpha", "charlie", "delta", "echo", "foxtrot" are absent from
 * the candidate set entirely, so they carry maximum idf mass no entry can
 * cover; the best entry covers only "bravo". */
const nearMatchList: Engram[] = [
  mem({ id: "m1", title: "Bravo report shipped", tags: ["bravo"], body: "status notes" }),
  mem({ id: "m2", title: "Filler one", body: "regular status update" }),
  mem({ id: "m3", title: "Filler two", body: "another routine item" }),
  mem({ id: "m4", title: "Filler three", body: "more workspace chatter" }),
  mem({ id: "m5", title: "Filler four", body: "unrelated workspace note" }),
  mem({ id: "m6", title: "Filler five", body: "background chatter only" }),
];
const nearMatchQuery = "alpha bravo charlie delta echo foxtrot";

describe("abstention policy", () => {
  it("fires on a near-match shape: multi-token query, best entry covers a small share", () => {
    const parsed = parseQuery(nearMatchQuery);
    // Rank like the wired path would: contributions per entry from the real
    // ranker semantics are approximated here by using searchEngrams in the
    // integration tests; at this level, build results by hand: every
    // candidate is included (all share filler tokens with the query? no) ...
    // Use the real included set instead: only entries matching at least one
    // alternative. Only m1 matches ("bravo").
    const results = [
      {
        engram: nearMatchList[0] as Engram,
        score: 1,
        explanation: {
          mode: "relevance" as const,
          contributions: [
            { field: "tag" as const, token: "bravo", score: 1 },
            { field: "title" as const, token: "bravo", score: 1 },
          ],
        },
      },
    ];
    const decision = evaluateAbstention(nearMatchList, parsed, results);
    expect(decision.eligible).toBe(true);
    expect(decision.informativeAlternatives).toBe(6);
    expect(decision.abstain).toBe(true);
    expect(decision.bestCoverage ?? 1).toBeLessThan(DEFAULT_ABSTENTION_PARAMS.coverageThreshold);
  });

  it("does not fire when an entry covers the full query mass", () => {
    const list = [mem({ id: "f1", title: "All words", body: "alpha bravo charlie delta" })];
    const parsed = parseQuery("alpha bravo charlie delta");
    const results = [
      {
        engram: list[0] as Engram,
        score: 1,
        explanation: {
          mode: "relevance" as const,
          contributions: [
            { field: "body" as const, token: "alpha", score: 1 },
            { field: "body" as const, token: "bravo", score: 1 },
            { field: "body" as const, token: "charlie", score: 1 },
            { field: "body" as const, token: "delta", score: 1 },
          ],
        },
      },
    ];
    const decision = evaluateAbstention(list, parsed, results);
    expect(decision.eligible).toBe(true);
    expect(decision.bestCoverage).toBe(1);
    expect(decision.abstain).toBe(false);
  });

  it("does not fire on a single-term query with a match", () => {
    const parsed = parseQuery("bravo");
    const results = [
      {
        engram: nearMatchList[0] as Engram,
        score: 1,
        explanation: {
          mode: "relevance" as const,
          contributions: [{ field: "tag" as const, token: "bravo", score: 1 }],
        },
      },
    ];
    const decision = evaluateAbstention(nearMatchList, parsed, results);
    expect(decision.eligible).toBe(false);
    expect(decision.informativeAlternatives).toBe(1);
    expect(decision.abstain).toBe(false);
  });

  it("does not fire on a fully matched AND alternative", () => {
    const list = [mem({ id: "a1", title: "Both words", body: "alpha bravo together" })];
    const parsed = parseQuery("alpha AND bravo");
    const results = [
      {
        engram: list[0] as Engram,
        score: 1,
        explanation: {
          mode: "relevance" as const,
          contributions: [
            { field: "body" as const, token: "alpha", score: 1 },
            { field: "body" as const, token: "bravo", score: 1 },
          ],
        },
      },
    ];
    const decision = evaluateAbstention(list, parsed, results);
    expect(decision.eligible).toBe(false);
    expect(decision.abstain).toBe(false);
  });

  it("does not fire on a phrase-anchored match", () => {
    const list = [mem({ id: "p1", title: "Phrase", body: "alpha bravo charlie present here" })];
    const parsed = parseQuery('"alpha bravo" charlie');
    const results = [
      {
        engram: list[0] as Engram,
        score: 1,
        explanation: {
          mode: "relevance" as const,
          contributions: [
            { field: "body" as const, token: "alpha", score: 1 },
            { field: "body" as const, token: "bravo", score: 1 },
            { field: "body" as const, token: "alpha bravo", score: 1 },
            { field: "body" as const, token: "charlie", score: 1 },
          ],
        },
      },
    ];
    const decision = evaluateAbstention(list, parsed, results);
    expect(decision.eligible).toBe(false);
    expect(decision.abstain).toBe(false);
  });

  it("does not fire on a field-scoped match", () => {
    const list = [mem({ id: "s1", title: "Scoped", body: "alpha lives here" })];
    const parsed = parseQuery("title:alpha bravo");
    const results = [
      {
        engram: list[0] as Engram,
        score: 1,
        explanation: {
          mode: "relevance" as const,
          contributions: [{ field: "title" as const, token: "alpha", score: 1 }],
        },
      },
    ];
    const decision = evaluateAbstention(list, parsed, results);
    expect(decision.eligible).toBe(false);
    expect(decision.abstain).toBe(false);
  });

  it("does not fire on an empty ranking (genuine emptiness stays emptiness)", () => {
    const parsed = parseQuery(nearMatchQuery);
    const decision = evaluateAbstention(nearMatchList, parsed, []);
    expect(decision.eligible).toBe(false);
    expect(decision.bestCoverage).toBe(null);
    expect(decision.abstain).toBe(false);
  });

  it("does not fire on a prefix-term query", () => {
    const list = [mem({ id: "x1", title: "Bravo-ish", body: "bravest entry here" })];
    const parsed = parseQuery("brav* alpha");
    const results = [
      {
        engram: list[0] as Engram,
        score: 1,
        explanation: {
          mode: "relevance" as const,
          contributions: [{ field: "body" as const, token: "brav", score: 1 }],
        },
      },
    ];
    const decision = evaluateAbstention(list, parsed, results);
    expect(decision.eligible).toBe(false);
    expect(decision.abstain).toBe(false);
  });

  it("pinned-only coverage does not defeat abstention", () => {
    const list = [
      mem({
        id: "p1",
        title: "Pinned but unrelated",
        body: "completely different words",
        pinned: true,
      }),
      mem({ id: "m1", title: "Bravo report shipped", tags: ["bravo"], body: "status" }),
      mem({ id: "m2", title: "Filler", body: "routine workspace chatter" }),
    ];
    const parsed = parseQuery("alpha bravo charlie delta echo foxtrot");
    // The pinned entry is included by single-term eligibility with only the
    // pinned boost (token null); m1 grazes "bravo".
    const results = [
      {
        engram: list[0] as Engram,
        score: 0.5,
        explanation: {
          mode: "relevance" as const,
          contributions: [{ field: "pinned" as const, token: null, score: 0.5 }],
        },
      },
      {
        engram: list[1] as Engram,
        score: 1,
        explanation: {
          mode: "relevance" as const,
          contributions: [
            { field: "tag" as const, token: "bravo", score: 1 },
            { field: "title" as const, token: "bravo", score: 1 },
          ],
        },
      },
    ];
    const decision = evaluateAbstention(list, parsed, results);
    expect(decision.eligible).toBe(true);
    expect(decision.abstain).toBe(true);
  });

  it("a pinned entry with substantive coverage counts like any entry", () => {
    const list = [
      mem({
        id: "p1",
        title: "Pinned and relevant",
        body: "alpha bravo charlie delta echo foxtrot all here",
        pinned: true,
      }),
    ];
    const parsed = parseQuery("alpha bravo charlie delta echo foxtrot");
    const results = [
      {
        engram: list[0] as Engram,
        score: 5,
        explanation: {
          mode: "relevance" as const,
          contributions: [
            { field: "body" as const, token: "alpha", score: 1 },
            { field: "body" as const, token: "bravo", score: 1 },
            { field: "body" as const, token: "charlie", score: 1 },
            { field: "body" as const, token: "delta", score: 1 },
            { field: "body" as const, token: "echo", score: 1 },
            { field: "body" as const, token: "foxtrot", score: 1 },
            { field: "pinned" as const, token: null, score: 0.5 },
          ],
        },
      },
    ];
    const decision = evaluateAbstention(list, parsed, results);
    expect(decision.eligible).toBe(true);
    expect(decision.abstain).toBe(false);
  });

  it("reports ineligible instead of zero-coverage when evidence is missing", () => {
    // Greptile finding 2: a near-match shape that WOULD abstain with
    // explained results must NOT abstain when the caller passes ordinary
    // unexplained output; missing evidence is never zero coverage.
    const parsed = parseQuery(nearMatchQuery);
    const unexplained = [{ engram: nearMatchList[0] as Engram, score: 17 }];
    const d = evaluateAbstention(nearMatchList, parsed, unexplained);
    expect(d.eligible).toBe(false);
    expect(d.bestCoverage).toBe(null);
    expect(d.abstain).toBe(false);
    expect(abstainPolicy(nearMatchList, parsed, unexplained)).toBe(false);
    // Partial evidence is also insufficient: one unexplained row makes the
    // whole ranking unjudgeable (best-coverage max could be wrong).
    const partial = [
      {
        engram: nearMatchList[0] as Engram,
        score: 1,
        explanation: {
          mode: "relevance" as const,
          contributions: [{ field: "tag" as const, token: "bravo", score: 1 }],
        },
      },
      { engram: nearMatchList[1] as Engram, score: 1 },
    ];
    expect(evaluateAbstention(nearMatchList, parsed, partial).abstain).toBe(false);
  });

  it("exposes the pre-ranking eligibility gate", () => {
    // Eligible: plain multi-word natural-language shape.
    expect(abstentionEligible(parseQuery(nearMatchQuery))).toBe(true);
    // Ineligible: single term, AND group, phrase, prefix, field scope.
    expect(abstentionEligible(parseQuery("bravo"))).toBe(false);
    expect(abstentionEligible(parseQuery("alpha AND bravo"))).toBe(false);
    expect(abstentionEligible(parseQuery('"alpha bravo" charlie'))).toBe(false);
    expect(abstentionEligible(parseQuery("brav* alpha"))).toBe(false);
    expect(abstentionEligible(parseQuery("title:alpha bravo"))).toBe(false);
    // minInformative is part of the gate.
    expect(
      abstentionEligible(parseQuery("alpha bravo"), {
        coverageThreshold: 0.1,
        idfExponent: 2,
        minInformative: 3,
      }),
    ).toBe(false);
  });

  it("is deterministic and pure: same inputs, same decision, inputs untouched", () => {
    const parsed = parseQuery(nearMatchQuery);
    const results = [
      {
        engram: nearMatchList[0] as Engram,
        score: 1,
        explanation: {
          mode: "relevance" as const,
          contributions: [{ field: "tag" as const, token: "bravo", score: 1 }],
        },
      },
    ];
    const before = JSON.stringify({ candidates: nearMatchList, parsed, results });
    const a = evaluateAbstention(nearMatchList, parsed, results);
    const b = evaluateAbstention(nearMatchList, parsed, results);
    const after = JSON.stringify({ candidates: nearMatchList, parsed, results });
    expect(a).toEqual(b);
    expect(a.abstain).toBe(true);
    expect(before).toBe(after);
  });

  it("is order-independent over results and candidates", () => {
    const parsed = parseQuery(nearMatchQuery);
    const results = [
      {
        engram: nearMatchList[0] as Engram,
        score: 1,
        explanation: {
          mode: "relevance" as const,
          contributions: [{ field: "tag" as const, token: "bravo", score: 1 }],
        },
      },
    ];
    const direct = evaluateAbstention(nearMatchList, parsed, results);
    const reversed = evaluateAbstention([...nearMatchList].reverse(), parsed, [
      { ...(results[0] as (typeof results)[number]) },
    ]);
    expect(reversed.abstain).toBe(direct.abstain);
    expect(reversed.bestCoverage).toBe(direct.bestCoverage);
  });

  it("respects parameter overrides", () => {
    const parsed = parseQuery(nearMatchQuery);
    const results = [
      {
        engram: nearMatchList[0] as Engram,
        score: 1,
        explanation: {
          mode: "relevance" as const,
          contributions: [{ field: "tag" as const, token: "bravo", score: 1 }],
        },
      },
    ];
    // Raise the boundary: the same graze now abstains a higher-coverage
    // ranking too. Lower the floor to one: still eligible.
    expect(
      abstainPolicy(nearMatchList, parsed, results, {
        coverageThreshold: 0.5,
        idfExponent: 2,
        minInformative: 2,
      }),
    ).toBe(true);
    // minInformative above the alternative count: ineligible either way.
    expect(
      abstainPolicy(nearMatchList, parsed, results, {
        coverageThreshold: 0.5,
        idfExponent: 2,
        minInformative: 10,
      }),
    ).toBe(false);
    // p = 1 flattens the absent-token mass, raising the best coverage above
    // the default boundary for this fixture.
    const p1 = evaluateAbstention(nearMatchList, parsed, results, {
      coverageThreshold: DEFAULT_ABSTENTION_PARAMS.coverageThreshold,
      idfExponent: 1,
      minInformative: 2,
    });
    expect(p1.bestCoverage ?? 0).toBeGreaterThan(
      evaluateAbstention(nearMatchList, parsed, results).bestCoverage ?? 1,
    );
  });
});

describe("abstention tokenizer pinning", () => {
  it("separator pieces match the tokenizer's separator-run expansion", () => {
    // The policy's local split must agree with tokenizeQuery's subtoken
    // expansion: pieces are the separator-run segments of the normalized
    // token, and every piece of a query token appears in tokenizeQuery's
    // output for that token.
    const shapes = [
      "foo-bar",
      "a.b",
      "p/q",
      "x_y",
      "a--b",
      "cafe-bar",
      "fetchbundle(outpath",
      "srv/worker.ts",
    ];
    for (const shape of shapes) {
      const normalized = normalizeText(shape);
      const pieces = separatorPieces(normalized);
      const tokenized = tokenizeQuery(shape);
      if (!/[^\p{L}\p{N}\p{M}]/u.test(normalized)) {
        expect(pieces).toEqual([]);
        continue;
      }
      expect(pieces.length).toBeGreaterThan(0);
      for (const piece of pieces) {
        expect(tokenized).toContain(piece);
      }
      // Reassembling the pieces must reproduce the token with separator
      // runs removed (the split is lossless over letterish runs).
      const stripped = normalized.replace(/[^\p{L}\p{N}\p{M}]+/gu, "");
      expect(pieces.join("")).toBe(stripped);
    }
  });

  it("separator pieces do not camel-split; the tokenizer owns case splits", () => {
    // tokenizeQuery("fetchBundle") = exact form + camel words; the ranker's
    // call-form pieces are separator runs only. The normalized exact form
    // "fetchbundle" contains no separator, so the policy adds no pieces and
    // case splitting stays the tokenizer's job.
    expect(normalizeText("fetchBundle")).toBe("fetchbundle");
    expect(separatorPieces("fetchbundle")).toEqual([]);
    expect(tokenizeQuery("fetchBundle")).toEqual(["fetchbundle", "fetch", "bundle"]);
  });

  it("piece split is lossless and matches the fold on unicode shapes", () => {
    // The fold strips Latin diacritics: é folds to e.
    expect(normalizeText("Café-Bar")).toBe("cafe-bar");
    expect(separatorPieces("cafe-bar")).toEqual(["cafe", "bar"]);
    expect(separatorPieces("")).toEqual([]);
  });
});
