import { describe, expect, it } from "vite-plus/test";
import type { Engram } from "../src/domain.js";
import { parseQuery } from "../src/query.js";
import { rankEntries } from "../src/rank.js";

const mem = (over: Partial<Engram> & { id: string; title: string }): Engram => ({
  type: "note",
  tags: [],
  scope: "project",
  created: "2025-01-01T00:00:00.000Z",
  updated: "2025-01-01T00:00:00.000Z",
  author: undefined,
  pinned: false,
  schemaVersion: 1,
  body: "",
  path: "",
  ...over,
});

const ids = (rs: { engram: Engram }[]): string[] => rs.map((r) => r.engram.id);

describe("rankEntries (BM25-style)", () => {
  it("scores a single term match with the title field weight and length norm", () => {
    // N=1, df=1: idf = ln(1 + 0.5/1.5) = ln(4/3) = 0.287682...;
    // tfNorm = 1/(1 + 1.2*1) = 1/2.2; title points = 3 * idf * tfNorm
    const r = rankEntries([mem({ id: "e1", title: "alpha" })], parseQuery("alpha"), {
      explain: false,
    });
    expect(r).toHaveLength(1);
    expect(r[0]?.score).toBeCloseTo(0.3922937351615193, 5);
  });

  it("normalizes by field length: shorter bodies score higher for the same tf", () => {
    const entries = [
      mem({ id: "e1", title: "short", body: "alpha" }),
      mem({ id: "e2", title: "long", body: "alpha beta gamma" }),
    ];
    const r = rankEntries(entries, parseQuery("alpha"), { explain: false });
    expect(ids(r)).toEqual(["e1", "e2"]);
    expect(r[0]?.score).toBeGreaterThan(r[1]?.score ?? 0);
  });

  it("rewards rarity: a rare token outscores a common token on the same entry", () => {
    const entries = [
      mem({ id: "x", title: "x", body: "common rare" }),
      mem({ id: "a", title: "a", body: "common" }),
      mem({ id: "b", title: "b", body: "common" }),
      mem({ id: "c", title: "c", body: "other" }),
    ];
    const r = rankEntries(entries, parseQuery("common rare"), {
      explain: true,
    });
    const x = r.find((e) => e.engram.id === "x");
    const contributions = x?.explanation?.contributions ?? [];
    const common = contributions.find((c) => c.token === "common");
    const rare = contributions.find((c) => c.token === "rare");
    expect(common?.score).toBeGreaterThan(0);
    expect(rare?.score).toBeGreaterThan(common?.score ?? 0);
  });

  it("orders matches across fields by the fixed field weights tag > title > body", () => {
    const entries = [
      mem({ id: "a-body", title: "", type: "note", body: "fact" }),
      mem({ id: "a-title", title: "fact", type: "note", body: "" }),
      mem({ id: "a-tag", title: "", type: "note", tags: ["fact"], body: "" }),
    ];
    const r = rankEntries(entries, parseQuery("fact"), { explain: false });
    // the shared type "note" cannot match "fact"; each remaining field has
    // exactly one non-empty entry, so idf and tfNorm are identical across
    // fields and only the weight differs
    expect(ids(r)).toEqual(["a-tag", "a-title", "a-body"]);
  });

  it("scores a type match above an equal-length body match (weight 2 > 1)", () => {
    const entries = [
      mem({ id: "t-type", title: "", type: "note", body: "" }),
      mem({ id: "t-body", title: "", type: "decision", body: "note" }),
    ];
    const r = rankEntries(entries, parseQuery("note"), { explain: false });
    expect(ids(r)).toEqual(["t-type", "t-body"]);
  });

  it("boosts a contiguous phrase over scattered tokens", () => {
    const entries = [
      mem({ id: "scattered", title: "release the new checklist" }),
      mem({ id: "contiguous", title: "release checklist" }),
    ];
    const r = rankEntries(entries, parseQuery('"release checklist"'), { explain: true });
    expect(ids(r)).toEqual(["contiguous", "scattered"]);
    const contributions = r[0]?.explanation?.contributions ?? [];
    expect(contributions.some((c) => c.component === "phrase" && c.field === "title")).toBe(true);
  });

  it("matches phrase queries through their words even without the contiguous phrase", () => {
    const entries = [mem({ id: "only-word", title: "release process" })];
    const r = rankEntries(entries, parseQuery('"release checklist"'), { explain: false });
    expect(ids(r)).toEqual(["only-word"]);
  });

  it("expands a prefix to any field token starting with the stem", () => {
    const entries = [
      mem({ id: "k8s", title: "k8s notes" }),
      mem({ id: "kub", title: "kubernetes cluster" }),
    ];
    expect(ids(rankEntries(entries, parseQuery("kuber*"), { explain: false }))).toEqual(["kub"]);
    const contributions =
      rankEntries(entries, parseQuery("kuber*"), { explain: true })[0]?.explanation
        ?.contributions ?? [];
    expect(contributions[0]?.component).toBe("prefix");
    expect(contributions[0]?.token).toBe("kuber");
  });

  it("matches a word through any of its expanded subtokens", () => {
    const entries = [
      mem({ id: "split", title: "the parse url config flow" }),
      mem({ id: "whole", title: "ParseURLConfig notes" }),
      mem({ id: "other", title: "unrelated" }),
    ];
    const r = rankEntries(entries, parseQuery("parseURLConfig"), { explain: false });
    // three matching subtokens on the split title outscore the single exact
    // token on the whole title
    expect(ids(r)).toEqual(["split", "whole"]);
  });

  it("scopes field filters to their field; AND makes them hard requirements", () => {
    const entries = [
      mem({ id: "auth", title: "auth", tags: ["auth"] }),
      mem({ id: "ops", title: "auth", tags: ["ops"] }),
    ];
    expect(ids(rankEntries(entries, parseQuery("tag:auth"), { explain: false }))).toEqual(["auth"]);
    // plain whitespace is OR: either clause matches
    expect(
      ids(rankEntries(entries, parseQuery("tag:auth title:auth"), { explain: false })),
    ).toEqual(["auth", "ops"]);
    // AND composes the two filters into a hard requirement no entry satisfies
    expect(
      ids(rankEntries(entries, parseQuery("tag:auth AND title:ops"), { explain: false })),
    ).toEqual([]);
  });

  it("scores a field filter inside its own field", () => {
    const entries = [mem({ id: "auth", title: "unrelated", tags: ["auth"] })];
    const r = rankEntries(entries, parseQuery("tag:auth"), { explain: true });
    const contributions = r[0]?.explanation?.contributions ?? [];
    expect(contributions).toHaveLength(1);
    expect(contributions[0]).toMatchObject({ field: "tag", token: "auth", component: "bm25" });
  });

  it("matches an entry when every term of one OR-alternative matches", () => {
    const entries = [
      mem({ id: "alpha", title: "alpha" }),
      mem({ id: "beta", title: "beta" }),
      mem({ id: "both", title: "alpha beta" }),
      mem({ id: "gamma", title: "gamma" }),
    ];
    const or = rankEntries(entries, parseQuery("alpha beta"), { explain: false });
    expect(ids(or)).toEqual(["both", "alpha", "beta"]);
    const and = rankEntries(entries, parseQuery("alpha AND beta"), { explain: false });
    expect(ids(and)).toEqual(["both"]);
    const mixed = rankEntries(entries, parseQuery("alpha OR beta AND gamma"), { explain: false });
    // alpha alone, or (beta AND gamma): only alpha and the alpha-beta entry;
    // the entry matching more terms outscores the single-term entry
    expect(ids(mixed)).toEqual(["both", "alpha"]);
    const trailingAnd = rankEntries(entries, parseQuery("alpha AND"), { explain: false });
    // length normalization: the shorter title scores higher on equal tf
    expect(ids(trailingAnd)).toEqual(["alpha", "both"]);
  });

  it("keeps deterministic score-desc then id-ascending ties", () => {
    const entries = [mem({ id: "b", title: "same words" }), mem({ id: "a", title: "same words" })];
    const r = rankEntries(entries, parseQuery("same words"), { explain: false });
    expect(ids(r)).toEqual(["a", "b"]);
    expect(r[0]?.score).toBe(r[1]?.score);
  });

  it("keeps the pinned boost: pinned entries with no match still surface at 0.5", () => {
    const r = rankEntries(
      [mem({ id: "p", title: "unrelated", pinned: true })],
      parseQuery("zzzz"),
      {
        explain: true,
      },
    );
    expect(ids(r)).toEqual(["p"]);
    expect(r[0]?.score).toBe(0.5);
    expect(r[0]?.explanation?.contributions).toEqual([
      { field: "pinned", token: null, score: 0.5, component: "pinned" },
    ]);
  });

  it("does not let the pinned boost bypass field filters or AND requirements", () => {
    const entries = [
      mem({ id: "match", title: "alpha deployment", tags: ["ops"] }),
      mem({ id: "pinned", title: "unrelated", tags: ["release"], pinned: true }),
    ];

    expect(ids(rankEntries(entries, parseQuery("tag:ops"), { explain: true }))).toEqual(["match"]);
    expect(
      ids(rankEntries(entries, parseQuery("tag:ops AND title:alpha"), { explain: true })),
    ).toEqual(["match"]);
  });

  it("keeps pinned fallback for a plain branch in a mixed OR query", () => {
    const entries = [
      mem({ id: "match", title: "alpha deployment", tags: ["ops"] }),
      mem({ id: "pinned", title: "unrelated", tags: ["misc"], pinned: true }),
    ];

    expect(ids(rankEntries(entries, parseQuery("release OR tag:ops"), { explain: true }))).toEqual([
      "match",
      "pinned",
    ]);
    expect(
      ids(rankEntries(entries, parseQuery("tag:ops OR title:alpha"), { explain: true })),
    ).toEqual(["match"]);
  });

  it("emits contributions in token-major order with fields tag,title,type,body then pinned, summing to the score", () => {
    const entry = mem({
      id: "e1",
      title: "auth guide",
      type: "note",
      tags: ["auth"],
      body: "auth note",
      pinned: true,
    });
    const r = rankEntries([entry], parseQuery("auth note"), { explain: true });
    const contributions = r[0]?.explanation?.contributions ?? [];
    expect(contributions.map((c) => [c.field, c.token])).toEqual([
      ["tag", "auth"],
      ["title", "auth"],
      ["body", "auth"],
      ["type", "note"],
      ["body", "note"],
      ["pinned", null],
    ]);
    expect(contributions.every((c) => c.score > 0)).toBe(true);
    expect(contributions.reduce((s, c) => s + c.score, 0)).toBe(r[0]?.score);
  });

  it("returns no results when candidates have no usable field content", () => {
    const entries = [mem({ id: "e1", title: "", type: "note", body: "" })];
    expect(rankEntries(entries, parseQuery("alpha"), { explain: true })).toEqual([]);
  });

  it("is deterministic across repeated calls", () => {
    const entries = [
      mem({ id: "e1", title: "alpha beta", body: "gamma" }),
      mem({ id: "e2", title: "alpha", body: "beta gamma" }),
    ];
    const q = parseQuery("alpha gamma");
    expect(rankEntries(entries, q, { explain: true })).toEqual(
      rankEntries(entries, q, { explain: true }),
    );
  });
});
