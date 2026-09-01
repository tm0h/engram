import { describe, it, expect } from "vite-plus/test";
import {
  slugify,
  parseTags,
  padId,
  numericId,
  truncate,
  nowISO,
  newId,
  isValidId,
  parseEntryFilename,
  parseTimestamp,
} from "../src/util.js";

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

describe("isValidId", () => {
  it("accepts legacy four-digit ids", () => {
    for (const id of ["0000", "0001", "0042", "9999"]) expect(isValidId(id)).toBe(true);
  });

  it("accepts generated 26-char base32 ids", () => {
    expect(isValidId(newId())).toBe(true);
    expect(isValidId("01arz3ndektsv4rrffq69g5fav")).toBe(true);
  });

  it("rejects malformed ids", () => {
    for (const id of [
      "",
      "abc",
      "00001",
      "123",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "01arz3ndektsv4rrffq69g5favi",
      "0001-a",
      " 0001",
    ]) {
      expect(isValidId(id)).toBe(false);
    }
  });
});

describe("parseEntryFilename", () => {
  it("decomposes <id>-<slug>.md", () => {
    expect(parseEntryFilename("0001-my-note.md")).toEqual({ id: "0001", slug: "my-note" });
    expect(parseEntryFilename(`${newId()}-a.md`)).toMatchObject({ slug: "a" });
  });

  it("rejects names without a valid id part or slug", () => {
    for (const name of [
      "notanid.md",
      "0001.md",
      "0001-.md",
      "-slug.md",
      "0001-slug.txt",
      "00-slug.md",
      "0001-slug.md.bak",
    ]) {
      expect(parseEntryFilename(name)).toBeUndefined();
    }
  });
});

describe("parseTimestamp", () => {
  it("accepts canonical UTC, no-millisecond, and explicit offsets", () => {
    expect(parseTimestamp("2025-08-15T10:00:00.000Z")).toBe(Date.parse("2025-08-15T10:00:00.000Z"));
    expect(parseTimestamp("2025-08-15T10:00:00Z")).toBe(Date.parse("2025-08-15T10:00:00Z"));
    expect(parseTimestamp("2025-08-15T12:00:00+02:00")).toBe(
      Date.parse("2025-08-15T12:00:00+02:00"),
    );
    expect(parseTimestamp("2025-08-15T08:00:00-02:30")).toBe(
      Date.parse("2025-08-15T08:00:00-02:30"),
    );
  });

  it("rejects forms without an explicit zone", () => {
    for (const v of ["2025-08-15", "2025-08-15T10:00:00", "08:30", "yesterday", ""]) {
      expect(parseTimestamp(v)).toBeUndefined();
    }
  });

  it("rejects impossible calendar dates that Date.parse would normalize", () => {
    for (const v of [
      "2025-02-30T10:00:00Z", // Feb 30 normalizes to Mar 2
      "2025-04-31T10:00:00Z", // April has 30 days
      "2023-02-29T10:00:00Z", // 2023 is not a leap year
      "1900-02-29T10:00:00Z", // century, not a leap year (400 rule)
      "2025-13-01T10:00:00Z", // month 13
      "2025-00-15T10:00:00Z", // month 0
      "2025-08-00T10:00:00Z", // day 0
    ]) {
      expect(parseTimestamp(v)).toBeUndefined();
    }
  });

  it("accepts real leap days", () => {
    expect(parseTimestamp("2024-02-29T10:00:00Z")).toBe(Date.parse("2024-02-29T10:00:00Z"));
    expect(parseTimestamp("2000-02-29T10:00:00Z")).toBe(Date.parse("2000-02-29T10:00:00Z"));
  });

  it("rejects impossible clock values and offsets", () => {
    for (const v of [
      "2025-08-15T24:00:00Z",
      "2025-08-15T10:60:00Z",
      "2025-08-15T10:00:60Z",
      "2025-08-15T10:00:00+25:00",
      "2025-08-15T10:00:00+02:60",
    ]) {
      expect(parseTimestamp(v)).toBeUndefined();
    }
  });
});
