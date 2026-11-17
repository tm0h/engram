import { expect, it } from "vite-plus/test";
import { matchingSnippet } from "../src/snippets.js";

it("centers a bounded deterministic window on a distant match", () => {
  const body = "before ".repeat(300) + "needle here" + " after".repeat(300);
  const snippet = matchingSnippet(body, "needle");
  expect(snippet).toContain("needle here");
  expect(snippet!.length).toBeLessThanOrEqual(240);
  expect(snippet).toBe(matchingSnippet(body, "needle"));
  expect(snippet).toMatch(/^….*…$/);
});
it("maps folded matches back to original Unicode and respects field scope", () => {
  expect(matchingSnippet("🦄 ﬁle Cafe\u0301 東京", 'body:"file cafe"')).toContain("ﬁle Cafe\u0301");
  expect(matchingSnippet("unrelated", "needle")).toBeNull();
  expect(matchingSnippet("needle", "title:needle")).toBeNull();
  expect(matchingSnippet("haystack", "stack")).toBeNull();
  expect(matchingSnippet("kubernetes", "ku*")).toBe("kubernetes");
  expect(matchingSnippet("anything", "!!!")).toBeNull();
  expect(matchingSnippet("ΟΣ", "ος")).toBe("ΟΣ");
});

it("prefers a phrase over an earlier isolated token and breaks ties by position", () => {
  const body =
    "alpha " + "padding ".repeat(100) + "beta gamma" + " padding".repeat(100) + "beta gamma";
  const snippet = matchingSnippet(body, 'alpha OR "beta gamma"');
  expect(snippet).toContain("beta gamma");
  expect(snippet).not.toContain("alpha");
  expect(snippet!.length).toBeLessThanOrEqual(240);
});

it("shares the ranker's call-form expansion while preserving field restrictions", () => {
  expect(matchingSnippet("toJSON", "toJSON(x)")).toBe("toJSON");
  expect(matchingSnippet("toJSON", "body:toJSON(x)")).toBe("toJSON");
  expect(matchingSnippet("toJSON", "title:toJSON(x)")).toBeNull();
});
