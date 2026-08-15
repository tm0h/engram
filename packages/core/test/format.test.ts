import { describe, it, expect } from "vite-plus/test";
import { summaryLine, renderList, renderFull, renderSearch, renderContext } from "../src/format.js";
import type { Engram } from "../src/domain.js";
import { searchEngrams } from "../src/search.js";

const mem = (over: Partial<Engram> & { id: string; title: string }): Engram => ({
  type: "note",
  tags: [],
  scope: "project",
  created: "2025-01-01T00:00:00.000Z",
  updated: "2025-01-01T00:00:00.000Z",
  author: undefined,
  pinned: false,
  body: "",
  path: "",
  ...over,
});

describe("summaryLine", () => {
  it("includes id, type, title and tag hashes", () => {
    const line = summaryLine(
      mem({ id: "0001", title: "Hello", type: "decision", tags: ["a", "b"] }),
    );
    expect(line).toContain("0001");
    expect(line).toContain("Hello");
    expect(line).toContain("#a");
    expect(line).toContain("#b");
  });
  it("marks pinned with a star", () => {
    const line = summaryLine(mem({ id: "0001", title: "X", pinned: true }));
    expect(line).toContain("★");
  });
});

describe("renderList", () => {
  it("renders each engram with id and title", () => {
    const out = renderList([
      mem({ id: "0001", title: "First" }),
      mem({ id: "0002", title: "Second", body: "some body text" }),
    ]);
    expect(out).toContain("0001");
    expect(out).toContain("First");
    expect(out).toContain("some body text");
  });
  it("shows placeholder when empty", () => {
    expect(renderList([])).toContain("no engrams");
  });
});

describe("renderFull", () => {
  it("renders title, body and metadata", () => {
    const out = renderFull(mem({ id: "0001", title: "T", body: "Body here", author: "mo" }));
    expect(out).toContain("T");
    expect(out).toContain("Body here");
    expect(out).toContain("mo");
  });
});

describe("renderSearch", () => {
  it("renders matches with a score", () => {
    const list = [mem({ id: "0001", title: "auth", tags: ["auth"] })];
    const results = searchEngrams(list, "auth");
    const out = renderSearch(results);
    expect(out).toContain("0001");
    expect(out).toContain("score");
  });
  it("shows placeholder when no matches", () => {
    expect(renderSearch([])).toContain("no matches");
  });
});

describe("renderContext", () => {
  it("query mode dumps bodies with a header", () => {
    const out = renderContext([mem({ id: "0001", title: "T", body: "Because reasons" })], {
      query: "reasons",
      scope: "project",
    });
    expect(out).toContain("Engram search");
    expect(out).toContain("Because reasons");
  });
  it("digest groups decisions & pinned first", () => {
    const out = renderContext(
      [
        mem({ id: "0001", title: "Decision A", type: "decision" }),
        mem({ id: "0002", title: "Note B", type: "note" }),
      ],
      { scope: "project" },
    );
    expect(out).toContain("Decisions & pinned");
    expect(out).toContain("Decision A");
    expect(out).toContain("Note B");
  });
  it("reports count", () => {
    const out = renderContext([mem({ id: "0001", title: "X" })], { scope: "personal" });
    expect(out).toContain("1 engram");
    expect(out).toContain("personal engram");
  });
});
