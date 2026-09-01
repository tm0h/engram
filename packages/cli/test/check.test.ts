/**
 * `engram check` command tests: scope resolution, per-diagnostic-class
 * failures, human + JSON rendering, and exit-effect behavior. Runs the real
 * command Effect over MainLive (or a wrapped-FS layer for unreadable-file
 * cases) with stdout/stderr captured; nothing here shells out. Process-level
 * exit behavior is covered separately in process.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import { Effect, Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import { FileSystem } from "effect/FileSystem";
import { systemError } from "effect/PlatformError";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ConfigRepo,
  ConfigRepoLive,
  EngramStore,
  EngramStoreLive,
  MainLive,
  projectConfigPath,
  projectEngramsDir,
  slugify,
  stringifyFrontmatter,
} from "@engram/core";
import { checkCommand } from "../src/commands/check.js";

/* ------------------------------ helpers ------------------------------ */

const fm = (over: Record<string, unknown> = {}, omit: ReadonlyArray<string> = []): string => {
  const data: Record<string, unknown> = {
    id: "0001",
    title: "Sample note",
    type: "note",
    tags: [],
    scope: "project",
    created: "2025-08-15T10:00:00.000Z",
    updated: "2025-08-15T11:00:00.000Z",
    ...over,
  };
  for (const key of omit) delete data[key];
  return stringifyFrontmatter("Body\n", data);
};

const mkProject = (): string => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-cli-check-"));
  fs.mkdirSync(projectEngramsDir(tmp), { recursive: true });
  fs.writeFileSync(
    projectConfigPath(tmp),
    JSON.stringify({ version: 1, tracked: true, defaultType: "note" }),
  );
  return tmp;
};

const mkPlain = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "engram-cli-plain-"));

const mkHome = (): string => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-cli-chome-"));
  fs.mkdirSync(path.join(tmp, ".engram", "engrams"), { recursive: true });
  return tmp;
};

const seed = (proj: string, name: string, content: string): string => {
  const file = path.join(projectEngramsDir(proj), name);
  fs.writeFileSync(file, content);
  return file;
};

const seedConsistent = (
  proj: string,
  id: string,
  title: string,
  over: Record<string, unknown> = {},
): string => seed(proj, `${id}-${slugify(title)}.md`, fm({ id, title, ...over }));

/** A layer like MainLive but with `readFileString` failing for paths
 * matching `blocked` (simulates EACCES without chmod). Built directly on
 * NodeServices (not on MainLive) so layer memoization cannot reintroduce
 * the unwrapped FileSystem. */
