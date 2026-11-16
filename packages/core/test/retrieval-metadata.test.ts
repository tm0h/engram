import { it, expect } from "vite-plus/test";
import { pathApplies, metadataErrors } from "../src/retrieval-metadata.js";
it("supports segment and recursive patterns without regex leakage", () => {
  for (const file of ["src/a.ts", "src/deep/a.ts"])
    expect(pathApplies("src/**/*.ts", file)).toBe(true);
  expect(pathApplies("src/*.ts", "src/deep/a.ts")).toBe(false);
  expect(pathApplies("src/a.ts", "src/aXts")).toBe(false);
  expect(pathApplies("src/A.ts", "src/a.ts")).toBe(false);
});
it("rejects malformed metadata rather than silently dropping it", () => {
  for (const value of [null, "foo", [""], [42]])
    expect(metadataErrors("triggers", value).length).toBeGreaterThan(0);
  for (const value of [null, ["../x"], ["/x"], ["a/../b"], ["**/[x]"]])
    expect(metadataErrors("appliesTo", value).length).toBeGreaterThan(0);
});
