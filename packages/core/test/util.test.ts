import { describe, it, expect } from "vite-plus/test";
import { slugify, parseTags, padId, numericId, truncate, nowISO, newId } from "../src/util.js";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Replaced libfoo with libbar!")).toBe("replaced-libfoo-with-libbar");
  });
  it("collapses non-alphanumerics", () => {
    expect(slugify("auth / oauth 2.0")).toBe("auth-oauth-2-0");
  });
  it("falls back to 'engram' when empty", () => {
    expect(slugify("!!!")).toBe("engram");
  });
  it("caps length at 60", () => {
    expect(slugify("x".repeat(200)).length).toBe(60);
  });
});

describe("parseTags", () => {
  it("splits on commas and spaces, dedupes, lowercases", () => {
    expect(parseTags("Deps, auth deps")).toEqual(["deps", "auth"]);
  });
  it("returns empty for undefined/empty", () => {
    expect(parseTags(undefined)).toEqual([]);
    expect(parseTags("   ")).toEqual([]);
  });
});

describe("padId", () => {
  it("zero-pads to 4 digits", () => {
    expect(padId(1)).toBe("0001");
    expect(padId(42)).toBe("0042");
    expect(padId(9999)).toBe("9999");
  });
});

describe("numericId", () => {
  it("parses leading digits", () => {
    expect(numericId("0007")).toBe(7);
    expect(numericId("abc")).toBe(0);
  });
});

describe("newId", () => {
  it("yields 26 lowercase Crockford-base32 chars (no i/l/o/u)", () => {
    for (let i = 0; i < 100; i++) expect(newId()).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
  });
  it("never collides across many draws", () => {
    const ids = new Set(Array.from({ length: 10000 }, () => newId()));
    expect(ids.size).toBe(10000);
  });
  it("is monotonic within a process (sort order == creation order)", () => {
    const ids = Array.from({ length: 1000 }, () => newId());
    expect([...ids].sort()).toEqual(ids);
  });
  it("stays monotonic when the clock steps backwards", () => {
    const first = newId();
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() - 60_000; // NTP correction / VM resume
    try {
      const second = newId();
      const third = newId();
      expect(second >= first).toBe(true);
      expect(third >= second).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("truncate", () => {
  it("collapses whitespace and truncates with ellipsis", () => {
    expect(truncate("a\n\nb   c", 10)).toBe("a b c");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });
  it("leaves short strings alone", () => {
    expect(truncate("short", 50)).toBe("short");
  });
});

describe("nowISO", () => {
  it("returns a parseable ISO timestamp", () => {
    const t = nowISO();
    expect(new Date(t).toISOString()).toBe(t);
  });
});
