import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { projectConfigPath, projectEngramsDir } from "@engram/core";
import engramPlugin from "../src/opencode/index.js";

/* ------------------------------- fixtures ------------------------------- */

const seedEntry = (root: string, id: string, title: string, type = "note"): void => {
  const fm = [
    `id: "${id}"`,
    `title: ${JSON.stringify(title)}`,
    `type: ${type}`,
    "tags: []",
    "scope: project",
    "created: 2026-08-16T10:00:00.000Z",
    "updated: 2026-08-16T10:00:00.000Z",
  ].join("\n");
  fs.writeFileSync(
    path.join(projectEngramsDir(root), `${id}-entry.md`),
    `---\n${fm}\n---\nBody of ${title}\n`,
  );
};

const mkProject = (): string => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-oc-"));
  fs.mkdirSync(projectEngramsDir(tmp), { recursive: true });
  fs.writeFileSync(
    projectConfigPath(tmp),
    JSON.stringify({ version: 1, tracked: true, defaultType: "note" }),
  );
  return tmp;
};

interface AnyTool {
  description: string;
  args: Record<string, unknown>;
  execute: (
    args: unknown,
    context: { directory: string },
  ) => Promise<{
    title?: string;
    output: string;
    metadata?: Record<string, unknown>;
  }>;
}

const loadTools = async (): Promise<Record<string, AnyTool>> => {
  const hooks = (await engramPlugin({} as Parameters<typeof engramPlugin>[0])) as {
    tool: Record<string, AnyTool>;
  };
  return hooks.tool;
};

const execute = (tool: AnyTool, args: unknown, directory = process.cwd()) =>
  tool.execute(args, { directory });

interface ToolEnv {
  origCwd: string;
  origHome: string | undefined;
  tmp: string;
  home: string;
}

const enterProject = (): ToolEnv => {
  const env: ToolEnv = {
    origCwd: process.cwd(),
    origHome: process.env.HOME,
    tmp: mkProject(),
    home: fs.mkdtempSync(path.join(os.tmpdir(), "engram-ochome-")),
  };
  process.chdir(env.tmp);
  process.env.HOME = env.home;
  return env;
};

const leaveProject = (env: ToolEnv): void => {
  process.chdir(env.origCwd);
  if (env.origHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = env.origHome;
  }
  fs.rmSync(env.tmp, { recursive: true, force: true });
  fs.rmSync(env.home, { recursive: true, force: true });
};

/* ------------------------------- tests ------------------------------- */

describe("engram opencode plugin / registration", () => {
  it("registers the five engram tools", async () => {
    const tools = await loadTools();
    expect(Object.keys(tools)).toEqual([
      "engram_context",
      "engram_search",
      "engram_show",
      "engram_add",
      "engram_edit",
    ]);
    for (const tool of Object.values(tools)) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.args).toBeDefined();
    }
  });

  it("schemas expose the expected params", async () => {
    const tools = await loadTools();
    expect(Object.keys(tools.engram_context.args)).toEqual(["scope", "limit", "offset"]);
    expect(
      z
        .object(tools.engram_search.args as Record<string, z.ZodType>)
        .safeParse({ query: "auth", explain: true }).success,
    ).toBe(true);
    expect(
      z
        .object(tools.engram_search.args as Record<string, z.ZodType>)
        .safeParse({ query: "auth", explain: "true" }).success,
    ).toBe(false);
    expect(Object.keys(tools.engram_search.args)).toContain("query");
    expect(Object.keys(tools.engram_show.args)).toContain("id");
    expect(Object.keys(tools.engram_add.args)).toEqual([
      "title",
      "body",
      "type",
      "scope",
      "tags",
      "pinned",
      "status",
      "supersedes",
      "reviewAfter",
      "expires",
      "sourceType",
      "sourceRef",
      "allowSecrets",
    ]);
    expect(Object.keys(tools.engram_edit.args)).toEqual([
      "id",
      "scope",
      "title",
      "type",
      "tags",
      "body",
      "pinned",
      "author",
      "status",
      "supersedes",
      "reviewAfter",
      "expires",
      "sourceType",
      "sourceRef",
      "allowSecrets",
    ]);
  });
});

