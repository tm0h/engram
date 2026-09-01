import { describe, it, expect } from "@effect/vitest";
import { Option, Result } from "effect";
import { parseFrontmatter, stringifyFrontmatter, validateEntry } from "../src/frontmatter.js";

/** Success value of parsing `raw`, or undefined when it failed. */
const ok = (raw: string) => Option.getOrUndefined(Result.getSuccess(parseFrontmatter(raw)));

describe("parseFrontmatter", () => {
  it("parses frontmatter and body", () => {
    expect(ok('---\nid: "0001"\ntitle: Hello\ntags:\n  - a\n  - b\n---\nBody here\n')).toEqual({
      data: { id: "0001", title: "Hello", tags: ["a", "b"] },
      content: "Body here\n",
    });
  });

  it("returns empty data when there is no frontmatter", () => {
    expect(ok("Just markdown, no frontmatter.\n")).toEqual({
      data: {},
      content: "Just markdown, no frontmatter.\n",
    });
  });

  it("handles empty input", () => {
    expect(ok("")).toEqual({ data: {}, content: "" });
  });

  it("strips a leading BOM", () => {
    expect(ok("\uFEFF---\ntitle: Hello\n---\nBody\n")).toEqual({
      data: { title: "Hello" },
      content: "Body\n",
    });
  });

  it("treats an unterminated block as plain content", () => {
    const raw = "---\ntitle: Hello\nno closing delimiter\n";
    expect(ok(raw)).toEqual({ data: {}, content: raw });
  });

  it("handles an empty frontmatter block", () => {
    expect(ok("---\n---\nbody\n")).toEqual({ data: {}, content: "body\n" });
  });

  it("handles frontmatter at EOF with empty body", () => {
    expect(ok("---\ntitle: Hello\n---")).toEqual({ data: { title: "Hello" }, content: "" });
  });

  it("accepts ... as the closing delimiter", () => {
    expect(ok("---\ntitle: Hello\n...\nBody\n")).toEqual({
      data: { title: "Hello" },
      content: "Body\n",
    });
  });

  it("does not treat --- inside the body as a delimiter", () => {
    expect(ok("---\ntitle: Hello\n---\nIntro\n\n---\n\nMore\n")).toEqual({
      data: { title: "Hello" },
      content: "Intro\n\n---\n\nMore\n",
    });
  });

  it("preserves one blank line after the closing delimiter", () => {
    expect(ok("---\ntitle: Hello\n---\n\nBody starts after a blank line\n")).toEqual({
      data: { title: "Hello" },
      content: "\nBody starts after a blank line\n",
    });
  });

  it("handles CRLF line endings", () => {
    expect(ok("---\r\ntitle: Hello\r\n---\r\nBody\r\n")).toEqual({
      data: { title: "Hello" },
      content: "Body\r\n",
    });
  });

  it("fails on invalid YAML", () => {
    const out = parseFrontmatter("---\ntitle: [unclosed\n---\nBody\n");
    expect(Result.isFailure(out)).toBe(true);
    expect(Option.getOrUndefined(Result.getFailure(out))).toContain("invalid YAML");
  });

  it("keeps scalars and sequences as-is (schema validation is the caller's job)", () => {
    expect(ok("---\njust a string\n---\n")).toEqual({ data: "just a string", content: "" });
    expect(ok("---\n- a\n- b\n---\n")).toEqual({ data: ["a", "b"], content: "" });
  });

  it("does not coerce YAML 1.1 booleans or timestamps", () => {
    expect(ok("---\non: yes\nmaybe: 08:30\nwhen: 2025-08-15\n---\nBody\n")?.data).toEqual({
      on: "yes",
      maybe: "08:30",
      when: "2025-08-15",
    });
  });
});

describe("stringifyFrontmatter", () => {
  it("renders frontmatter above the body", () => {
    expect(stringifyFrontmatter("Body\n", { id: "0001", title: "Hello" })).toBe(
      '---\nid: "0001"\ntitle: Hello\n---\nBody\n',
    );
  });

  it("round-trips through parse", () => {
    const data = {
      id: "0001",
      title: "Notes: yes & more",
      tags: ["a", "b"],
      created: "2025-08-15T19:53:00.000Z",
      pinned: false,
    };
    expect(ok(stringifyFrontmatter("Some body\n", data))).toEqual({ data, content: "Some body\n" });
  });

  it("round-trips strings that look like numbers, booleans and timestamps", () => {
    const data = { title: "0001", flag: "true", when: "2025-08-15" };
    expect(ok(stringifyFrontmatter("", data))?.data).toEqual(data);
  });

  it("round-trips a body containing --- lines", () => {
    const body = "Intro\n\n---\n\nSection\n";
    expect(ok(stringifyFrontmatter(body, { title: "Hello" }))?.content).toBe(body);
  });
});

