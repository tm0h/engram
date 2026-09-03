import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { z } from "zod";
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
  it("registers the four engram tools", async () => {
    const tools = await loadTools();
    expect(Object.keys(tools)).toEqual([
      "engram_context",
      "engram_search",
      "engram_show",
      "engram_add",
    ]);
    for (const tool of Object.values(tools)) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.args).toBeDefined();
    }
  });

  it("schemas expose the expected params", async () => {
    const tools = await loadTools();
    expect(Object.keys(tools.engram_context.args)).toEqual(["scope", "limit", "offset"]);
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
});
