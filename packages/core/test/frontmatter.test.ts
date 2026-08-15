import { describe, it, expect } from "@effect/vitest";
import { Option, Result } from "effect";
import { parseFrontmatter, stringifyFrontmatter } from "../src/frontmatter.js";

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
