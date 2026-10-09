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
import {
  MAX_ALIASES,
  MAX_ALIAS_LENGTH,
  normalizeAliases,
  splitAliasList,
  validateAliases,
} from "../src/util.js";

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
    aliases: [],
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

/* ------------------------------------------------------------------ */
/* ENG-46 search aliases                                               */
/* ------------------------------------------------------------------ */

describe("FrontmatterSchema / aliases (ENG-46)", () => {
  const fm = {
    id: "0001",
    title: "T",
    type: "note",
    tags: [],
    scope: "project",
    created: "2025-08-15T10:00:00.000Z",
    updated: "2025-08-15T11:00:00.000Z",
  };

  it("decodes aliases as an optional string list", () => {
    const decoded = Schema.decodeSync(FrontmatterSchema)({ ...fm, aliases: ["pg"] } as never);
    expect(decoded.aliases).toEqual(["pg"]);
  });

  it("absent aliases still decode (backward compatible)", () => {
    expect(Schema.decodeSync(FrontmatterSchema)(fm as never).aliases).toBeUndefined();
  });
});

describe("alias caps (ENG-46)", () => {
  it("exports the documented caps", () => {
    expect(MAX_ALIASES).toBe(20);
    expect(MAX_ALIAS_LENGTH).toBe(80);
  });
});

describe("normalizeAliases (ENG-46)", () => {
  it("trims surrounding whitespace and lowercases", () => {
    expect(normalizeAliases(["  Postgres ", "PG_DUMP"])).toEqual(["postgres", "pg_dump"]);
  });

  it("preserves internal whitespace and never splits on spaces", () => {
    expect(normalizeAliases(["Postgres Row Level Security"])).toEqual([
      "postgres row level security",
    ]);
  });

  it("dedupes after normalization keeping first occurrence order", () => {
    expect(normalizeAliases(["PG", "pg", "Postgres", "postgres"])).toEqual(["pg", "postgres"]);
  });

  it("is idempotent on already-normalized input", () => {
    const once = normalizeAliases(["A", "b", "C"]);
    expect(normalizeAliases([...once])).toEqual(once);
  });
});

describe("validateAliases (ENG-46)", () => {
  it("accepts a valid list and collects no issues", () => {
    expect(validateAliases(["Postgres", "  pg_dump "])).toEqual([]);
  });

  it("rejects empty and whitespace-only members with position numbering", () => {
    const issues = validateAliases(["pg", "", "   "]);
    expect(issues.map((i) => i.message)).toEqual([
      "aliases (position 2) is empty after trimming",
      "aliases (position 3) is empty after trimming",
    ]);
    for (const issue of issues) {
      expect(issue.hint).not.toBe("");
    }
  });

  it("rejects non-string members", () => {
    const issues = validateAliases(["pg", 7, null]);
    expect(issues.map((i) => i.message)).toEqual([
      "aliases (position 2) must be a string, got a number",
      "aliases (position 3) must be a string, got null",
    ]);
  });

  it("counts length in Unicode code points after trimming (80 vs 81)", () => {
    const eighty = "p".repeat(80);
    expect(validateAliases([eighty])).toEqual([]);
    expect(validateAliases([" " + eighty + " "])).toEqual([]);
    const long = validateAliases(["p".repeat(81)]);
    expect(long).toHaveLength(1);
    expect(long[0]!.message).toBe(
      'aliases "' + "p".repeat(81) + '" (position 1) is longer than 80 code points (81)',
    );
    expect(long[0]!.hint).not.toBe("");
  });

  it("counts astral characters as single code points (not UTF-16 units)", () => {
    // 41 emoji are 41 code points but 82 UTF-16 units: still valid
    expect(validateAliases(["\u{1F600}".repeat(41)])).toEqual([]);
    expect(validateAliases(["\u{1F600}".repeat(81)])).toHaveLength(1);
  });

  it("enforces the unique-count cap after normalization (20 vs 21)", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `alias ${i}`);
    expect(validateAliases(twenty)).toEqual([]);
    expect(validateAliases(twenty.map((a) => a.toUpperCase()))).toEqual([]);
    const issues = validateAliases([...twenty, "one more"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toBe("aliases lists 21 unique values; the maximum is 20");
    expect(issues[0]!.hint).not.toBe("");
  });

  it("dedupes BEFORE the count cap (duplicates around the cap stay valid)", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `A${i}`);
    expect(validateAliases([...twenty, ...twenty.map((a) => a.toUpperCase())])).toEqual([]);
  });

  it("measures the cap on the NORMALIZED value (Turkish i expands on lowercase)", () => {
    // 40 raw code points lowercase to exactly 80: still valid
    expect(validateAliases(["\u0130".repeat(40)])).toEqual([]);
    // 41 raw code points lowercase to 82: invalid even though the raw value
    // is only 41 code points (the pre-fix predicate passed this)
    const issues = validateAliases(["\u0130".repeat(41)]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("(82)");
  });

  it("an 80-raw-code-point alias that lowercases to 160 is invalid (P1-3)", () => {
    expect(validateAliases(["\u0130".repeat(80)])).toHaveLength(1);
  });

  it("reports member issues and the count issue in one pass", () => {
    const twentyOne = Array.from({ length: 21 }, (_, i) => `a${i}`);
    const issues = validateAliases([...twentyOne, ""]);
    expect(issues.map((i) => i.message)).toEqual([
      "aliases (position 22) is empty after trimming",
      "aliases lists 21 unique values; the maximum is 20",
    ]);
  });
});

describe("splitAliasList (ENG-46)", () => {
  it("returns undefined for an absent flag value", () => {
    expect(splitAliasList(undefined)).toBeUndefined();
  });

  it("splits on commas only and preserves empty members", () => {
    expect(splitAliasList("a,b")).toEqual(["a", "b"]);
    expect(splitAliasList("")).toEqual([""]);
    expect(splitAliasList("a,,b")).toEqual(["a", "", "b"]);
    expect(splitAliasList(" ,a")).toEqual(["", "a"]);
  });

  it("trims members so an editor round-trip parses back exactly", () => {
    expect(splitAliasList(" Postgres , PG ")).toEqual(["Postgres", "PG"]);
  });

  it("never splits on whitespace (multiword aliases survive)", () => {
    expect(splitAliasList("row level security")).toEqual(["row level security"]);
  });
});
