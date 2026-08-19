import { describe, it, expect } from "vite-plus/test";
import { paginate, capText, pageFooter, MAX_RESULT_CHARS } from "../src/shared/pagination.js";

describe("paginate", () => {
  const items = Array.from({ length: 10 }, (_, i) => i + 1);

  it("returns the first window with nextOffset", () => {
    const page = paginate(items, 0, 3);
    expect(page.items).toEqual([1, 2, 3]);
    expect(page.total).toBe(10);
    expect(page.offset).toBe(0);
    expect(page.limit).toBe(3);
    expect(page.nextOffset).toBe(3);
  });

  it("returns the last window with nextOffset null", () => {
    const page = paginate(items, 9, 3);
    expect(page.items).toEqual([10]);
    expect(page.nextOffset).toBeNull();
  });

  it("exact-fit window has no next page", () => {
    const page = paginate([1, 2, 3], 0, 3);
    expect(page.items).toEqual([1, 2, 3]);
    expect(page.nextOffset).toBeNull();
  });

  it("offset beyond the end yields an empty page", () => {
    const page = paginate(items, 50, 3);
    expect(page.items).toEqual([]);
    expect(page.nextOffset).toBeNull();
    expect(page.total).toBe(10);
  });

  it("clamps negative offset and non-positive limit", () => {
    expect(paginate(items, -5, 3).offset).toBe(0);
    const zero = paginate(items, 0, 0);
    expect(zero.items).toEqual([]);
    expect(zero.limit).toBe(0);
  });
});

describe("capText", () => {
  it("passes short text through unchanged", () => {
    const res = capText("hello");
    expect(res.text).toBe("hello");
    expect(res.truncated).toBe(false);
  });

  it("truncates text over the cap and flags it", () => {
    const long = "x".repeat(MAX_RESULT_CHARS + 100);
    const res = capText(long);
    expect(res.text.length).toBe(MAX_RESULT_CHARS);
    expect(res.truncated).toBe(true);
  });

  it("honors a custom cap", () => {
    const res = capText("abcdef", 3);
    expect(res.text).toBe("abc");
    expect(res.truncated).toBe(true);
  });
});

describe("pageFooter", () => {
  it("renders a next-call instruction when more pages exist", () => {
    const footer = pageFooter({
      from: 26,
      to: 50,
      total: 87,
      nextOffset: 50,
      nextCall: "engram_context({offset: 50})",
    });
    expect(footer).toBe("(showing 26-50 of 87 - call engram_context({offset: 50}) for more)");
  });

  it("omits the call when on the last page", () => {
    const footer = pageFooter({ from: 51, to: 87, total: 87, nextOffset: null });
    expect(footer).toBe("(showing 51-87 of 87)");
  });
});
