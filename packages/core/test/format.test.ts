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
  schemaVersion: 1,
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

  it("renders every defined lifecycle and provenance field with exact timestamps", () => {
    const out = renderFull(
      mem({
        id: "0001",
        title: "Replaced guidance",
        status: "superseded",
        supersedes: "0000",
        reviewAfter: "2026-01-01T00:00:00.000Z",
        expires: "2026-06-01T00:00:00.000Z",
        sourceType: "file",
        sourceRef: "docs/spec.md",
      }),
    );
    expect(out).toContain("status: superseded");
    expect(out).toContain("supersedes: 0000");
    // exact instants, not date-shortened forms
    expect(out).toContain("review-after: 2026-01-01T00:00:00.000Z");
    expect(out).toContain("expires: 2026-06-01T00:00:00.000Z");
    expect(out).toContain("source: file · docs/spec.md");
  });

  it("renders sourceType and sourceRef independently", () => {
    expect(renderFull(mem({ id: "0001", title: "A", sourceType: "conversation" }))).toContain(
      "source: conversation",
    );
    expect(renderFull(mem({ id: "0001", title: "B", sourceRef: "chat log" }))).toContain(
      "source: chat log",
    );
  });

  it("omits the lifecycle block entirely for v0.4 entries", () => {
    const out = renderFull(mem({ id: "0001", title: "Plain" }));
    expect(out).not.toContain("status:");
    expect(out).not.toContain("supersedes:");
    expect(out).not.toContain("review-after:");
    expect(out).not.toContain("expires:");
    expect(out).not.toContain("source:");
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

describe("renderFull / related (ENG-42)", () => {
  it("prints one ordered related line for a populated list", () => {
    const out = renderFull(mem({ id: "0001", title: "T", related: ["0003", "0002"] }));
    expect(out).toContain("related: 0003, 0002");
    // exactly one related line, in list order
    expect(out.match(/related:/g)).toHaveLength(1);
    expect(out.indexOf("0003")).toBeLessThan(out.indexOf("0002"));
  });

  it("prints no related line when the list is absent or empty", () => {
    expect(renderFull(mem({ id: "0001", title: "T" }))).not.toContain("related:");
    expect(renderFull(mem({ id: "0001", title: "T", related: [] }))).not.toContain("related:");
  });

  it("keeps the related line inside the gray metadata block next to lifecycle labels", () => {
    const out = renderFull(
      mem({ id: "0001", title: "T", status: "superseded", related: ["0002"] }),
    );
    const blockLines = out
      .split("\n")
      .filter((l) => l.startsWith("  "))
      .map((l) => l.trim());
    expect(blockLines).toEqual(["status: superseded", "related: 0002"]);
  });
});