/* ------------------------------------------------------------------ */
/* validateEntry: staged entry validation                            */
/* ------------------------------------------------------------------ */

const VALID_ID = "01arz3ndektsv4rrffq69g5fav"; // 26 lowercase Crockford-base32 chars

const VALID: Record<string, unknown> = {
  id: VALID_ID,
  title: "Valid title",
  type: "note",
  tags: ["a"],
  scope: "project",
  created: "2025-08-15T10:00:00.000Z",
  updated: "2025-08-15T11:00:00.000Z",
};

/** A full valid entry rendered from `over`/`omit`, mirroring generated files. */
const raw = (over: Record<string, unknown> = {}, omit: ReadonlyArray<string> = []): string => {
  const fm = { ...VALID, ...over };
  for (const name of omit) delete fm[name];
  return stringifyFrontmatter("Body\n", fm);
};

const codes = (v: ReturnType<typeof validateEntry>): string[] => v.issues.map((i) => i.code);

describe("validateEntry", () => {
  it("accepts a fully valid entry and decodes it", () => {
    const v = validateEntry(raw());
    expect(v.issues).toEqual([]);
    expect(v.frontmatter?.id).toBe(VALID_ID);
    expect(v.frontmatter?.title).toBe("Valid title");
    expect(v.frontmatter?.pinned).toBeUndefined();
    expect(v.frontmatter?.author).toBeUndefined();
    expect(v.partial).toEqual({ id: VALID_ID, title: "Valid title", scope: "project" });
    expect(v.content).toBe("Body\n");
  });

  it("accepts unknown fields for future extensions", () => {
    const v = validateEntry(raw({ status: "draft", "next-review": "2026-01-01" }));
    expect(v.issues).toEqual([]);
    expect(v.frontmatter).toBeDefined();
  });

  it("accepts legacy four-digit ids", () => {
    expect(validateEntry(raw({ id: "0001" })).issues).toEqual([]);
  });

  it("accepts generated 26-character ids", () => {
    expect(validateEntry(raw({ id: "01arz3ndektsv4rrffq69g5fav" })).issues).toEqual([]);
  });

  it("diagnoses plain markdown without frontmatter as frontmatter_missing", () => {
    const v = validateEntry("Just markdown, no frontmatter.\n");
    expect(codes(v)).toEqual(["frontmatter_missing"]);
    expect(v.frontmatter).toBeUndefined();
    expect(v.partial.id).toBeUndefined();
  });

  it("diagnoses an unterminated frontmatter block as frontmatter_missing", () => {
    const v = validateEntry("---\ntitle: Hello\nno closing delimiter\n");
    expect(codes(v)).toEqual(["frontmatter_missing"]);
  });

  it("diagnoses malformed YAML as yaml_invalid", () => {
    const v = validateEntry("---\ntitle: [unclosed\n---\nBody\n");
    expect(codes(v)).toEqual(["yaml_invalid"]);
    expect(v.issues[0].message).toContain("invalid YAML");
    expect(v.issues[0].hint.length).toBeGreaterThan(0);
  });

  it("rejects scalar frontmatter", () => {
    expect(codes(validateEntry("---\njust a string\n---\nBody\n"))).toEqual([
      "frontmatter_not_object",
    ]);
  });

  it("rejects sequence frontmatter", () => {
    expect(codes(validateEntry("---\n- a\n- b\n---\nBody\n"))).toEqual(["frontmatter_not_object"]);
  });

  it("rejects null frontmatter", () => {
    expect(codes(validateEntry("---\n~\n---\nBody\n"))).toEqual(["frontmatter_not_object"]);
  });

  it("diagnoses every missing required field actionably", () => {
    for (const name of ["id", "title", "type", "tags", "scope", "created", "updated"]) {
      const v = validateEntry(raw({}, [name]));
      expect(v.issues).toHaveLength(1);
      expect(v.issues[0].code).toBe("required_field_missing");
      expect(v.issues[0].message).toContain(`"${name}"`);
      expect(v.issues[0].hint.length).toBeGreaterThan(0);
      expect(v.frontmatter).toBeUndefined();
    }
  });

  it("treats an explicit YAML null field as missing", () => {
    const v = validateEntry(
      "---\nid:\ntitle: Valid title\ntype: note\ntags: []\nscope: project\ncreated: 2025-08-15T10:00:00.000Z\nupdated: 2025-08-15T11:00:00.000Z\n---\nBody\n",
    );
    expect(codes(v)).toEqual(["required_field_missing"]);
    expect(v.issues[0].message).toContain('"id"');
  });

  it("rejects wrong field types", () => {
    expect(codes(validateEntry(raw({ tags: "deps" })))).toEqual(["field_type_invalid"]);
    expect(codes(validateEntry(raw({ tags: ["a", 2] })))).toEqual(["field_type_invalid"]);
    expect(codes(validateEntry(raw({ author: 42 })))).toEqual(["field_type_invalid"]);
    expect(codes(validateEntry(raw({ pinned: "yes" })))).toEqual(["field_type_invalid"]);
    expect(codes(validateEntry(raw({ id: 7 })))).toEqual(["field_type_invalid"]);
  });

  it("rejects invalid type and scope enum values", () => {
    expect(codes(validateEntry(raw({ type: "blogpost" })))).toEqual(["type_invalid"]);
    expect(codes(validateEntry(raw({ type: 5 })))).toEqual(["type_invalid"]);
    expect(codes(validateEntry(raw({ scope: "team" })))).toEqual(["scope_invalid"]);
  });

  it("rejects empty and malformed ids", () => {
    expect(codes(validateEntry(raw({ id: "" })))).toEqual(["id_invalid"]);
    expect(codes(validateEntry(raw({ id: "abc" })))).toEqual(["id_invalid"]);
    expect(codes(validateEntry(raw({ id: "00001" })))).toEqual(["id_invalid"]);
  });

  it("rejects an empty title", () => {
    expect(codes(validateEntry(raw({ title: "   " })))).toEqual(["title_invalid"]);
    expect(codes(validateEntry(raw({ title: "" })))).toEqual(["title_invalid"]);
  });

  it("validates accepted timestamp forms", () => {
    // canonical UTC (what engram writes), no-milliseconds, and explicit offsets
    expect(validateEntry(raw({ created: "2025-08-15T10:00:00.000Z" })).issues).toEqual([]);
    expect(validateEntry(raw({ created: "2025-08-15T10:00:00Z" })).issues).toEqual([]);
    expect(validateEntry(raw({ created: "2025-08-15T12:00:00+02:00" })).issues).toEqual([]);
  });

  it("rejects unaccepted timestamp forms", () => {
    expect(codes(validateEntry(raw({ created: "2025-08-15" })))).toEqual(["created_invalid"]);
    expect(codes(validateEntry(raw({ created: "08:30" })))).toEqual(["created_invalid"]);
    expect(codes(validateEntry(raw({ created: "yesterday" })))).toEqual(["created_invalid"]);
    expect(codes(validateEntry(raw({ updated: "2025-08-15 11:00:00" })))).toEqual([
      "updated_invalid",
    ]);
  });

  it("rejects updated before created but keeps the entry usable", () => {
    const v = validateEntry(raw({ updated: "2025-08-15T09:59:59.000Z" })); // before created 10:00
    expect(codes(v)).toEqual(["updated_before_created"]);
    // the defect is diagnosed, not hidden: the entry still becomes an Engram
    expect(v.frontmatter).toBeDefined();
  });

  it("collects multiple issues in one pass", () => {
    const fm: Record<string, unknown> = { ...VALID, type: "blogpost" };
    delete fm.title;
    const v = validateEntry(stringifyFrontmatter("Body\n", fm));
    expect(new Set(codes(v))).toEqual(new Set(["required_field_missing", "type_invalid"]));
  });

  it("retains a partial id and title when other fields are invalid", () => {
    const v = validateEntry(raw({ type: "blogpost" }));
    expect(v.frontmatter).toBeUndefined();
    expect(v.partial.id).toBe(VALID_ID);
    expect(v.partial.title).toBe("Valid title");
  });
});
