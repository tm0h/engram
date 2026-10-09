/**
 * Pure editor-document helpers used by the $EDITOR flow of `engram add`
 * and `engram edit` (ENG-13): template rendering and parsing are tested
 * here without spawning a real editor.
 */
import { describe, it, expect } from "vite-plus/test";
import {
  renderEditorDocument,
  parseEditorDocument,
  preserveUnchangedAliases,
} from "../src/interactive.js";

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
    // aliasesRaw carries the exact saved aliases-line text (P1-1/R15)
    expect(parseEditorDocument(renderEditorDocument(FULL))).toEqual({ ...FULL, aliasesRaw: "" });
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

describe("related in the editor document (ENG-42)", () => {
  it("renders a comma-separated related line when set", () => {
    const doc = renderEditorDocument({ title: "T", related: ["0002", "0003"] });
    expect(doc).toMatch(/^related: 0002, 0003$/m);
  });

  it("renders an empty related line when unset (blank means absent)", () => {
    const doc = renderEditorDocument({ title: "T", tags: [], body: "b" });
    expect(doc).toMatch(/^related:$/m);
  });

  it("renders a stored explicit empty list as the same blank line (P2 premise)", () => {
    // undefined and [] are indistinguishable in the editor document by
    // design; the edit diff, not the renderer, preserves the [] distinction
    const unset = renderEditorDocument({ title: "T", tags: [], body: "b" });
    const emptied = renderEditorDocument({ title: "T", tags: [], body: "b", related: [] });
    expect(emptied).toMatch(/^related:$/m);
    expect(emptied).toBe(unset);
  });

  it("round-trips a populated list through parse", () => {
    const initial = { title: "T", type: "note", tags: [], body: "b", related: ["0002", "0003"] };
    expect(parseEditorDocument(renderEditorDocument(initial)).related).toEqual(["0002", "0003"]);
  });

  it("parses a blank or removed related line as absent", () => {
    const blank = parseEditorDocument(
      "---\ntitle: T\ntype: note\ntags:\nrelated:\nstatus:\n---\nB",
    );
    expect(blank.related).toBeUndefined();
    const removed = parseEditorDocument("---\ntitle: T\ntype: note\n---\nB");
    expect(removed.related).toBeUndefined();
  });

  it("rejects empty tokens with the same rule as the CLI flags", () => {
    expect(() =>
      parseEditorDocument("---\ntitle: T\ntype: note\nrelated: 0001,,0002\n---\nB"),
    ).toThrow(/--related|related/);
    expect(() =>
      parseEditorDocument("---\ntitle: T\ntype: note\nrelated: 0001, ,0002\n---\nB"),
    ).toThrow(/--related|related/);
  });

  it("distinguishes a deleted related line from a blank one (P2, turn 3)", () => {
    // the renderer always writes the line, so a missing line is an explicit
    // user deletion; a present-but-blank line is what an unchanged save of a
    // stored [] looks like
    const deleted = parseEditorDocument("---\ntitle: T\ntype: note\nstatus:\n---\nB");
    expect(deleted.related).toBeUndefined();
    expect(deleted.relatedDeleted).toBe(true);

    const blank = parseEditorDocument("---\ntitle: T\ntype: note\nrelated:\nstatus:\n---\nB");
    expect(blank.related).toBeUndefined();
    expect(blank.relatedDeleted).toBeFalsy();

    const populated = parseEditorDocument(
      renderEditorDocument({ title: "T", tags: [], body: "b", related: ["0002"] }),
    );
    expect(populated.related).toEqual(["0002"]);
    expect(populated.relatedDeleted).toBeFalsy();

    // a body-only document has no frontmatter lines at all: not a deletion
    expect(parseEditorDocument("just text").relatedDeleted).toBeFalsy();
  });
});

/* ENG-46: the aliases line in the editor document */

describe("renderEditorDocument / aliases (ENG-46)", () => {
  it("renders the aliases line after related, comma-separated", () => {
    const doc = renderEditorDocument({
      title: "T",
      type: "note",
      tags: [],
      body: "b",
      related: ["0002"],
      aliases: ["pg", "postgres"],
    });
    expect(doc).toContain("related: 0002");
    expect(doc).toContain("aliases: pg, postgres");
    expect(doc.indexOf("related:")).toBeLessThan(doc.indexOf("aliases:"));
  });

  it("renders a blank aliases line when unset or empty", () => {
    const doc = renderEditorDocument({ title: "T", type: "note", tags: [], body: "b" });
    expect(doc).toMatch(/^aliases:$/m);
    const empty = renderEditorDocument({
      title: "T",
      type: "note",
      tags: [],
      body: "b",
      aliases: [],
    });
    expect(empty).toMatch(/^aliases:$/m);
  });
});

