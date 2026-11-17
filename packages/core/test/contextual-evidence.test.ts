import { describe, it, expect } from "vite-plus/test";
import { contextualEvidence, contextualQuery, searchEngrams, type Engram } from "../src/index.js";
const entry = (body: string, over: Partial<Engram> = {}): Engram => ({
  id: "0001",
  title: "Stored knowledge",
  body,
  type: "fact",
  tags: [],
  aliases: [],
  scope: "project",
  pinned: false,
  author: undefined,
  schemaVersion: 1,
  path: "/synthetic/0001.md",
  created: "2020-01-01T00:00:00.000Z",
  updated: "2020-01-01T00:00:00.000Z",
  ...over,
});

describe("automatic recall evidence", () => {
  it.each([
    ["sqlite migration rollback schema transaction", "sqlite migration rollback", true, 0.6],
    ["sqlite migration rollback schema transaction", "sqlite migration", false, 0.4],
    ["sqlite migration", "sqlite", false, 0.5],
    ["sqlite migration", "sqlite migration", true, 1],
    ["Please help me fix sqlite migration", "sqlite migration", true, 1],
    ["toJSON(x)", "toJSON", true, 1],
    ["toJSON(x)", "x", false, 0],
    ["toJSON(x)", "json", false, 0],
    ["useSyncExternalStore", "use", false, 0],
    ["fact", "unrelated", false, 0],
  ])("judges %s against %s by content coverage", (prompt, body, confident, coverage) => {
    const m = entry(body);
    const result = searchEngrams([m], prompt, undefined, { explain: true, literal: true })[0];
    expect(result).toBeDefined();
    expect(contextualEvidence(result!, contextualQuery(prompt), prompt)).toMatchObject({
      confident,
      coverage,
    });
  });

  it("keeps ordinary structured search unchanged, with explicit literal interpretation for prompts", () => {
    const m = entry("sqlite migration");
    expect(searchEngrams([m], 'title:"sqlite migration"')).toEqual([]);
    expect(
      searchEngrams([m], 'title:"sqlite migration"', undefined, { literal: true }),
    ).toHaveLength(1);
    expect(searchEngrams([m], "migrat*", undefined, { literal: true })).toEqual(
      searchEngrams([m], "migrat", undefined, { literal: true }),
    );
  });

  it("requires exact original trigger text, even when sanitizing prompt syntax", () => {
    const m = entry("unrelated", { triggers: ["body:deploy"] });
    const result = searchEngrams([m], "body:deploy", undefined, {
      explain: true,
      literal: true,
    })[0]!;
    expect(contextualEvidence(result, contextualQuery("body:deploy"), "body:deploy").trigger).toBe(
      true,
    );
    expect(contextualEvidence(result, contextualQuery("body deploy"), "body deploy").trigger).toBe(
      false,
    );
  });
});
