import { describe, expect, it } from "vite-plus/test";
import { parseQuery } from "../src/query.js";

describe("parseQuery", () => {
  it("parses plain words into one alternative per word (OR default)", () => {
    const q = parseQuery("auth tokens");
    expect(q.alternatives).toHaveLength(2);
    expect(q.alternatives[0]?.[0]).toMatchObject({ kind: "word", tokens: ["auth"] });
    expect(q.alternatives[1]?.[0]).toMatchObject({ kind: "word", tokens: ["tokens"] });
  });

  it("keeps separators and basenames in word tokens (path queries)", () => {
    const q = parseQuery("packages/core/src/search.ts");
    expect(q.alternatives[0]?.[0]?.kind).toBe("word");
    const tokens = q.alternatives[0]?.[0]?.tokens ?? [];
    expect(tokens).toContain("packages/core/src/search.ts");
    expect(tokens).toContain("packages");
    expect(tokens).toContain("search");
  });

  it("parses a quoted phrase with normalized text and word tokens", () => {
    const q = parseQuery('"release checklist"');
    expect(q.alternatives).toHaveLength(1);
    expect(q.alternatives[0]?.[0]).toMatchObject({
      kind: "phrase",
      phrase: "release checklist",
      tokens: ["release", "checklist"],
    });
  });

  it("parses a bounded prefix term (stem length >= 2)", () => {
    const q = parseQuery("kuber*");
    expect(q.alternatives[0]?.[0]).toMatchObject({ kind: "prefix", tokens: ["kuber"] });
  });

  it("degrades a one-character or empty prefix to a word term", () => {
    // a lone star has no usable stem: no term, the recency path applies
    const lone = parseQuery("*");
    expect(lone.alternatives).toEqual([]);
    const short = parseQuery("k*");
    expect(short.alternatives[0]?.[0]?.kind).toBe("word");
    expect(short.alternatives[0]?.[0]?.tokens).toEqual(["k"]);
  });

  it("parses field filters as required terms scoped to one field", () => {
    const word = parseQuery("tag:auth");
    expect(word.alternatives[0]?.[0]).toMatchObject({
      kind: "word",
      tokens: ["auth"],
      field: "tag",
    });
    const phrase = parseQuery('title:"multi word"');
    expect(phrase.alternatives[0]?.[0]).toMatchObject({
      kind: "phrase",
      phrase: "multi word",
      field: "title",
    });
    const prefix = parseQuery("body:kuber*");
    expect(prefix.alternatives[0]?.[0]).toMatchObject({
      kind: "prefix",
      tokens: ["kuber"],
      field: "body",
    });
  });

  it("treats an unknown field prefix as a plain word term", () => {
    const q = parseQuery("foo:bar");
    expect(q.alternatives[0]?.[0]?.kind).toBe("word");
    expect(q.alternatives[0]?.[0]?.field).toBeUndefined();
    expect(q.alternatives[0]?.[0]?.tokens).toContain("foo");
    expect(q.alternatives[0]?.[0]?.tokens).toContain("bar");
  });

  it("binds AND terms into one alternative and splits alternatives on OR", () => {
    const and = parseQuery("alpha AND beta");
    expect(and.alternatives).toHaveLength(1);
    expect(and.alternatives[0]).toHaveLength(2);
    expect(and.alternatives[0]?.[0]?.tokens).toEqual(["alpha"]);
    expect(and.alternatives[0]?.[1]?.tokens).toEqual(["beta"]);

    const or = parseQuery("alpha OR beta");
    expect(or.alternatives).toHaveLength(2);
    expect(or.alternatives[0]?.[0]?.tokens).toEqual(["alpha"]);
    expect(or.alternatives[1]?.[0]?.tokens).toEqual(["beta"]);
  });

  it("keeps lowercase and/or as ordinary search words", () => {
    const q = parseQuery("alpha and beta");
    expect(q.alternatives).toHaveLength(3);
  });

  it("gives AND tighter precedence than OR", () => {
    const q = parseQuery("alpha OR beta AND gamma");
    expect(q.alternatives).toHaveLength(2);
    expect(q.alternatives[0]).toHaveLength(1);
    expect(q.alternatives[1]).toHaveLength(2);
    expect(q.alternatives[1]?.[0]?.tokens).toEqual(["beta"]);
    expect(q.alternatives[1]?.[1]?.tokens).toEqual(["gamma"]);
  });

  it("returns no groups for operator-only, empty, or punctuation queries", () => {
    expect(parseQuery("AND").alternatives).toEqual([]);
    expect(parseQuery("AND OR").alternatives).toEqual([]);
    expect(parseQuery("").alternatives).toEqual([]);
    expect(parseQuery("   ").alternatives).toEqual([]);
    expect(parseQuery("!!!").alternatives).toEqual([]);
  });

  it("keeps a trailing AND from producing an empty group", () => {
    const q = parseQuery("alpha AND");
    expect(q.alternatives).toHaveLength(1);
    expect(q.alternatives[0]?.[0]?.tokens).toEqual(["alpha"]);
  });

  it("handles an unterminated quote gracefully", () => {
    const q = parseQuery('"release check');
    expect(q.alternatives).toHaveLength(1);
    expect(q.alternatives[0]?.[0]).toMatchObject({
      kind: "phrase",
      phrase: "release check",
    });
  });

  it("parses multi-word tag phrases with separators", () => {
    const q = parseQuery('tag:"deps audit"');
    expect(q.alternatives[0]?.[0]).toMatchObject({
      kind: "phrase",
      phrase: "deps audit",
      field: "tag",
    });
  });

  it("is deterministic and never throws on hostile input", () => {
    const inputs = [
      "",
      "   ",
      "*",
      " : ",
      "a AND",
      '"unclosed',
      "tag:",
      "tag:*",
      "a*b*c",
      "AND AND AND",
      "\u00e9\u0301",
      "x".repeat(500),
    ];
    for (const input of inputs) {
      expect(() => parseQuery(input)).not.toThrow();
      expect(parseQuery(input)).toEqual(parseQuery(input));
    }
  });
});