const blockedReadLive = (blocked: (p: string) => boolean) => {
  const FailingFs = Layer.effect(
    FileSystem,
    Effect.gen(function* () {
      const real = yield* FileSystem;
      return {
        ...real,
        readFileString: (p: string) =>
          blocked(p)
            ? Effect.fail(
                systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readFileString",
                  pathOrDescriptor: p,
                  syscall: "open",
                }),
              )
            : real.readFileString(p),
      } satisfies FileSystem;
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  return Layer.mergeAll(
    EngramStoreLive.pipe(Layer.provide(FailingFs), Layer.provide(NodeServices.layer)),
    ConfigRepoLive.pipe(Layer.provide(FailingFs), Layer.provide(NodeServices.layer)),
    NodeServices.layer,
  );
};

/** Like `blockedReadLive` but blocks `readDirectory` — the store directory
 * itself cannot be listed, so that scope cannot be checked at all. */
const blockedDirLive = (blocked: (p: string) => boolean) => {
  const FailingFs = Layer.effect(
    FileSystem,
    Effect.gen(function* () {
      const real = yield* FileSystem;
      return {
        ...real,
        readDirectory: (p: string) =>
          blocked(p)
            ? Effect.fail(
                systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readDirectory",
                  pathOrDescriptor: p,
                  syscall: "open",
                }),
              )
            : real.readDirectory(p),
      } satisfies FileSystem;
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  return Layer.mergeAll(
    EngramStoreLive.pipe(Layer.provide(FailingFs), Layer.provide(NodeServices.layer)),
    ConfigRepoLive.pipe(Layer.provide(FailingFs), Layer.provide(NodeServices.layer)),
    NodeServices.layer,
  );
};

interface FailInfo {
  readonly _tag: string;
  readonly message?: string;
}

describe("engram check", () => {
  let origCwd = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  let outLines: string[] = [];
  let errLines: string[] = [];
  let spies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    origCwd = process.cwd();
    origHome = process.env.HOME;
    tmp = mkProject();
    home = mkHome();
    process.chdir(tmp);
    process.env.HOME = home;
    outLines = [];
    errLines = [];
    spies = [
      vi.spyOn(console, "log").mockImplementation(((...args: unknown[]) => {
        outLines.push(args.map(String).join(" "));
        return undefined;
      }) as typeof console.log),
      vi.spyOn(console, "error").mockImplementation(((...args: unknown[]) => {
        errLines.push(args.map(String).join(" "));
        return undefined;
      }) as typeof console.error),
    ];
  });
  afterEach(() => {
    for (const s of spies) s.mockRestore();
    process.chdir(origCwd);
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  const output = (): string => outLines.join("\n");
  const errors = (): string => errLines.join("\n");

  const run = (eff: Effect.Effect<unknown, unknown, EngramStore | ConfigRepo>): Promise<void> =>
    Effect.runPromise(Effect.provide(eff as never, MainLive)) as Promise<void>;

  const runFail = (
    eff: Effect.Effect<unknown, unknown, EngramStore | ConfigRepo>,
    layer?: Layer.Layer<EngramStore | ConfigRepo, never, never>,
  ): Promise<FailInfo> =>
    Effect.runPromise(
      Effect.provide(Effect.flip(eff) as never, layer ?? MainLive),
    ) as Promise<FailInfo>;

  const addPersonal = (title: string): Promise<unknown> =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* EngramStore;
          return yield* store.add("personal", {
            title,
            type: "note",
            tags: [],
            body: "b",
            pinned: false,
            author: undefined,
          });
        }),
        MainLive,
      ),
    );

  const addProject = (title: string): Promise<unknown> =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const store = yield* EngramStore;
          return yield* store.add("project", {
            title,
            type: "note",
            tags: [],
            body: "b",
            pinned: false,
            author: undefined,
          });
        }),
        MainLive,
      ),
    );

  /* ------------------------ scope resolution ------------------------ */

  it("a clean project scope prints success (default scope)", async () => {
    await addProject("First note");
    await addProject("Second note");
    await run(checkCommand({}));
    expect(output()).toContain("project:");
    expect(output()).toContain("2 files checked");
    expect(output()).toContain("no problems found");
  });

  it("a clean personal scope prints success", async () => {
    await addPersonal("Personal note");
    await run(checkCommand({ scope: "personal" }));
    expect(output()).toContain("personal:");
    expect(output()).toContain("1 files checked");
    expect(output()).toContain("no problems found");
    expect(errors()).toBe("");
  });

  it("all reports both scopes", async () => {
    await addProject("Project note");
    await addPersonal("Personal note");
    await run(checkCommand({ scope: "all" }));
    expect(output()).toContain("project:");
    expect(output()).toContain("personal:");
  });

  it("an invalid explicit scope fails before scanning", async () => {
    const info = await runFail(checkCommand({ scope: "bogus" }));
    expect(info._tag).toBe("ValidationError");
    expect(info.message).toContain('invalid scope "bogus"');
    expect(output()).toBe("");
  });

  it("explicit project outside an initialized project reports the scope uncheckable", async () => {
    process.chdir(mkPlain());
    const info = await runFail(checkCommand({ scope: "project" }));
    // the report renders, then the command fails with the summary error
    expect(info._tag).toBe("IntegrityCheckFailedError");
    expect(info.message).toContain("project scope could not be checked");
    expect(output()).toContain("project: could not be checked");
    expect(output()).toContain('no .engram/ project found in "');
    expect(output()).toContain("engram init");
  });

  it("all outside a project does not silently report success", async () => {
    process.chdir(mkPlain());
    const info = await runFail(checkCommand({ scope: "all" }));
    // personal is still checked and reported...
    expect(output()).toContain("personal:");
    expect(output()).toContain("no problems found");
    // ...but project is named as unchecked and the command fails
    expect(output()).toContain("project: could not be checked");
    expect(output()).toContain("engram init");
    expect(info._tag).toBe("IntegrityCheckFailedError");
    expect(info.message).toContain("project scope could not be checked");
  });

  /* ------------------------ diagnostic classes ------------------------ */

  const CASES: ReadonlyArray<{ code: string; setup: (proj: string) => void }> = [
    { code: "frontmatter_missing", setup: (p) => seed(p, "0001-plain.md", "Just markdown\n") },
    {
      code: "yaml_invalid",
      setup: (p) => seed(p, "0001-broken.md", "---\ntitle: [unclosed\n---\nBody\n"),
    },
    {
      code: "frontmatter_not_object",
      setup: (p) => seed(p, "0001-scalar.md", "---\njust a string\n---\nBody\n"),
    },
    {
      code: "required_field_missing",
      setup: (p) => seed(p, "0001-sample-note.md", fm({}, ["title"])),
    },
    {
      code: "field_type_invalid",
      setup: (p) => seed(p, "0001-sample-note.md", fm({ tags: "deps" })),
    },
    {
      code: "type_invalid",
      setup: (p) => seed(p, "0001-sample-note.md", fm({ type: "blogpost" })),
    },
    { code: "scope_invalid", setup: (p) => seed(p, "0001-sample-note.md", fm({ scope: "team" })) },
    { code: "id_invalid", setup: (p) => seed(p, "0001-sample-note.md", fm({ id: "zzz" })) },
    { code: "title_invalid", setup: (p) => seed(p, "0001-sample-note.md", fm({ title: "   " })) },
    {
      code: "created_invalid",
      setup: (p) => seed(p, "0001-sample-note.md", fm({ created: "yesterday" })),
    },
    {
      code: "updated_invalid",
      setup: (p) => seed(p, "0001-sample-note.md", fm({ updated: "2025-08-15 11:00:00" })),
    },
    {
      code: "updated_before_created",
      setup: (p) => seed(p, "0001-sample-note.md", fm({ updated: "2025-08-14T10:00:00.000Z" })),
    },
    { code: "filename_invalid", setup: (p) => seed(p, "notanid.md", fm({ id: "0001" })) },
    {
      code: "filename_id_mismatch",
      setup: (p) => seed(p, "0002-sample-note.md", fm({ id: "0001" })),
    },
    {
      code: "filename_slug_mismatch",
      setup: (p) => seed(p, "0001-old-slug.md", fm({ title: "New title" })),
    },
    {
      code: "scope_mismatch",
      setup: (p) => seedConsistent(p, "0001", "Stray note", { scope: "personal" }),
    },
    {
      code: "duplicate_id",
      setup: (p) => {
        seedConsistent(p, "0001", "Dup a");
        seedConsistent(p, "0001", "Dup b");
      },
    },
    { code: "config_json_invalid", setup: (p) => fs.writeFileSync(projectConfigPath(p), "{oops") },
    {
      code: "config_schema_invalid",
      setup: (p) => fs.writeFileSync(projectConfigPath(p), JSON.stringify({ version: 1 })),
    },
    {
      code: "config_version_unsupported",
      setup: (p) =>
        fs.writeFileSync(
          projectConfigPath(p),
          JSON.stringify({ version: 99, tracked: true, defaultType: "note" }),
        ),
    },
  ];

  for (const { code, setup } of CASES) {
    it(`fails for ${code}`, async () => {
      setup(tmp);
      const info = await runFail(checkCommand({}));
      expect(info._tag).toBe("IntegrityCheckFailedError");
      expect(output()).toContain(`[${code}]`);
    });
  }

  it("fails for file_unreadable (wrapped filesystem)", async () => {
    const broken = seed(tmp, "0001-sample-note.md", fm());
    seedConsistent(tmp, "0002", "Healthy note");
    const info = await runFail(checkCommand({}), blockedReadLive((p) => p === broken) as never);
    expect(info._tag).toBe("IntegrityCheckFailedError");
    expect(output()).toContain("[file_unreadable]");
    expect(output()).toContain(broken);
    // the healthy sibling is still counted, not hidden
    expect(output()).toContain("2 files checked");
  });

  it("fails for config_unreadable (wrapped filesystem)", async () => {
    const info = await runFail(
      checkCommand({}),
      blockedReadLive((p) => p === projectConfigPath(tmp)) as never,
    );
    expect(info._tag).toBe("IntegrityCheckFailedError");
    expect(output()).toContain("[config_unreadable]");
  });

  /* ------------------------ rendering ------------------------ */

  it("human output includes exact paths, stable codes, reasons, and hints", async () => {
    seed(tmp, "0002-sample-note.md", fm({ id: "0001" })); // filename_id_mismatch
    seed(tmp, "0001-broken.md", "---\ntitle: [unclosed\n---\nBody\n"); // yaml_invalid
    const info = await runFail(checkCommand({}));
    expect(info._tag).toBe("IntegrityCheckFailedError");
    const o = output();
    expect(o).toContain("[filename_id_mismatch]");
    expect(o).toContain("[yaml_invalid]");
    expect(o).toContain(path.join(projectEngramsDir(tmp), "0002-sample-note.md"));
    expect(o).toContain(path.join(projectEngramsDir(tmp), "0001-broken.md"));
    expect(o).toContain('filename id "0002" does not match frontmatter id "0001"');
    expect(o).toContain("Fix the filename prefix or frontmatter id so they agree.");
    expect(o).toContain("invalid YAML");
  });

  it("multiple defects render in deterministic order", async () => {
    seedConsistent(tmp, "0001", "A", { scope: "personal" }); // scope_mismatch
    seed(tmp, "0002-b.md", "---\ntitle: [unclosed\n---\n"); // yaml_invalid
    seed(tmp, "0003-c.md", fm({ title: "C", type: "blogpost" })); // type_invalid
    await runFail(checkCommand({}));
    const first = output();
    const i1 = first.indexOf("[scope_mismatch]");
    const i2 = first.indexOf("[yaml_invalid]");
    const i3 = first.indexOf("[type_invalid]");
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
    // rerun produces byte-identical output
    outLines = [];
    await runFail(checkCommand({}));
    expect(output()).toBe(first);
  });

  it("json output parses and matches the stable schema (success)", async () => {
    await addProject("First note");
    await addProject("Second note");
    await run(checkCommand({ json: true }));
    const doc = JSON.parse(output()) as Record<string, unknown>;
    expect(doc).toMatchObject({
      ok: true,
      scopes: ["project"],
      filesChecked: 2,
      validEntries: 2,
      omittedFiles: 0,
      diagnostics: [],
    });
  });

  it("json failure output remains valid json on stdout", async () => {
    seed(tmp, "0002-sample-note.md", fm({ id: "0001" }));
    const info = await runFail(checkCommand({ json: true }));
    expect(info._tag).toBe("IntegrityCheckFailedError");
    // exactly one JSON document on stdout, and it is the failure report
    const doc = JSON.parse(output()) as {
      ok: boolean;
      scopes: string[];
      filesChecked: number;
      validEntries: number;
      omittedFiles: number;
      diagnostics: Array<Record<string, string>>;
    };
    expect(doc.ok).toBe(false);
    expect(doc.scopes).toEqual(["project"]);
    expect(doc.filesChecked).toBe(1);
    // a filename/id mismatch is a cross-check defect: the frontmatter itself
    // is valid, so the entry is still listed (and the store can be repaired
    // without data loss)
    expect(doc.validEntries).toBe(1);
    expect(doc.omittedFiles).toBe(0);
    expect(doc.diagnostics).toHaveLength(1);
    expect(doc.diagnostics[0]).toMatchObject({
      code: "filename_id_mismatch",
      severity: "error",
      scope: "project",
      file: path.join(projectEngramsDir(tmp), "0002-sample-note.md"),
    });
    expect(typeof doc.diagnostics[0].message).toBe("string");
    expect(typeof doc.diagnostics[0].hint).toBe("string");
  });

  it("json all-outside-project keeps stdout parseable", async () => {
    process.chdir(mkPlain());
    const info = await runFail(checkCommand({ scope: "all", json: true }));
    expect(info._tag).toBe("IntegrityCheckFailedError");
    const doc = JSON.parse(output()) as {
      ok: boolean;
      scopes: string[];
      uncheckableScopes: Array<{ scope: string; message: string; hint: string }>;
    };
    expect(doc.ok).toBe(false);
    expect(doc.scopes).toEqual(["personal"]);
    // the unchecked scope and its actionable reason live in the document
    expect(doc.uncheckableScopes).toHaveLength(1);
    expect(doc.uncheckableScopes[0].scope).toBe("project");
    expect(doc.uncheckableScopes[0].message).toContain("no .engram/ project found");
    expect(doc.uncheckableScopes[0].hint).toContain("engram init");
  });

  it("json explicit uncheckable project scope still emits a parseable report", async () => {
    process.chdir(mkPlain());
    const info = await runFail(checkCommand({ scope: "project", json: true }));
    expect(info._tag).toBe("IntegrityCheckFailedError");
    const doc = JSON.parse(output()) as {
      ok: boolean;
      scopes: string[];
      filesChecked: number;
      diagnostics: ReadonlyArray<unknown>;
      uncheckableScopes: Array<{ scope: string; message: string; hint: string }>;
    };
    expect(doc.ok).toBe(false);
    expect(doc.scopes).toEqual([]);
    expect(doc.filesChecked).toBe(0);
    expect(doc.diagnostics).toEqual([]);
    expect(doc.uncheckableScopes).toHaveLength(1);
    expect(doc.uncheckableScopes[0].scope).toBe("project");
    expect(doc.uncheckableScopes[0].hint).toContain("engram init");
  });

  it("a scope whose directory cannot be listed is reported uncheckable", async () => {
    const dir = projectEngramsDir(tmp);
    const info = await runFail(
      checkCommand({ scope: "all" }),
      blockedDirLive((p) => p === dir) as never,
    );
    expect(info._tag).toBe("IntegrityCheckFailedError");
    expect(info.message).toContain("project scope could not be checked");
    expect(output()).toContain("personal:");
    expect(output()).toContain("project: could not be checked");
    expect(output()).toContain(dir);
  });

  it("json unlistable directory keeps stdout parseable", async () => {
    const dir = projectEngramsDir(tmp);
    const info = await runFail(
      checkCommand({ scope: "all", json: true }),
      blockedDirLive((p) => p === dir) as never,
    );
    expect(info._tag).toBe("IntegrityCheckFailedError");
    const doc = JSON.parse(output()) as {
      ok: boolean;
      scopes: string[];
      uncheckableScopes: Array<{ scope: string; message: string }>;
    };
    expect(doc.ok).toBe(false);
    expect(doc.scopes).toEqual(["personal"]);
    expect(doc.uncheckableScopes).toHaveLength(1);
    expect(doc.uncheckableScopes[0].scope).toBe("project");
    expect(doc.uncheckableScopes[0].message).toContain(dir);
  });
});
