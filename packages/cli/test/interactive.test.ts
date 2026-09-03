/**
 * Pure editor-document helpers used by the $EDITOR flow of `engram add`
 * and `engram edit` (ENG-13): template rendering and parsing are tested
 * here without spawning a real editor.
 */
import { describe, it, expect } from "vite-plus/test";
import { renderEditorDocument, parseEditorDocument } from "../src/interactive.js";

const FULL = {
  title: "Replaced guidance",
  type: "decision",
  tags: ["deps", "auth"],
  body: "Body text",
  status: "superseded",
  supersedes: "0001",
  reviewAfter: "2026-01-01T00:00:00+02:00",
  expires: "2026-06-01T00:00:00.000Z",
  sourceType: "url",
  sourceRef: "https://example.com/post#a:b",
};

describe("renderEditorDocument", () => {
  it("renders all six canonical lifecycle keys with exact initial values", () => {
    const doc = renderEditorDocument(FULL);
    expect(doc).toContain("status: superseded");
    expect(doc).toContain("supersedes: 0001");
    expect(doc).toContain("reviewAfter: 2026-01-01T00:00:00+02:00");
    expect(doc).toContain("expires: 2026-06-01T00:00:00.000Z");
    expect(doc).toContain("sourceType: url");
    expect(doc).toContain("sourceRef: https://example.com/post#a:b");
  });

  it("keeps title, type, tags and the body intact", () => {
    const doc = renderEditorDocument(FULL);
    expect(doc).toContain("title: Replaced guidance");
    expect(doc).toContain("type: decision");
    expect(doc).toContain("tags: deps, auth");
    expect(doc.endsWith("Body text\n")).toBe(true);
  });

  it("renders empty lifecycle lines when values are unset", () => {
    const doc = renderEditorDocument({ title: "T", type: "note", tags: [], body: "b" });
    expect(doc).toMatch(/^status:$/m);
    expect(doc).toMatch(/^supersedes:$/m);
    expect(doc).toMatch(/^reviewAfter:$/m);
    expect(doc).toMatch(/^expires:$/m);
    expect(doc).toMatch(/^sourceType:$/m);
    expect(doc).toMatch(/^sourceRef:$/m);
  });
});

describe("parseEditorDocument", () => {
  it("round-trips a full document unchanged", () => {
    expect(parseEditorDocument(renderEditorDocument(FULL))).toEqual(FULL);
  });

  it("preserves colons in lifecycle values (offsets, URLs, paths)", () => {
    const parsed = parseEditorDocument(
      "---\ntitle: T\ntype: note\nreviewAfter: 2026-01-01T00:00:00+02:00\nsourceRef: https://ex.com/a:b\n---\nB",
    );
    expect(parsed.reviewAfter).toBe("2026-01-01T00:00:00+02:00");
    expect(parsed.sourceRef).toBe("https://ex.com/a:b");
  });

  it("parses blank lifecycle values as unset", () => {
    const parsed = parseEditorDocument(
      "---\ntitle: T\ntype: note\ntags:\nstatus:\nsupersedes:\nreviewAfter:\nexpires:\nsourceType:\nsourceRef:\n---\nB",
    );
    expect(parsed.status).toBeUndefined();
    expect(parsed.supersedes).toBeUndefined();
    expect(parsed.reviewAfter).toBeUndefined();
    expect(parsed.expires).toBeUndefined();
    expect(parsed.sourceType).toBeUndefined();
    expect(parsed.sourceRef).toBeUndefined();
    expect(parsed.title).toBe("T");
  });

  it("parses a document without lifecycle lines as unset (removed lines)", () => {
    const parsed = parseEditorDocument("---\ntitle: T\ntype: note\ntags: a\n---\nB");
    expect(parsed.status).toBeUndefined();
    expect(parsed.supersedes).toBeUndefined();
    expect(parsed.reviewAfter).toBeUndefined();
    expect(parsed.expires).toBeUndefined();
    expect(parsed.sourceType).toBeUndefined();
    expect(parsed.sourceRef).toBeUndefined();
  });

  it("keeps title/type/tags/body behavior including blank type", () => {
    const parsed = parseEditorDocument("---\ntitle: T\ntype:\ntags: a, b\n---\nBody\n");
    expect(parsed.title).toBe("T");
    expect(parsed.type).toBeUndefined();
    expect(parsed.tags).toEqual(["a", "b"]);
    expect(parsed.body).toBe("Body");
  });

  it("treats a document without delimiters as a body-only edit", () => {
    expect(parseEditorDocument("just text")).toEqual({
      title: "",
      type: undefined,
      tags: [],
      body: "just text",
    });
  });
});
