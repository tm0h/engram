import { describe, it, expect } from "vite-plus/test";
import { Schema } from "effect";
import {
  FrontmatterSchema,
  ProjectConfigSchema,
  GlobalConfigSchema,
  EngramTypeSchema,
  ScopeSchema,
  StatusSchema,
  ENGRAM_STATUSES,
  SourceTypeSchema,
  SOURCE_TYPES,
  effectiveStatus,
  SUPPORTED_CONFIG_VERSION,
  SUPPORTED_ENTRY_SCHEMA_VERSION,
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

describe("StatusSchema", () => {
  it("decodes the closed status vocabulary", () => {
    expect(ENGRAM_STATUSES).toEqual(["active", "superseded", "archived"]);
    for (const s of ENGRAM_STATUSES) {
      expect(Schema.decodeSync(StatusSchema)(s)).toBe(s);
    }
  });
  it("rejects statuses outside the enum", () => {
    expect(() => Schema.decodeSync(StatusSchema)("draft" as never)).toThrow();
    expect(() => Schema.decodeSync(StatusSchema)("expired" as never)).toThrow();
    expect(() => Schema.decodeSync(StatusSchema)("bogus" as never)).toThrow();
    expect(() => Schema.decodeSync(StatusSchema)(5 as never)).toThrow();
  });
});

describe("SourceTypeSchema", () => {
  it("decodes the closed source-type vocabulary", () => {
    expect(SOURCE_TYPES).toEqual(["conversation", "file", "url", "command", "other"]);
    for (const t of SOURCE_TYPES) {
      expect(Schema.decodeSync(SourceTypeSchema)(t)).toBe(t);
    }
  });
  it("rejects source types outside the enum", () => {
    expect(() => Schema.decodeSync(SourceTypeSchema)("chatlog" as never)).toThrow();
    expect(() => Schema.decodeSync(SourceTypeSchema)(7 as never)).toThrow();
  });
});

describe("FrontmatterSchema / lifecycle metadata", () => {
  const lifecycle = {
    status: "superseded",
    supersedes: "0001",
    reviewAfter: "2026-01-01T00:00:00.000Z",
    expires: "2026-06-01T00:00:00.000Z",
    sourceType: "conversation",
    sourceRef: "standup notes",
  };
  const v04 = {
    id: "0001",
    title: "Replaced libfoo with libbar",
    type: "decision",
    tags: ["deps", "auth"],
    scope: "project",
    created: "2025-01-15T10:30:00.000Z",
    updated: "2025-01-15T10:30:00.000Z",
  };

  it("decodes a complete object containing all six lifecycle fields", () => {
    const out = Schema.decodeSync(FrontmatterSchema)({ ...v04, ...lifecycle } as never);
    expect(out.status).toBe("superseded");
    expect(out.supersedes).toBe("0001");
    expect(out.reviewAfter).toBe("2026-01-01T00:00:00.000Z");
    expect(out.expires).toBe("2026-06-01T00:00:00.000Z");
    expect(out.sourceType).toBe("conversation");
    expect(out.sourceRef).toBe("standup notes");
  });

  it("keeps a v0.4 object decoding with all six lifecycle fields absent", () => {
    const out = Schema.decodeSync(FrontmatterSchema)(v04 as never);
    expect(out.status).toBeUndefined();
    expect(out.supersedes).toBeUndefined();
    expect(out.reviewAfter).toBeUndefined();
    expect(out.expires).toBeUndefined();
    expect(out.sourceType).toBeUndefined();
    expect(out.sourceRef).toBeUndefined();
  });

  it("rejects an unknown status literal", () => {
    expect(() =>
      Schema.decodeSync(FrontmatterSchema)({ ...v04, status: "draft" } as never),
    ).toThrow();
  });

  it("rejects an unknown source type", () => {
    expect(() =>
      Schema.decodeSync(FrontmatterSchema)({ ...v04, sourceType: "chatlog" } as never),
    ).toThrow();
  });
});

describe("FrontmatterSchema / entry schemaVersion (ENG-41)", () => {
  const v04 = {
    id: "0001",
    title: "Replaced libfoo with libbar",
    type: "decision",
    tags: ["deps", "auth"],
    scope: "project",
    created: "2025-01-15T10:30:00.000Z",
    updated: "2025-01-15T10:30:00.000Z",
  };

  it("exposes SUPPORTED_ENTRY_SCHEMA_VERSION = 1 beside SUPPORTED_CONFIG_VERSION", () => {
    expect(SUPPORTED_ENTRY_SCHEMA_VERSION).toBe(1);
    expect(SUPPORTED_CONFIG_VERSION).toBe(1);
  });

  it("accepts an absent schemaVersion", () => {
    const out = Schema.decodeSync(FrontmatterSchema)(v04 as never);
    expect(out.schemaVersion).toBeUndefined();
  });

  it("accepts integer schemaVersion values", () => {
    expect(
      Schema.decodeSync(FrontmatterSchema)({ ...v04, schemaVersion: 1 } as never).schemaVersion,
    ).toBe(1);
    expect(
      Schema.decodeSync(FrontmatterSchema)({ ...v04, schemaVersion: 2 } as never).schemaVersion,
    ).toBe(2);
  });

  it("rejects a string schemaVersion", () => {
    expect(() =>
      Schema.decodeSync(FrontmatterSchema)({ ...v04, schemaVersion: "2" } as never),
    ).toThrow();
  });

  it("rejects a fractional schemaVersion", () => {
    expect(() =>
      Schema.decodeSync(FrontmatterSchema)({ ...v04, schemaVersion: 1.5 } as never),
    ).toThrow();
  });

  it("rejects a boolean schemaVersion", () => {
    expect(() =>
      Schema.decodeSync(FrontmatterSchema)({ ...v04, schemaVersion: true } as never),
    ).toThrow();
  });

  it("rejects a null schemaVersion (present, but not an integer)", () => {
    expect(() =>
      Schema.decodeSync(FrontmatterSchema)({ ...v04, schemaVersion: null } as never),
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

describe("effectiveStatus (ENG-17)", () => {
  const base = {
    id: "0001",
    title: "t",
    type: "note" as const,
    tags: [],
    scope: "project" as const,
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    author: undefined,
    pinned: false,
    schemaVersion: 1,
    body: "",
    path: "",
  };
  const now = Date.parse("2026-01-15T12:00:00.000Z");
  const iso = (ms: number): string => new Date(ms).toISOString();

  it("treats absent status as active", () => {
    expect(effectiveStatus(base, now)).toBe("active");
  });

  it("treats explicit active as active", () => {
    expect(effectiveStatus({ ...base, status: "active" }, now)).toBe("active");
  });

  it("treats superseded and archived as inactive regardless of expiry", () => {
    expect(effectiveStatus({ ...base, status: "superseded" }, now)).toBe("inactive");
    expect(effectiveStatus({ ...base, status: "archived" }, now)).toBe("inactive");
    expect(effectiveStatus({ ...base, status: "superseded", expires: iso(now + 1) }, now)).toBe(
      "inactive",
    );
  });

  it("inactive when expires < now (boundary now-1ms)", () => {
    expect(effectiveStatus({ ...base, expires: iso(now - 1) }, now)).toBe("inactive");
  });

  it("inactive when expires == now (inclusive boundary)", () => {
    expect(effectiveStatus({ ...base, expires: iso(now) }, now)).toBe("inactive");
  });

  it("active when expires > now (boundary now+1ms)", () => {
    expect(effectiveStatus({ ...base, expires: iso(now + 1) }, now)).toBe("active");
  });

  it("expiry beats explicit active status", () => {
    expect(effectiveStatus({ ...base, status: "active", expires: iso(now - 1) }, now)).toBe(
      "inactive",
    );
  });

  it("reviewAfter does not affect active status (attention-only)", () => {
    expect(effectiveStatus({ ...base, reviewAfter: iso(now - 1) }, now)).toBe("active");
  });

  it("supersedes alone does not make an entry inactive", () => {
    expect(effectiveStatus({ ...base, supersedes: "0000" }, now)).toBe("active");
  });

  it("an unparseable expires value never deactivates (validation reports it)", () => {
    expect(effectiveStatus({ ...base, expires: "not-a-timestamp" }, now)).toBe("active");
  });

  it("defaults now to Date.now()", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(effectiveStatus({ ...base, expires: past })).toBe("inactive");
    expect(effectiveStatus({ ...base, expires: future })).toBe("active");
  });
});
