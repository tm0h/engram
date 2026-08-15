import { describe, it, expect } from "vite-plus/test";
import { Schema } from "effect";
import {
  FrontmatterSchema,
  ProjectConfigSchema,
  GlobalConfigSchema,
  EngramTypeSchema,
  ScopeSchema,
} from "../src/domain.js";

describe("EngramTypeSchema", () => {
  it("decodes valid types", () => {
    for (const t of ["decision", "fact", "note"] as const) {
      expect(Schema.decodeSync(EngramTypeSchema)(t)).toBe(t);
    }
  });
  it("rejects invalid types", () => {
    expect(() => Schema.decodeSync(EngramTypeSchema)("bogus" as never)).toThrow();
  });
});

describe("ScopeSchema", () => {
  it("accepts personal and project only", () => {
    expect(Schema.decodeSync(ScopeSchema)("personal")).toBe("personal");
    expect(() => Schema.decodeSync(ScopeSchema)("team" as never)).toThrow();
  });
});

describe("FrontmatterSchema", () => {
  const valid = {
    id: "0001",
    title: "Replaced libfoo with libbar",
    type: "decision",
    tags: ["deps", "auth"],
    scope: "project",
    created: "2025-01-15T10:30:00.000Z",
    updated: "2025-01-15T10:30:00.000Z",
    author: "mohammad",
    pinned: true,
  };

  it("decodes a complete frontmatter object", () => {
    const out = Schema.decodeSync(FrontmatterSchema)(valid as never);
    expect(out.id).toBe("0001");
    expect(out.pinned).toBe(true);
    expect(out.author).toBe("mohammad");
  });

  it("tolerates missing optional fields (author/pinned)", () => {
    const { author, pinned, ...rest } = valid;
    void author;
    void pinned;
    const out = Schema.decodeSync(FrontmatterSchema)(rest as never);
    expect(out.author).toBeUndefined();
    // optional field is literally absent in the source file
    expect(out.pinned).toBeUndefined();
  });

  it("rejects an invalid type", () => {
    expect(() =>
      Schema.decodeSync(FrontmatterSchema)({ ...valid, type: "bogus" } as never),
    ).toThrow();
  });
});

describe("config schemas", () => {
  it("decodes a project config", () => {
    const out = Schema.decodeSync(ProjectConfigSchema)({
      version: 1,
      tracked: true,
      defaultType: "note",
    });
    expect(out.tracked).toBe(true);
    expect(out.defaultType).toBe("note");
  });

  it("decodes a global config", () => {
    const out = Schema.decodeSync(GlobalConfigSchema)({
      version: 1,
      author: "mohammad",
    });
    expect(out.author).toBe("mohammad");
  });
});