describe("parseEditorDocument / aliases (ENG-46)", () => {
  it("parses a populated line into raw members (empties preserved for core)", () => {
    const doc = renderEditorDocument({
      title: "T",
      type: "note",
      tags: [],
      body: "b",
      aliases: ["pg", "postgres"],
    });
    expect(parseEditorDocument(doc).aliases).toEqual(["pg", "postgres"]);
  });

  it("a blank or absent line means none (undefined)", () => {
    const blank = renderEditorDocument({ title: "T", type: "note", tags: [], body: "b" });
    expect(parseEditorDocument(blank).aliases).toBeUndefined();
    const absent = parseEditorDocument("title: T\n\nBody only, no frontmatter close");
    expect(absent.aliases).toBeUndefined();
  });

  it("a removed line differs from a populated one (edit diffs drive clear/replace)", () => {
    const populated = parseEditorDocument(
      "---\ntitle: T\ntype: note\ntags: \nstatus: \nsupersedes: \nreviewAfter: \nexpires: \nsourceType: \nsourceRef: \nrelated: \naliases: pg\n---\n\nBody\n",
    );
    expect(populated.aliases).toEqual(["pg"]);
    const removed = parseEditorDocument(
      "---\ntitle: T\ntype: note\ntags: \nstatus: \nsupersedes: \nreviewAfter: \nexpires: \nsourceType: \nsourceRef: \nrelated: \n---\n\nBody\n",
    );
    expect(removed.aliases).toBeUndefined();
  });

  it("empty comma members survive the parse and fail at the core boundary", () => {
    const doc = parseEditorDocument(
      "---\ntitle: T\ntype: note\ntags: \nstatus: \nsupersedes: \nreviewAfter: \nexpires: \nsourceType: \nsourceRef: \nrelated: \naliases: ok,,fine\n---\n\nBody\n",
    );
    expect(doc.aliases).toEqual(["ok", "", "fine"]);
  });
});

describe("preserveUnchangedAliases / unchanged-line rule (P1-1, R15)", () => {
  const docWith = (aliases: string | undefined, body = "old"): string =>
    renderEditorDocument({
      title: "T",
      type: "note",
      tags: [],
      body,
      ...(aliases === undefined ? {} : { aliases: [aliases] }),
    });

  it("an unchanged line preserves the stored array exactly (comma-containing alias)", () => {
    // a stored alias containing a comma (legal via structured arrays)
    const saved = parseEditorDocument(docWith("foo, bar"));
    // re-parsing the unchanged line is lossy
    expect(saved.aliases).toEqual(["foo", "bar"]);
    const preserved = preserveUnchangedAliases(saved, ["foo, bar"]);
    expect(preserved.aliases).toEqual(["foo, bar"]);
  });

  it("a body-only edit keeps the stored aliases byte-identical (R15)", () => {
    const saved = parseEditorDocument(docWith("foo, bar", "new body"));
    const next = preserveUnchangedAliases(saved, ["foo, bar"]);
    expect(next.aliases).toEqual(["foo, bar"]);
  });

  it("a genuinely changed line still splits on commas (documented limitation)", () => {
    const saved = parseEditorDocument(docWith("foo, bar").replace("foo, bar", "keep, these"));
    const next = preserveUnchangedAliases(saved, ["foo, bar"]);
    expect(next.aliases).toEqual(["keep", "these"]);
  });

  it("a blanked or removed line still clears (AC7)", () => {
    const blanked = parseEditorDocument(
      docWith("foo, bar").replace("aliases: foo, bar", "aliases:"),
    );
    expect(blanked.aliasesRaw).toBe("");
    expect(preserveUnchangedAliases(blanked, ["foo, bar"]).aliases).toBeUndefined();

    const removed = parseEditorDocument(docWith("foo, bar").replace("aliases: foo, bar\n", ""));
    expect(removed.aliasesRaw).toBeUndefined();
    expect(preserveUnchangedAliases(removed, ["foo, bar"]).aliases).toBeUndefined();
  });

  it("a blank line with an empty prefill preserves the empty set", () => {
    const saved = parseEditorDocument(docWith(undefined));
    expect(saved.aliasesRaw).toBe("");
    const next = preserveUnchangedAliases(saved, []);
    expect(next.aliases).toEqual([]);
  });
});