describe("engram opencode plugin / tool execution", () => {
  let env: ToolEnv;
  beforeEach(() => {
    env = enterProject();
  });
  afterEach(() => {
    leaveProject(env);
  });

  it("engram_context returns the digest with metadata", async () => {
    seedEntry(env.tmp, "0001", "Use pnpm catalogs", "decision");
    const tools = await loadTools();

    const res = await execute(tools.engram_context, {});
    expect(res.output).toContain("Use pnpm catalogs");
    expect(res.metadata).toMatchObject({ total: 1, isError: false });
  });

  it("resolves project scope from the tool context directory, not process.cwd()", async () => {
    seedEntry(env.tmp, "0001", "Context workspace entry", "decision");
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "engram-oc-other-"));
    process.chdir(other);
    try {
      const tools = await loadTools();
      const res = await execute(tools.engram_context, { scope: "project" }, env.tmp);
      expect(res.output).toContain("Context workspace entry");
      expect(res.metadata).toMatchObject({ total: 1, isError: false });
    } finally {
      process.chdir(env.tmp);
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("engram_search finds entries by keyword", async () => {
    seedEntry(env.tmp, "0001", "Auth uses JWT");
    const tools = await loadTools();

    const res = await execute(tools.engram_search, { query: "auth" });
    expect(res.output).toContain("Auth uses JWT");
    expect(res.metadata).toMatchObject({ total: 1, isError: false });
  });

  it("engram_add writes, then engram_context lists the new entry", async () => {
    const tools = await loadTools();

    const res = await execute(tools.engram_add, {
      title: "Chose Vitest over Jest",
      body: "native ESM support",
      type: "decision",
      tags: ["testing"],
    });
    expect(res.metadata?.isError).toBe(false);
    expect(fs.existsSync(res.metadata?.path as string)).toBe(true);

    const digest = await execute(tools.engram_context, {});
    expect(digest.output).toContain("Chose Vitest over Jest");
  });

  it("engram_add passes lifecycle params through to the store", async () => {
    const tools = await loadTools();

    const res = await execute(tools.engram_add, {
      title: "Recorded with lifecycle",
      body: "b",
      status: "superseded",
      reviewAfter: "2026-01-01T00:00:00.000Z",
      sourceType: "file",
      sourceRef: "docs/a.md",
    });
    expect(res.metadata?.isError).toBe(false);
    const content = fs.readFileSync(res.metadata?.path as string, "utf8");
    expect(content).toContain("status: superseded");
    expect(content).toContain("reviewAfter: 2026-01-01T00:00:00.000Z");
    expect(content).toContain("sourceType: file");
  });

  it("engram_edit replaces ordinary fields including pinned and author", async () => {
    seedEntry(env.tmp, "0001", "Original title");
    const tools = await loadTools();

    const res = await execute(tools.engram_edit, {
      id: "0001",
      title: "Edited title",
      type: "decision",
      tags: ["edited"],
      body: "Edited body",
      pinned: true,
      author: "New Author",
    });
    expect(res.metadata?.isError).toBe(false);
    expect(res.output).toContain("Edited title");
    expect(res.metadata).toMatchObject({ id: "0001", scope: "project", type: "decision" });
    const content = fs.readFileSync(res.metadata?.path as string, "utf8");
    expect(content).toContain("Edited body");
    expect(content).toMatch(/^type: decision$/m);
    expect(content).toMatch(/^pinned: true$/m);
    expect(content).toMatch(/^author: New Author$/m);
    expect(fs.existsSync(path.join(projectEngramsDir(env.tmp), "0001-entry.md"))).toBe(false);
  });

  it("engram_edit sets, changes, and clears all six lifecycle fields", async () => {
    seedEntry(env.tmp, "0001", "Lifecycle target");
    // ENG-17 R5: supersedes targets must exist; R1: re-pointing is rejected,
    // so the change step clears the link before setting the new target.
    seedEntry(env.tmp, "0002", "First target");
    seedEntry(env.tmp, "0003", "Second target");
    const tools = await loadTools();
    const keys = ["status", "supersedes", "reviewAfter", "expires", "sourceType", "sourceRef"];
    const fileOf = async (params: Record<string, unknown>): Promise<string> => {
      const res = await execute(tools.engram_edit, params);
      expect(res.metadata?.isError).toBe(false);
      return res.metadata?.path as string;
    };

    const setFile = await fileOf({
      id: "0001",
      status: "active",
      supersedes: "0002",
      reviewAfter: "2027-01-01T00:00:00.000Z",
      expires: "2027-06-01T00:00:00.000Z",
      sourceType: "file",
      sourceRef: "docs/a.md",
    });
    let content = fs.readFileSync(setFile, "utf8");
    expect(content).toMatch(/^status: active$/m);
    expect(content).toMatch(/^supersedes: "0002"$/m);
    expect(content).toMatch(/^reviewAfter: 2027-01-01T00:00:00\.000Z$/m);
    expect(content).toMatch(/^expires: 2027-06-01T00:00:00\.000Z$/m);
    expect(content).toMatch(/^sourceType: file$/m);
    expect(content).toMatch(/^sourceRef: docs\/a\.md$/m);

    // clear only the link, then establish the new target (R1: no repointing)
    await fileOf({ id: "0001", supersedes: null });
    const changeFile = await fileOf({
      id: "0001",
      status: "archived",
      supersedes: "0003",
      reviewAfter: "2028-01-01T00:00:00.000Z",
      expires: "2028-06-01T00:00:00.000Z",
      sourceType: "url",
      sourceRef: "https://example.com/a",
    });
    content = fs.readFileSync(changeFile, "utf8");
    expect(content).toMatch(/^status: archived$/m);
    expect(content).toMatch(/^supersedes: "0003"$/m);
    expect(content).toMatch(/^reviewAfter: 2028-01-01T00:00:00\.000Z$/m);
    expect(content).toMatch(/^expires: 2028-06-01T00:00:00\.000Z$/m);
    expect(content).toMatch(/^sourceType: url$/m);
    expect(content).toMatch(/^sourceRef: https:\/\/example\.com\/a$/m);

    const clearFile = await fileOf({
      id: "0001",
      status: null,
      supersedes: null,
      reviewAfter: null,
      expires: null,
      sourceType: null,
      sourceRef: null,
    });
    content = fs.readFileSync(clearFile, "utf8");
    for (const key of keys) {
      expect(content, key).not.toMatch(new RegExp(`^${key}:`, "m"));
    }
  });

  it("engram_edit unpinning with pinned: false works", async () => {
    seedEntry(env.tmp, "0001", "Pinned once");
    const tools = await loadTools();

    const pin = await execute(tools.engram_edit, { id: "0001", pinned: true });
    expect(pin.metadata?.isError).toBe(false);
    expect(fs.readFileSync(pin.metadata?.path as string, "utf8")).toMatch(/^pinned: true$/m);

    const unpin = await execute(tools.engram_edit, { id: "0001", pinned: false });
    expect(unpin.metadata?.isError).toBe(false);
    expect(fs.readFileSync(unpin.metadata?.path as string, "utf8")).not.toMatch(/^pinned:/m);
  });

  it("engram_edit on an unknown id sets metadata.isError", async () => {
    const tools = await loadTools();
    const res = await execute(tools.engram_edit, { id: "9999", title: "X" });
    expect(res.metadata?.isError).toBe(true);
    expect(res.output).toContain("9999");
  });

  it("engram_show slices long bodies and names the next call", async () => {
    const tools = await loadTools();

    const added = await execute(tools.engram_add, { title: "Long", body: "x".repeat(5000) });
    const id = added.metadata?.id as string;

    const page = await execute(tools.engram_show, { id, limit: 100 });
    expect(page.metadata?.isError).toBe(false);
    expect(page.output).toContain("engram_show(");
    expect(page.metadata?.nextOffset).toBeGreaterThan(0);
  });

  it("engram_show on an unknown id sets metadata.isError", async () => {
    const tools = await loadTools();

    const res = await execute(tools.engram_show, { id: "9999" });
    expect(res.metadata?.isError).toBe(true);
    expect(res.output).toContain("9999");
  });

  it("outside a project, reads fall back to personal scope with a note", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "engram-ocempty-"));
    process.chdir(empty);
    try {
      const tools = await loadTools();
      const res = await execute(tools.engram_context, {});
      expect(res.output).toContain("personal scope only");
      expect(res.metadata?.personalOnly).toBe(true);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("engram opencode plugin / lifecycle schema contract", () => {
  it("engram_add args enforce the lifecycle enums (zod safeParse)", async () => {
    const tools = await loadTools();
    const args = tools.engram_add.args as Record<string, z.ZodType>;

    for (const status of ["active", "superseded", "archived"]) {
      expect(args.status.safeParse(status).success, status).toBe(true);
    }
    expect(args.status.safeParse("bogus").success).toBe(false);

    for (const sourceType of ["conversation", "file", "url", "command", "other"]) {
      expect(args.sourceType.safeParse(sourceType).success, sourceType).toBe(true);
    }
    expect(args.sourceType.safeParse("website").success).toBe(false);

    expect(args.reviewAfter.safeParse("2026-01-01T00:00:00.000Z").success).toBe(true);
    expect(args.expires.safeParse("2026-06-01T00:00:00.000Z").success).toBe(true);
    expect(args.supersedes.safeParse("0001").success).toBe(true);
    expect(args.sourceRef.safeParse("docs/a.md").success).toBe(true);
    // ENG-15: allowSecrets validates as a strict boolean
    expect(args.allowSecrets.safeParse(true).success).toBe(true);
    expect(args.allowSecrets.safeParse("yes").success).toBe(false);
  });

  it("lifecycle param descriptions state the real contract without overclaims", async () => {
    const tools = await loadTools();
    const args = tools.engram_add.args as Record<string, z.ZodType & { description?: string }>;

    expect(args.status.description).toContain("active | superseded | archived");
    expect(args.sourceType.description).toContain("conversation | file | url | command | other");
    for (const field of ["supersedes", "reviewAfter", "expires", "sourceRef"] as const) {
      expect(args[field]?.description, field).toMatch(/when saved/);
      expect(args[field]?.description, field).not.toMatch(/schema|type:|must be a valid/);
    }
  });

  it("engram_edit args accept the three-state lifecycle and reject bad shapes (zod safeParse)", async () => {
    const tools = await loadTools();
    const schema = z.object(tools.engram_edit.args as z.ZodRawShape);
    const base = { id: "0001" };
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);

    for (const type of ["decision", "fact", "preference", "note", "issue", "context"]) {
      expect(schema.safeParse({ ...base, type }).success, type).toBe(true);
    }
    expect(schema.safeParse({ ...base, type: "bogus" }).success).toBe(false);
    expect(schema.safeParse({ ...base, type: null }).success).toBe(false);

    for (const status of ["active", "superseded", "archived", null]) {
      expect(schema.safeParse({ ...base, status }).success, String(status)).toBe(true);
    }
    expect(schema.safeParse({ ...base, status: "bogus" }).success).toBe(false);

    for (const sourceType of ["conversation", "file", "url", "command", "other", null]) {
      expect(schema.safeParse({ ...base, sourceType }).success, String(sourceType)).toBe(true);
    }
    expect(schema.safeParse({ ...base, sourceType: "website" }).success).toBe(false);

    expect(schema.safeParse({ ...base, supersedes: "0001" }).success).toBe(true);
    expect(schema.safeParse({ ...base, supersedes: null }).success).toBe(true);
    expect(schema.safeParse({ ...base, supersedes: 5 }).success).toBe(false);
    expect(schema.safeParse({ ...base, reviewAfter: "2026-01-01" }).success).toBe(true);
    expect(schema.safeParse({ ...base, reviewAfter: null }).success).toBe(true);
    expect(schema.safeParse({ ...base, expires: null }).success).toBe(true);
    expect(schema.safeParse({ ...base, sourceRef: null }).success).toBe(true);

    expect(schema.safeParse({ ...base, title: "New" }).success).toBe(true);
    expect(schema.safeParse({ ...base, title: null }).success).toBe(false);
    expect(schema.safeParse({ ...base, tags: ["a"] }).success).toBe(true);
    expect(schema.safeParse({ ...base, tags: "a,b" }).success).toBe(false);
    expect(schema.safeParse({ ...base, tags: null }).success).toBe(false);
    expect(schema.safeParse({ ...base, body: null }).success).toBe(false);
    expect(schema.safeParse({ ...base, pinned: false }).success).toBe(true);
    expect(schema.safeParse({ ...base, pinned: null }).success).toBe(false);
    expect(schema.safeParse({ ...base, author: null }).success).toBe(false);
    expect(schema.safeParse({ ...base, scope: "bogus" }).success).toBe(false);
    expect(schema.safeParse({ ...base, id: 5 }).success).toBe(false);
  });

  it("engram_edit param descriptions state the real contract without overclaims", async () => {
    const tools = await loadTools();
    const args = tools.engram_edit.args as Record<string, z.ZodType & { description?: string }>;

    for (const field of [
      "status",
      "supersedes",
      "reviewAfter",
      "expires",
      "sourceType",
      "sourceRef",
    ] as const) {
      expect(args[field]?.description, field).toMatch(/null clears/i);
      expect(args[field]?.description, field).toMatch(/omit to preserve/i);
    }
    for (const field of ["supersedes", "reviewAfter", "expires", "sourceRef"] as const) {
      expect(args[field]?.description, field).toMatch(/when saved/);
      expect(args[field]?.description, field).not.toMatch(/schema|type:|must be a valid/);
    }
    for (const field of ["title", "type", "tags", "body", "pinned", "author"] as const) {
      expect(args[field]?.description, field).toMatch(/omit to preserve/i);
      expect(args[field]?.description, field).not.toMatch(/null clears/i);
    }
  });
});
