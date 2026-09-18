import { describe, expect, it } from "vite-plus/test";
import type { Engram } from "../../src/domain.js";
import { syntheticCorpus } from "../../src/benchmark/synthetic.js";

const base: Engram = {
  id: "0001",
  title: "Port for the dev server",
  type: "fact",
  tags: ["config"],
  scope: "project",
  created: "2026-01-10T00:00:00.000Z",
  updated: "2026-01-10T00:00:00.000Z",
  author: undefined,
  pinned: false,
  schemaVersion: 1,
  body: "the dev server listens on port 4747 by default",
  path: "engrams/0001.md",
};

const sources: Engram[] = [
  base,
  {
    ...base,
    id: "0002",
    title: "Personal editor config",
    scope: "personal",
    status: "archived",
    pinned: true,
    tags: ["editor"],
    body: "",
  },
];

describe("syntheticCorpus", () => {
  it("produces exactly size entries with unique deterministic ids", () => {
    const out = syntheticCorpus(sources, 1000);
    expect(out).toHaveLength(1000);
    const ids = new Set(out.map((e) => e.id));
    expect(ids.size).toBe(1000);
    expect(syntheticCorpus(sources, 1000)).toEqual(out);
  });

  it("round-robins over the source list, preserving scope and lifecycle fields", () => {
    const out = syntheticCorpus(sources, 5);
    expect(out.map((e) => e.id.endsWith("-0001"))).toEqual([true, false, true, false, true]);
    // scope, status, pinned, tags, type, timestamps survive cloning
    expect(out[1]?.scope).toBe("personal");
    expect(out[1]?.status).toBe("archived");
    expect(out[1]?.pinned).toBe(true);
    expect(out[1]?.tags).toEqual(["editor"]);
    expect(out[1]?.type).toBe("fact");
    expect(out[1]?.created).toBe(base.created);
    // odd indices come from the second source; every clone keeps its
    // source's identity apart from id/title/body
    const odd = out[3] as Engram;
    expect(odd.title.startsWith("Personal editor config (variant")).toBe(true);
  });

  it("appends a deterministic filler to the body (fixed pool, no randomness)", () => {
    const out = syntheticCorpus(sources, 9);
    expect(out[0]?.body).toContain("4747");
    expect(out[0]?.body).not.toBe(base.body);
    expect(out[8]?.body).toBe(out[0]?.body);
  });

  it("rejects a non-integer or negative size and an empty source list", () => {
    expect(() => syntheticCorpus(sources, -1)).toThrow(RangeError);
    expect(() => syntheticCorpus(sources, 1.5)).toThrow(RangeError);
    expect(() => syntheticCorpus([], 1)).toThrow(RangeError);
    expect(syntheticCorpus([], 0)).toEqual([]);
    expect(syntheticCorpus(sources, 0)).toEqual([]);
  });
});
