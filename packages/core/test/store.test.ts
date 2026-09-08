import { describe, it, expect, beforeEach, afterEach } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { systemError } from "effect/PlatformError";
import { NodeServices } from "@effect/platform-node";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EngramStore,
  EngramStoreLive,
  lifecycleDiagnostics,
  type ScanOptions,
} from "../src/store.js";
import { projectConfigPath, projectEngramsDir, globalEngramsDir } from "../src/paths.js";
import { stringifyFrontmatter } from "../src/frontmatter.js";
import { slugify } from "../src/util.js";
import type { Engram, EngramInput, EngramPatch } from "../src/domain.js";

/** ENG-15: these tests exercise legacy CRUD behavior with scanning disabled; the scan gate has its own coverage. */
const NOSCAN = { policy: "off" as const, allowSecrets: false };

const StoreLive = EngramStoreLive.pipe(Layer.provide(NodeServices.layer));

/** A store whose first `n` exclusive (`wx`) writes fail with EEXIST —
 * simulates another process winning the exact-filename race. Records every
 * path attempted with `wx` so tests can assert retries use fresh filenames. */
const flakyWxStoreLive = (failures: number) => {
  const wxPaths: string[] = [];
  const FlakyFs = Layer.effect(
    FileSystem,
    Effect.gen(function* () {
      const real = yield* FileSystem;
      let left = failures;
      type WriteStringArgs = Parameters<typeof real.writeFileString>;
      const wrapped: FileSystem = {
        ...real,
        writeFileString: (...args: WriteStringArgs) => {
          const [p, d, o] = args;
          if (o?.flag === "wx") {
            wxPaths.push(p);
            if (left-- > 0) {
              return Effect.fail(
                systemError({
                  _tag: "AlreadyExists",
                  module: "FileSystem",
                  method: "writeFile",
                  pathOrDescriptor: p,
                  syscall: "open",
                  cause: new Error("simulated EEXIST"),
                }),
              );
            }
          }
          return real.writeFileString(p, d, o);
        },
      };
      return wrapped;
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  const layer = EngramStoreLive.pipe(Layer.provide(FlakyFs), Layer.provide(NodeServices.layer));
  return { layer, wxPaths };
};

/** New-format ids: 26 lowercase Crockford-base32 chars (timestamp + randomness). */
const ULID = /^[0-9a-hjkmnp-tv-z]{26}$/;

const input = (over: Partial<EngramInput> = {}): EngramInput => ({
  title: "Replaced libfoo with libbar",
  type: "decision",
  tags: ["deps", "auth"],
  body: "libfoo had an engram leak under load",
  pinned: false,
  author: undefined,
  ...over,
});

const mkProject = (): string => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amem-"));
  fs.mkdirSync(projectEngramsDir(tmp), { recursive: true });
  fs.writeFileSync(
    projectConfigPath(tmp),
    JSON.stringify({ version: 1, tracked: true, defaultType: "note" }),
  );
  return tmp;
};

describe("EngramStore / project scope", () => {
  let orig = "";
  let tmp = "";
  beforeEach(() => {
    orig = process.cwd();
    tmp = mkProject();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(orig);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.live("add -> list -> get -> remove", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const m = yield* store.add("project", input(), NOSCAN);
      expect(m.id).toMatch(ULID);
      expect(m.path).toContain(`${m.id}-replaced-libfoo-with-libbar.md`);

      const all = yield* store.list("project");
      expect(all).toHaveLength(1);
      expect(all[0].title).toBe("Replaced libfoo with libbar");

      const got = yield* store.get("project", m.id);
      expect(got.id).toBe(m.id);

      const prefix = yield* store.get("project", m.id.slice(0, 4));
      expect(prefix.id).toBe(m.id);

      yield* store.remove("project", m.id);
      expect(yield* store.list("project")).toHaveLength(0);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("assigns unique, time-sortable ids (no shared counter)", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const a = yield* store.add("project", input({ title: "A" }), NOSCAN);
      const b = yield* store.add("project", input({ title: "B" }), NOSCAN);
      const c = yield* store.add("project", input({ title: "C" }), NOSCAN);
      const ids = [a.id, b.id, c.id];
      expect(new Set(ids).size).toBe(3);
      // lexicographic order == creation order, so listing stays chronological
      // without any coordination between sessions or machines
      expect([...ids].sort()).toEqual(ids);
      const all = yield* store.list("project");
      expect(all.map((m) => m.title)).toEqual(["A", "B", "C"]);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("normalizes pinned to false when unspecified", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      yield* store.add("project", input(), NOSCAN);
      const [m] = yield* store.list("project");
      expect(m.pinned).toBe(false);
      expect(m.type).toBe("decision");
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("fails on unknown id", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      return yield* store.get("project", "9999");
    }).pipe(
      Effect.provide(StoreLive),
      Effect.flip,
      Effect.map((e) => expect((e as { _tag: string })._tag).toBe("EngramNotFoundError")),
    ),
  );

  it.live("update: patches given fields, preserves the rest, bumps updated", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const m = yield* store.add("project", input(), NOSCAN);
      yield* Effect.sleep("5 millis");

      const patched = yield* store.update(
        "project",
        m.id,
        {
          body: "new body text",
          tags: ["new-tag"],
        },
        NOSCAN,
      );

      expect(patched.id).toBe(m.id);
      expect(patched.created).toBe(m.created);
      expect(patched.updated > m.updated).toBe(true);
      // patched fields
      expect(patched.body).toBe("new body text");
      expect(patched.tags).toEqual(["new-tag"]);
      // preserved fields
      expect(patched.title).toBe(m.title);
      expect(patched.type).toBe("decision");
      expect(patched.pinned).toBe(false);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("update: retitle renames the file to the new slug", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const m = yield* store.add("project", input({ title: "Old title" }), NOSCAN);
      expect(fs.existsSync(m.path)).toBe(true);

      const patched = yield* store.update(
        "project",
        m.id,
        {
          title: "A brand new title",
        },
        NOSCAN,
      );

      expect(patched.path).toContain(`${m.id}-a-brand-new-title.md`);
      expect(fs.existsSync(patched.path)).toBe(true);
      expect(fs.existsSync(m.path)).toBe(false);

      const got = yield* store.get("project", m.id);
      expect(got.title).toBe("A brand new title");
      expect(got.body).toBe("libfoo had an engram leak under load");
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("update: toggles pinned and persists it", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const m = yield* store.add("project", input(), NOSCAN);

      yield* store.update("project", m.id, { pinned: true }, NOSCAN);
      const [pinned] = yield* store.list("project");
      expect(pinned.pinned).toBe(true);

      yield* store.update("project", m.id, { pinned: false }, NOSCAN);
      const [unpinned] = yield* store.list("project");
      expect(unpinned.pinned).toBe(false);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("update: resolves id prefixes like get", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const m = yield* store.add("project", input(), NOSCAN);
      const patched = yield* store.update(
        "project",
        m.id.slice(0, 6),
        { title: "Via prefix" },
        NOSCAN,
      );
      expect(patched.title).toBe("Via prefix");
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("update: unknown id fails with EngramNotFoundError", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      return yield* store.update("project", "9999", { title: "nope" }, NOSCAN);
    }).pipe(
      Effect.provide(StoreLive),
      Effect.flip,
      Effect.map((e) => expect((e as { _tag: string })._tag).toBe("EngramNotFoundError")),
    ),
  );
});

describe("EngramStore / file parsing", () => {
  let orig = "";
  let tmp = "";
  const engramsDir = (): string => projectEngramsDir(tmp);
  beforeEach(() => {
    orig = process.cwd();
    tmp = mkProject();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(orig);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.live("reads a hand-written file with a BOM", () =>
    Effect.gen(function* () {
      const file = path.join(engramsDir(), "0001-bom.md");
      fs.writeFileSync(
        file,
        `\uFEFF---\nid: "0001"\ntitle: BOM file\ntype: note\ntags: []\nscope: project\ncreated: 2025-08-15T10:00:00.000Z\nupdated: 2025-08-15T10:00:00.000Z\n---\nBOM body\n`,
      );
      const store = yield* EngramStore;
      const [m] = yield* store.list("project");
      expect(m.title).toBe("BOM file");
      expect(m.body).toBe("BOM body");
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("reads a hand-written CRLF file", () =>
    Effect.gen(function* () {
      const file = path.join(engramsDir(), "0001-crlf.md");
      fs.writeFileSync(
        file,
        '---\r\nid: "0001"\r\ntitle: CRLF file\r\ntype: note\r\ntags: []\r\nscope: project\r\ncreated: 2025-08-15T10:00:00.000Z\r\nupdated: 2025-08-15T10:00:00.000Z\r\n---\r\nWindows body\r\n',
      );
      const store = yield* EngramStore;
      const [m] = yield* store.list("project");
      expect(m.title).toBe("CRLF file");
      expect(m.body).toBe("Windows body");
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("preserves --- separators inside the body across update", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const m = yield* store.add("project", input({ body: "Intro\n\n---\n\nSection two" }), NOSCAN);
      const got = yield* store.get("project", m.id);
      expect(got.body).toBe("Intro\n\n---\n\nSection two");
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("scan reports invalid YAML instead of dropping it; get() names the failure", () =>
    Effect.gen(function* () {
      const file = path.join(engramsDir(), "0001-broken.md");
      fs.writeFileSync(file, "---\ntitle: [unclosed\n---\nBody\n");
      const store = yield* EngramStore;

      // list keeps its compatibility shape: only valid entries, none here…
      expect(yield* store.list("project")).toEqual([]);

      // …but scan exposes the exact defect instead of silently omitting the file
      const scanned = yield* store.scan("project");
      expect(scanned.filesChecked).toBe(1);
      expect(scanned.omittedFiles).toBe(1);
      expect(scanned.entries).toEqual([]);
      expect(scanned.diagnostics.map((d) => [d.code, d.file])).toEqual([["yaml_invalid", file]]);

      // a direct get for that file's id reports the parse failure, not "missing"
      return yield* store.get("project", "0001");
    }).pipe(
      Effect.provide(StoreLive),
      Effect.flip,
      Effect.map((e) => {
        expect((e as { _tag: string })._tag).toBe("FrontmatterParseError");
        expect((e as unknown as { file: string }).file).toBe(
          path.join(engramsDir(), "0001-broken.md"),
        );
        expect((e as unknown as { message: string }).message).toContain("invalid YAML");
      }),
    ),
  );
});

describe("EngramStore / id allocation & duplicates", () => {
  let orig = "";
  let tmp = "";
  const engramsDir = (): string => projectEngramsDir(tmp);
  /** Simulate a harness/agent hand-writing an engram file with a guessed id. */
  const handWrite = (
    filename: string,
    id: string,
    title: string,
    created = "2025-08-15T10:00:00.000Z",
  ): string => {
    const file = path.join(engramsDir(), filename);
    fs.writeFileSync(
      file,
      `---\nid: "${id}"\ntitle: ${title}\ntype: note\ntags: []\nscope: project\ncreated: ${created}\nupdated: ${created}\n---\nhand-written body\n`,
    );
    return file;
  };
  beforeEach(() => {
    orig = process.cwd();
    tmp = mkProject();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(orig);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.live("add never reuses a legacy numeric id, even with the same slug", () => {
    const original = handWrite("0001-replaced-libfoo-with-libbar.md", "0001", "Hand-written");
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const m = yield* store.add("project", input(), NOSCAN);
      // random id, not 0002 or any reuse of the legacy sequence
      expect(m.id).toMatch(ULID);
      expect(m.path).not.toContain("0001-");
      expect(fs.readFileSync(original, "utf8")).toContain("hand-written body");
      expect(fs.readdirSync(engramsDir())).toHaveLength(2);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("legacy numeric ids remain addressable (get/update by prefix)", () => {
    handWrite("0001-legacy.md", "0001", "Legacy note");
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const got = yield* store.get("project", "0");
      expect(got.title).toBe("Legacy note");
      const patched = yield* store.update("project", "0001", { title: "Renamed" }, NOSCAN);
      expect(patched.id).toBe("0001");
      expect(patched.path).toContain("0001-renamed.md");
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("concurrent adds allocate unique ids", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const added = yield* Effect.forEach(
        Array.from({ length: 6 }, (_, i) => input({ title: `Concurrent ${i}` })),
        (inp) => store.add("project", inp, NOSCAN),
        { concurrency: "unbounded" },
      );
      const ids = added.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
      const all = yield* store.list("project");
      expect(all).toHaveLength(6);
      expect(new Set(all.map((m) => m.id)).size).toBe(6);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("add retries past an EEXIST race on the exact filename", () => {
    const { layer, wxPaths } = flakyWxStoreLive(2);
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      // two exclusive-write race losses — add must retry, each time with a
      // fresh filename (retrying the same path could never succeed)
      const m = yield* store.add("project", input(), NOSCAN);
      expect(m.id).toMatch(ULID);
      expect(fs.existsSync(m.path)).toBe(true);
      expect(wxPaths).toHaveLength(3); // 2 losses + the successful write
      expect(new Set(wxPaths).size).toBe(3);
      expect(wxPaths[2]).toBe(m.path);
    }).pipe(Effect.provide(layer));
  });

  it.live("get fails with DuplicateIdError when two files share an id", () => {
    const a = handWrite("0001-a.md", "0001", "A");
    const b = handWrite("0001-b.md", "0001", "B");
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      return yield* store.get("project", "0001");
    }).pipe(
      Effect.provide(StoreLive),
      Effect.flip,
      Effect.map((e) => {
        expect((e as { _tag: string })._tag).toBe("DuplicateIdError");
        expect((e as unknown as { files: string[] }).files).toEqual([a, b]);
      }),
    );
  });
  it.live("dedupe: earliest-created keeps the id, rest get fresh ULIDs", () => {
    // written out of order to prove file order doesn't matter; B is newer
    handWrite("0001-b.md", "0001", "B", "2025-08-16T09:00:00.000Z");
    handWrite("0001-a.md", "0001", "A", "2025-08-15T09:00:00.000Z");
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const { renumbered } = yield* store.dedupe("project");
      expect(renumbered).toEqual([{ from: "0001", to: expect.stringMatching(ULID), title: "B" }]);

      const all = yield* store.list("project");
      const ids = all.map((m) => m.id);
      expect(ids).toContain("0001");
      expect(ids.filter((id) => id !== "0001")).toEqual([expect.stringMatching(ULID)]);
      expect(all.map((m) => m.title).sort()).toEqual(["A", "B"]);
      expect(all.every((m) => m.body === "hand-written body")).toBe(true);

      // the survivor of the disputed id is the earliest-created record
      const got = yield* store.get("project", "0001");
      expect(got.title).toBe("A");

      // second run is a no-op
      const again = yield* store.dedupe("project");
      expect(again.renumbered).toEqual([]);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("dedupe leaves a clean store untouched", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      yield* store.add("project", input(), NOSCAN);
      const { renumbered } = yield* store.dedupe("project");
      expect(renumbered).toEqual([]);
      expect(yield* store.list("project")).toHaveLength(1);
    }).pipe(Effect.provide(StoreLive)),
  );
});

describe("EngramStore / project not initialized", () => {
  let orig = "";
  let tmp = "";
  beforeEach(() => {
    orig = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amem-empty-"));
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(orig);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.live("list fails with ProjectNotInitializedError", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      return yield* store.list("project");
    }).pipe(
      Effect.provide(StoreLive),
      Effect.flip,
      Effect.map((e) => expect((e as { _tag: string })._tag).toBe("ProjectNotInitializedError")),
    ),
  );
});

describe("EngramStore / personal scope", () => {
  let origHome: string | undefined;
  let tmp = "";
  beforeEach(() => {
    origHome = process.env.HOME;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amem-home-"));
    process.env.HOME = tmp;
  });
  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.live("persists to ~/.engram (overridden HOME)", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const m = yield* store.add("personal", input(), NOSCAN);
      expect(m.id).toMatch(ULID);
      expect(m.path).toContain(".engram");
      const all = yield* store.list("personal");
      expect(all).toHaveLength(1);
    }).pipe(Effect.provide(StoreLive)),
  );
});

/* ------------------------------------------------------------------ */
/* scan: store integrity diagnostics                                 */
/* ------------------------------------------------------------------ */

/** A full valid entry body, with per-test overrides. */
const SCAN_ID = "01arz3ndektsv4rrffq69g5fav";

const scanFm = (over: Record<string, unknown> = {}): string => {
  const fm: Record<string, unknown> = {
    id: SCAN_ID,
    title: "Scan note",
    type: "note",
    tags: [],
    scope: "project",
    created: "2025-08-15T10:00:00.000Z",
    updated: "2025-08-15T11:00:00.000Z",
    ...over,
  };
  return stringifyFrontmatter("Scan body\n", fm);
};

describe("EngramStore / scan", () => {
  let orig = "";
  let tmp = "";
  const engramsDir = (): string => projectEngramsDir(tmp);

  const write = (name: string, content: string): string => {
    const file = path.join(engramsDir(), name);
    fs.writeFileSync(file, content);
    return file;
  };
  /** Write a fully consistent entry: `<id>-<slugify(title)>.md`. */
  const writeConsistent = (id: string, title: string, over: Record<string, unknown> = {}): string =>
    write(`${id}-${slugify(title)}.md`, scanFm({ id, title, ...over }));
  const tuples = (scanned: { diagnostics: ReadonlyArray<{ code: string; file: string }> }) =>
    scanned.diagnostics.map((d) => [path.basename(d.file), d.code]);

  beforeEach(() => {
    orig = process.cwd();
    tmp = mkProject();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(orig);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.live("a generated v0.4 project store passes unchanged", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      yield* store.add("project", input({ title: "First decision" }), NOSCAN);
      yield* store.add("project", input({ title: "Second note", type: "note" }), NOSCAN);
      writeConsistent("0001", "Legacy note");

      const scanned = yield* store.scan("project");
      expect(scanned.scope).toBe("project");
      expect(scanned.directory).toBe(engramsDir());
      expect(scanned.filesChecked).toBe(3);
      expect(scanned.omittedFiles).toBe(0);
      expect(scanned.diagnostics).toEqual([]);
      expect(scanned.entries).toHaveLength(3);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("legacy four-digit entries pass", () => {
    writeConsistent("0001", "Legacy note");
    writeConsistent("0042", "Another legacy note");
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const scanned = yield* store.scan("project");
      expect(scanned.diagnostics).toEqual([]);
      expect(scanned.entries.map((m) => m.id).sort()).toEqual(["0001", "0042"]);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("a mixed store returns valid entries plus exact diagnostics", () => {
    const good = writeConsistent("0001", "Good note");
    const bad = write("0002-broken.md", "---\ntitle: [unclosed\n---\nBody\n");
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const scanned = yield* store.scan("project");
      expect(scanned.filesChecked).toBe(2);
      expect(scanned.omittedFiles).toBe(1);
      expect(scanned.entries.map((m) => m.path)).toEqual([good]);
      expect(tuples(scanned)).toEqual([["0002-broken.md", "yaml_invalid"]]);
      // compatibility list() is just the valid entries
      expect((yield* store.list("project")).map((m) => m.path)).toEqual([good]);
      expect(bad).toBeTruthy();
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("missing frontmatter is diagnosed", () => {
    write("0001-plain.md", "Just markdown, no frontmatter.\n");
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const scanned = yield* store.scan("project");
      expect(tuples(scanned)).toEqual([["0001-plain.md", "frontmatter_missing"]]);
      expect(scanned.entries).toEqual([]);
      expect(scanned.omittedFiles).toBe(1);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("an invalid filename shape is diagnosed but the entry is kept", () => {
    write("notanid.md", scanFm({ id: "0001", title: "Badly named" }));
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const scanned = yield* store.scan("project");
      expect(tuples(scanned)).toEqual([["notanid.md", "filename_invalid"]]);
      expect(scanned.entries).toHaveLength(1);
      expect(scanned.omittedFiles).toBe(0);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("a filename id mismatch is diagnosed", () => {
    write("0002-scan-note.md", scanFm());
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const scanned = yield* store.scan("project");
      expect(tuples(scanned)).toEqual([["0002-scan-note.md", "filename_id_mismatch"]]);
      expect(scanned.diagnostics[0].message).toContain('"0002"');
      expect(scanned.diagnostics[0].message).toContain(`"${SCAN_ID}"`);
      expect(scanned.entries).toHaveLength(1);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("a filename slug mismatch is diagnosed", () => {
    write(`${SCAN_ID}-old-slug.md`, scanFm());
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const scanned = yield* store.scan("project");
      expect(tuples(scanned)).toEqual([[`${SCAN_ID}-old-slug.md`, "filename_slug_mismatch"]]);
      expect(scanned.entries).toHaveLength(1);
      expect(scanned.omittedFiles).toBe(0);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("a scope mismatch is diagnosed in the project direction", () => {
    writeConsistent("0001", "Misplaced note", { scope: "personal" });
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const scanned = yield* store.scan("project");
      expect(tuples(scanned)).toEqual([["0001-misplaced-note.md", "scope_mismatch"]]);
      expect(scanned.entries).toHaveLength(1);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("duplicate ids produce per-file diagnostics naming the others", () => {
    const a = writeConsistent("0001", "Duplicate a");
    const b = writeConsistent("0001", "Duplicate b");
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const scanned = yield* store.scan("project");
      const dupes = scanned.diagnostics.filter((d) => d.code === "duplicate_id");
      expect(dupes.map((d) => path.basename(d.file)).sort()).toEqual([
        "0001-duplicate-a.md",
        "0001-duplicate-b.md",
      ]);
      for (const d of dupes) {
        const other = d.file === a ? b : a;
        expect(d.message).toContain(`"0001"`);
        expect(d.message).toContain(other);
      }
      // duplicates are repairable, so the entries stay listed
      expect(scanned.entries).toHaveLength(2);
      expect(scanned.omittedFiles).toBe(0);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("duplicate detection uses partial ids from otherwise invalid frontmatter", () => {
    writeConsistent("0001", "Duplicate a");
    write("0001-duplicate-b.md", scanFm({ id: "0001", title: "Duplicate b", type: "blogpost" }));
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const scanned = yield* store.scan("project");
      const codesByName = scanned.diagnostics.reduce<Record<string, string[]>>((acc, d) => {
        const name = path.basename(d.file);
        acc[name] = [...(acc[name] ?? []), d.code];
        return acc;
      }, {});
      // the invalid file is omitted with its own defect… (codes sort
      // alphabetically within a file: duplicate_id < type_invalid)
      expect(codesByName["0001-duplicate-b.md"]).toEqual(["duplicate_id", "type_invalid"]);
      // …and still participates in duplicate detection
      expect(codesByName["0001-duplicate-a.md"]).toEqual(["duplicate_id"]);
      expect(scanned.entries).toHaveLength(1);
      expect(scanned.omittedFiles).toBe(1);
      // the claim is structured scan data, not prose to re-parse
      expect(scanned.duplicateIds).toEqual([
        {
          id: "0001",
          files: [
            path.join(engramsDir(), "0001-duplicate-a.md"),
            path.join(engramsDir(), "0001-duplicate-b.md"),
          ],
        },
      ]);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("get refuses to pick when an invalid file shares a valid entry's id", () => {
    const valid = writeConsistent("0001", "Valid claimant");
    const invalid = write(
      "0001-invalid-claimant.md",
      scanFm({ id: "0001", title: "Invalid claimant", type: "blogpost" }),
    );
    const validBefore = fs.readFileSync(valid, "utf8");
    const invalidBefore = fs.readFileSync(invalid, "utf8");
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const e = yield* Effect.flip(store.get("project", "0001"));
      expect((e as { _tag: string })._tag).toBe("DuplicateIdError");
      // both claimants are named, valid and invalid alike
      expect((e as unknown as { files: string[] }).files.sort()).toEqual([invalid, valid].sort());
      // neither file changed
      expect(fs.readFileSync(valid, "utf8")).toBe(validBefore);
      expect(fs.readFileSync(invalid, "utf8")).toBe(invalidBefore);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("update refuses when an invalid file shares the id", () => {
    const valid = writeConsistent("0001", "Valid claimant");
    const invalid = write(
      "0001-invalid-claimant.md",
      scanFm({ id: "0001", title: "Invalid claimant", type: "blogpost" }),
    );
    const validBefore = fs.readFileSync(valid, "utf8");
    const invalidBefore = fs.readFileSync(invalid, "utf8");
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      return yield* store.update("project", "0001", { title: "Rewritten" }, NOSCAN);
    }).pipe(
      Effect.provide(StoreLive),
      Effect.flip,
      Effect.map((e) => {
        expect((e as { _tag: string })._tag).toBe("DuplicateIdError");
        expect(fs.readFileSync(valid, "utf8")).toBe(validBefore);
        expect(fs.readFileSync(invalid, "utf8")).toBe(invalidBefore);
      }),
    );
  });

  it.live("remove refuses when an invalid file shares the id", () => {
    const valid = writeConsistent("0001", "Valid claimant");
    const invalid = write(
      "0001-invalid-claimant.md",
      scanFm({ id: "0001", title: "Invalid claimant", type: "blogpost" }),
    );
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      return yield* store.remove("project", "0001");
    }).pipe(
      Effect.provide(StoreLive),
      Effect.flip,
      Effect.map((e) => {
        expect((e as { _tag: string })._tag).toBe("DuplicateIdError");
        // nothing was deleted
        expect(fs.existsSync(valid)).toBe(true);
        expect(fs.existsSync(invalid)).toBe(true);
      }),
    );
  });

  it.live("get by prefix also refuses a duplicated id", () => {
    writeConsistent("0001", "Duplicate a");
    write("0001-duplicate-b.md", scanFm({ id: "0001", title: "Duplicate b", type: "blogpost" }));
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      return yield* store.get("project", "000");
    }).pipe(
      Effect.provide(StoreLive),
      Effect.flip,
      Effect.map((e) => expect((e as { _tag: string })._tag).toBe("DuplicateIdError")),
    );
  });

  it.live("invalid and reversed timestamps are diagnosed", () => {
    writeConsistent("0001", "Bad created", { created: "yesterday" });
    writeConsistent("0002", "Reversed dates", { updated: "2025-08-14T10:00:00.000Z" });
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const scanned = yield* store.scan("project");
      expect(tuples(scanned)).toEqual([
        ["0001-bad-created.md", "created_invalid"],
        ["0002-reversed-dates.md", "updated_before_created"],
      ]);
      // the reversed-but-parseable entry stays usable; the invalid one is omitted
      expect(scanned.omittedFiles).toBe(1);
      expect(scanned.entries.map((m) => m.id)).toEqual(["0002"]);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("diagnostic ordering is deterministic", () => {
    // written out of sorted order; defects picked so one file has two codes
    writeConsistent("0002", "B", { scope: "personal", updated: "2025-08-14T10:00:00.000Z" });
    writeConsistent("0000", "A", { id: "0001" });
    write(`${SCAN_ID}-broken-type.md`, scanFm({ title: "Broken type", type: "blogpost" }));
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const scanned = yield* store.scan("project");
      // sorted by absolute path, then code within a file
      expect(tuples(scanned)).toEqual([
        ["0000-a.md", "filename_id_mismatch"],
        ["0002-b.md", "scope_mismatch"],
        ["0002-b.md", "updated_before_created"],
        [`${SCAN_ID}-broken-type.md`, "type_invalid"],
      ]);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("dedupe refuses to mutate a store with defects beyond duplicates", () => {
    writeConsistent("0001", "Duplicate a");
    writeConsistent("0001", "Duplicate b");
    writeConsistent("0009", "Stray note", { scope: "personal" }); // scope_mismatch
    const before = fs.readdirSync(engramsDir()).sort();
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      return yield* store.dedupe("project");
    }).pipe(
      Effect.provide(StoreLive),
      Effect.flip,
      Effect.map((e) => {
        expect((e as { _tag: string })._tag).toBe("IntegrityCheckFailedError");
        expect((e as unknown as { message: string }).message).toContain("duplicate ids");
        expect(fs.readdirSync(engramsDir()).sort()).toEqual(before);
      }),
    );
  });

  it.live("dedupe repairs a store whose only defect is duplicate ids", () => {
    writeConsistent("0001", "Duplicate a");
    writeConsistent("0001", "Duplicate b");
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const { renumbered } = yield* store.dedupe("project");
      expect(renumbered).toHaveLength(1);
      const scanned = yield* store.scan("project");
      expect(scanned.diagnostics).toEqual([]);
      expect(scanned.entries).toHaveLength(2);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("dedupe refuses to mutate a partially readable store", () => {
    writeConsistent("0001", "Duplicate a");
    writeConsistent("0001", "Duplicate b");
    write("0002-broken.md", "---\ntitle: [unclosed\n---\nBody\n");
    const before = fs.readdirSync(engramsDir()).sort();
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      return yield* store.dedupe("project");
    }).pipe(
      Effect.provide(StoreLive),
      Effect.flip,
      Effect.map((e) => {
        expect((e as { _tag: string })._tag).toBe("IntegrityCheckFailedError");
        expect((e as unknown as { message: string }).message).toContain("0002-broken.md");
        // nothing was rewritten
        expect(fs.readdirSync(engramsDir()).sort()).toEqual(before);
      }),
    );
  });

  /* --------- dedupe vs advisory lifecycle warnings (ENG-13) --------- */

  it.live("dedupe repairs duplicates past an expired entry (advisory)", () => {
    writeConsistent("0001", "Duplicate a", { expires: "2020-01-01T00:00:00.000Z" });
    writeConsistent("0001", "Duplicate b");
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const { renumbered } = yield* store.dedupe("project");
      expect(renumbered).toHaveLength(1);
      const scanned = yield* store.scan("project");
      // duplicates are repaired; the advisory expiry warning remains
      expect(scanned.diagnostics.map((d) => [d.code, d.severity])).toEqual([
        ["expired", "warning"],
      ]);
      expect(scanned.entries).toHaveLength(2);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("dedupe repairs duplicates past a due review (advisory)", () => {
    writeConsistent("0001", "Duplicate a");
    writeConsistent("0001", "Duplicate b", { reviewAfter: "2020-01-01T00:00:00.000Z" });
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const { renumbered } = yield* store.dedupe("project");
      expect(renumbered).toHaveLength(1);
      const scanned = yield* store.scan("project");
      // the renumbered copy keeps its reviewAfter; the warning stays advisory
      expect(scanned.diagnostics.map((d) => [d.code, d.severity])).toEqual([
        ["review_due", "warning"],
      ]);
      expect(scanned.entries).toHaveLength(2);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("dedupe repairs duplicates past a dangling supersedes (advisory)", () => {
    writeConsistent("0001", "Duplicate a");
    writeConsistent("0001", "Duplicate b", { supersedes: "0099" });
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const { renumbered } = yield* store.dedupe("project");
      expect(renumbered).toHaveLength(1);
      const scanned = yield* store.scan("project");
      expect(scanned.diagnostics.map((d) => [d.code, d.severity])).toEqual([
        ["supersedes_not_found", "warning"],
      ]);
      expect(scanned.entries).toHaveLength(2);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("dedupe preserves lifecycle metadata on the surviving file", () => {
    const kept = writeConsistent("0001", "Duplicate a", {
      status: "archived",
      reviewAfter: "2030-01-01T00:00:00.000Z",
      expires: "2031-01-01T00:00:00.000Z",
    });
    writeConsistent("0001", "Duplicate b");
    const before = fs.readFileSync(kept, "utf8");
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const { renumbered } = yield* store.dedupe("project");
      expect(renumbered).toHaveLength(1);
      // the winner is untouched: byte-identical file, lifecycle fields intact
      expect(fs.readFileSync(kept, "utf8")).toBe(before);
      const m = yield* store.get("project", "0001");
      expect(m.status).toBe("archived");
      expect(m.reviewAfter).toBe("2030-01-01T00:00:00.000Z");
      expect(m.expires).toBe("2031-01-01T00:00:00.000Z");
      // future timestamps parse cleanly: no diagnostics left at all
      const scanned = yield* store.scan("project");
      expect(scanned.diagnostics).toEqual([]);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("dedupe still refuses on an error-severity defect (invalid expires)", () => {
    writeConsistent("0001", "Duplicate a");
    writeConsistent("0001", "Duplicate b");
    writeConsistent("0009", "Broken expiry", { expires: "soon" }); // expires_invalid
    const before = fs.readdirSync(engramsDir()).sort();
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      return yield* store.dedupe("project");
    }).pipe(
      Effect.provide(StoreLive),
      Effect.flip,
      Effect.map((e) => {
        expect((e as { _tag: string })._tag).toBe("IntegrityCheckFailedError");
        expect((e as unknown as { message: string }).message).toContain("0009-broken-expiry.md");
        expect(fs.readdirSync(engramsDir()).sort()).toEqual(before);
      }),
    );
  });

  /* ------------------ ENG-13 lifecycle diagnostics ------------------ */

  it.live("a dangling supersedes is a warning and the entry is retained", () => {
    const file = writeConsistent("0001", "Dangling ref", { supersedes: "0099" });
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const scanned = yield* store.scan("project");
      expect(scanned.diagnostics.map((d) => [d.code, d.severity])).toEqual([
        ["supersedes_not_found", "warning"],
      ]);
      expect(scanned.diagnostics[0].file).toBe(file);
      expect(scanned.diagnostics[0].message).toContain('"0099"');
      // the entry is kept and the store is not considered incomplete
      expect(scanned.entries.map((m) => m.id)).toEqual(["0001"]);
      expect(scanned.omittedFiles).toBe(0);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("no supersedes warning when the claimant exists", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const pred = yield* store.add("project", input({ title: "Predecessor" }), NOSCAN);
      // the referrer has its own id and points back at the predecessor
      write("0002-referrer.md", scanFm({ id: "0002", title: "Referrer", supersedes: pred.id }));
      const scanned = yield* store.scan("project");
      expect(scanned.diagnostics).toEqual([]);
      expect(scanned.entries).toHaveLength(2);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("no supersedes warning for a legacy-id claimant", () => {
    writeConsistent("0001", "Legacy predecessor");
    write("0002-referrer.md", scanFm({ id: "0002", title: "Referrer", supersedes: "0001" }));
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const scanned = yield* store.scan("project");
      expect(scanned.diagnostics).toEqual([]);
      expect(scanned.entries).toHaveLength(2);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("a claimant that is itself invalid still counts as present", () => {
    // the claimant file has a valid id but an invalid type, so only its
    // partial id participates; that is enough to keep the reference honest
    write(
      "0001-invalid-claimant.md",
      scanFm({ id: "0001", title: "Invalid claimant", type: "blogpost" }),
    );
    write("0002-referrer.md", scanFm({ id: "0002", title: "Referrer", supersedes: "0001" }));
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const scanned = yield* store.scan("project");
      expect(scanned.diagnostics.map((d) => d.code)).toEqual(["type_invalid"]);
      expect(scanned.diagnostics.every((d) => d.severity === "error")).toBe(true);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("due and expired warnings fire for past timestamps, not future ones", () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    writeConsistent("0001", "Due for review", { reviewAfter: past });
    writeConsistent("0002", "Expired note", { expires: past });
    writeConsistent("0003", "Still fresh", { reviewAfter: future, expires: future });
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const scanned = yield* store.scan("project");
      expect(tuples(scanned)).toEqual([
        ["0001-due-for-review.md", "review_due"],
        ["0002-expired-note.md", "expired"],
      ]);
      // all three entries are retained; no omitted files
      expect(scanned.entries).toHaveLength(3);
      expect(scanned.omittedFiles).toBe(0);
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("invalid lifecycle values are errors that omit the entry", () => {
    writeConsistent("0001", "Bad status", { status: "draft" });
    writeConsistent("0002", "Self ref", { supersedes: "0002" });
    writeConsistent("0003", "Bad review", { reviewAfter: "2026-01-01" });
    writeConsistent("0004", "Bad source", { sourceType: "chatlog" });
    writeConsistent("0005", "Empty ref", { sourceRef: "   " });
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const scanned = yield* store.scan("project");
      expect(tuples(scanned)).toEqual([
        ["0001-bad-status.md", "status_invalid"],
        ["0002-self-ref.md", "self_supersession"],
        ["0003-bad-review.md", "review_after_invalid"],
        ["0004-bad-source.md", "source_type_invalid"],
        ["0005-empty-ref.md", "source_ref_invalid"],
      ]);
      expect(scanned.entries).toEqual([]);
      expect(scanned.omittedFiles).toBe(5);
    }).pipe(Effect.provide(StoreLive));
  });
});

/* ------------------------------------------------------------------ */
/* ENG-13 lifecycle metadata: store round-trip and write boundary      */
/* ------------------------------------------------------------------ */

const LIFECYCLE_INPUT = {
  status: "superseded",
  reviewAfter: "2026-06-01T00:00:00.000Z",
  expires: "2027-01-01T00:00:00.000Z",
  sourceType: "file",
  sourceRef: "docs/spec.md",
} as const;

describe("EngramStore / lifecycle metadata", () => {
  let orig = "";
  let tmp = "";
  const engramsDir = (): string => projectEngramsDir(tmp);
  const filesNow = (): string[] => fs.readdirSync(engramsDir()).sort();

  beforeEach(() => {
    orig = process.cwd();
    tmp = mkProject();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(orig);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.live("add with all six fields survives serialization, read-back, and get", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const pred = yield* store.add("project", input({ title: "Old guidance" }), NOSCAN);
      const m = yield* store.add(
        "project",
        input({ title: "New guidance", ...LIFECYCLE_INPUT, supersedes: pred.id }),
        NOSCAN,
      );

      const fileRaw = fs.readFileSync(m.path, "utf8");
      expect(fileRaw).toMatch(/^status: superseded$/m);
      expect(fileRaw).toContain(`supersedes: ${pred.id}`);
      expect(fileRaw).toMatch(/^reviewAfter: 2026-06-01T00:00:00\.000Z$/m);
      expect(fileRaw).toMatch(/^expires: 2027-01-01T00:00:00\.000Z$/m);
      expect(fileRaw).toMatch(/^sourceType: file$/m);
      expect(fileRaw).toMatch(/^sourceRef: docs\/spec\.md$/m);

      const got = yield* store.get("project", m.id);
      expect(got.status).toBe("superseded");
      expect(got.supersedes).toBe(pred.id);
      expect(got.reviewAfter).toBe("2026-06-01T00:00:00.000Z");
      expect(got.expires).toBe("2027-01-01T00:00:00.000Z");
      expect(got.sourceType).toBe("file");
      expect(got.sourceRef).toBe("docs/spec.md");
      // the predecessor carries no lifecycle fields of its own; ENG-17 R1
      // marks it superseded as part of establishing the link
      const old = yield* store.get("project", pred.id);
      expect(old.status).toBe("superseded");
      expect(old.supersedes).toBeUndefined();
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("update: a concrete lifecycle value replaces the old one", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const m = yield* store.add(
        "project",
        input({
          title: "Changing guidance",
          status: "active",
          reviewAfter: "2026-06-01T00:00:00.000Z",
          sourceType: "file",
          sourceRef: "docs/old.md",
        }),
        NOSCAN,
      );

      const patched = yield* store.update(
        "project",
        m.id,
        {
          status: "archived",
          reviewAfter: "2027-01-01T00:00:00.000Z",
          sourceRef: "docs/new.md",
        },
        NOSCAN,
      );
      expect(patched.status).toBe("archived");
      expect(patched.reviewAfter).toBe("2027-01-01T00:00:00.000Z");
      expect(patched.sourceRef).toBe("docs/new.md");
      const fileRaw = fs.readFileSync(patched.path, "utf8");
      expect(fileRaw).toMatch(/^status: archived$/m);
      expect(fileRaw).toMatch(/^reviewAfter: 2027-01-01T00:00:00\.000Z$/m);
      expect(fileRaw).not.toMatch(/^reviewAfter: 2026-/m);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("update: null clears a lifecycle field and omits the YAML key", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const m = yield* store.add(
        "project",
        input({
          title: "Clearing target",
          status: "superseded",
          expires: "2027-01-01T00:00:00.000Z",
        }),
        NOSCAN,
      );

      const patched = yield* store.update("project", m.id, { status: null }, NOSCAN);
      expect(patched.status).toBeUndefined();
      const fileRaw = fs.readFileSync(patched.path, "utf8");
      expect(fileRaw).not.toMatch(/^status:/m);
      // null never reaches serialization: no "key: null" anywhere
      expect(fileRaw).not.toContain("null");
      // the untouched sibling field survives
      expect(patched.expires).toBe("2027-01-01T00:00:00.000Z");
      expect(fileRaw).toMatch(/^expires: 2027-01-01T00:00:00\.000Z$/m);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("update: all six lifecycle fields clear in one update", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      // a real predecessor: R5 lineage validation rejects missing targets
      const pred = yield* store.add("project", input({ title: "Clear predecessor" }), NOSCAN);
      const m = yield* store.add(
        "project",
        input({
          title: "Full clear",
          status: "archived",
          supersedes: pred.id,
          reviewAfter: "2026-06-01T00:00:00.000Z",
          expires: "2027-01-01T00:00:00.000Z",
          sourceType: "url",
          sourceRef: "https://example.com/post",
        }),
        NOSCAN,
      );

      const patched = yield* store.update(
        "project",
        m.id,
        {
          status: null,
          supersedes: null,
          reviewAfter: null,
          expires: null,
          sourceType: null,
          sourceRef: null,
        },
        NOSCAN,
      );
      expect(patched.status).toBeUndefined();
      expect(patched.supersedes).toBeUndefined();
      expect(patched.reviewAfter).toBeUndefined();
      expect(patched.expires).toBeUndefined();
      expect(patched.sourceType).toBeUndefined();
      expect(patched.sourceRef).toBeUndefined();
      const fileRaw = fs.readFileSync(patched.path, "utf8");
      for (const key of [
        "status",
        "supersedes",
        "reviewAfter",
        "expires",
        "sourceType",
        "sourceRef",
      ]) {
        expect(fileRaw).not.toMatch(new RegExp(`^${key}:`, "m"));
      }
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("update: clearing lifecycle fields leaves author, pinned, body, and stamps alone", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const m = yield* store.add(
        "project",
        input({
          title: "Isolation target",
          author: "mo",
          pinned: true,
          status: "archived",
          sourceType: "file",
        }),
        NOSCAN,
      );
      yield* Effect.sleep("5 millis");

      const patched = yield* store.update(
        "project",
        m.id,
        {
          status: null,
          sourceType: null,
        },
        NOSCAN,
      );
      expect(patched.author).toBe("mo");
      expect(patched.pinned).toBe(true);
      expect(patched.body).toBe(m.body);
      expect(patched.created).toBe(m.created);
      expect(patched.updated > m.updated).toBe(true);
      expect(patched.path).toBe(m.path);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("an unrelated update preserves all six lifecycle fields", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const pred = yield* store.add("project", input({ title: "Old guidance" }), NOSCAN);
      const m = yield* store.add(
        "project",
        input({ title: "New guidance", ...LIFECYCLE_INPUT, supersedes: pred.id }),
        NOSCAN,
      );

      const patched = yield* store.update(
        "project",
        m.id,
        {
          body: "an unrelated body edit",
          tags: ["unrelated"],
        },
        NOSCAN,
      );
      expect(patched.status).toBe("superseded");
      expect(patched.supersedes).toBe(pred.id);
      expect(patched.reviewAfter).toBe("2026-06-01T00:00:00.000Z");
      expect(patched.expires).toBe("2027-01-01T00:00:00.000Z");
      expect(patched.sourceType).toBe("file");
      expect(patched.sourceRef).toBe("docs/spec.md");

      const fileRaw = fs.readFileSync(patched.path, "utf8");
      expect(fileRaw).toMatch(/^status: superseded$/m);
      expect(fileRaw).toContain(`supersedes: ${pred.id}`);
      expect(fileRaw).toMatch(/^reviewAfter: 2026-06-01T00:00:00\.000Z$/m);
      expect(fileRaw).toMatch(/^expires: 2027-01-01T00:00:00\.000Z$/m);
      expect(fileRaw).toMatch(/^sourceType: file$/m);
      expect(fileRaw).toMatch(/^sourceRef: docs\/spec\.md$/m);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("updating an old v0.4 file inserts no lifecycle defaults", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const seeded = path.join(engramsDir(), "0001-legacy-note.md");
      fs.writeFileSync(
        seeded,
        stringifyFrontmatter("Old body\n", {
          id: "0001",
          title: "Legacy note",
          type: "note",
          tags: [],
          scope: "project",
          created: "2025-08-15T10:00:00.000Z",
          updated: "2025-08-15T11:00:00.000Z",
        }),
      );

      const patched = yield* store.update(
        "project",
        "0001",
        { title: "Legacy note renamed" },
        NOSCAN,
      );
      const fileRaw = fs.readFileSync(patched.path, "utf8");
      for (const key of [
        "status",
        "supersedes",
        "reviewAfter",
        "expires",
        "sourceType",
        "sourceRef",
      ]) {
        expect(fileRaw).not.toMatch(new RegExp(`^${key}:`, "m"));
      }
      expect(patched.status).toBeUndefined();
      expect(patched.supersedes).toBeUndefined();
      expect(patched.reviewAfter).toBeUndefined();
      expect(patched.expires).toBeUndefined();
      expect(patched.sourceType).toBeUndefined();
      expect(patched.sourceRef).toBeUndefined();
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("add rejects an invalid status before creating any file", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const before = filesNow();
      const err = yield* Effect.flip(
        store.add("project", input({ status: "draft" } as unknown as Partial<EngramInput>), NOSCAN),
      );
      expect((err as { _tag: string })._tag).toBe("FrontmatterParseError");
      expect((err as { message: string }).message).toContain("status");
      expect(filesNow()).toEqual(before);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("add rejects a date-only reviewAfter before creating any file", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const before = filesNow();
      const err = yield* Effect.flip(
        store.add(
          "project",
          input({ reviewAfter: "2026-01-01" } as unknown as Partial<EngramInput>),
          NOSCAN,
        ),
      );
      expect((err as { _tag: string })._tag).toBe("FrontmatterParseError");
      expect((err as { message: string }).message).toContain("reviewAfter");
      expect(filesNow()).toEqual(before);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("update rejects supersedes pointing at the entry itself without mutation", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const m = yield* store.add("project", input({ title: "Self ref target" }), NOSCAN);
      const before = fs.readFileSync(m.path, "utf8");

      const err = yield* Effect.flip(
        store.update("project", m.id, { supersedes: m.id } as EngramPatch, NOSCAN),
      );
      expect((err as { _tag: string })._tag).toBe("FrontmatterParseError");
      expect((err as { message: string }).message).toContain("supersedes");
      expect(fs.readFileSync(m.path, "utf8")).toBe(before);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("update rejects an invalid expires without mutation", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const m = yield* store.add("project", input({ title: "Expiry target" }), NOSCAN);
      const before = fs.readFileSync(m.path, "utf8");

      const err = yield* Effect.flip(
        store.update("project", m.id, { expires: "2026-01-01" } as EngramPatch, NOSCAN),
      );
      expect((err as { _tag: string })._tag).toBe("FrontmatterParseError");
      expect(fs.readFileSync(m.path, "utf8")).toBe(before);
    }).pipe(Effect.provide(StoreLive)),
  );
});

/* ------------------------------------------------------------------ */
/* ENG-13 lifecycle metadata: the pure time helper                     */
/* ------------------------------------------------------------------ */

describe("lifecycleDiagnostics", () => {
  const entry = (over: Partial<Engram> = {}): Engram => ({
    id: "0001",
    title: "Lifecycled",
    type: "note",
    tags: [],
    scope: "project",
    created: "2025-08-15T10:00:00.000Z",
    updated: "2025-08-15T11:00:00.000Z",
    author: undefined,
    pinned: false,
    body: "",
    path: "/store/0001-lifecycled.md",
    ...over,
  });
  const context = (nowMs: number, knownIds: string[] = []) => ({
    scope: "project" as const,
    file: "/store/0001-lifecycled.md",
    nowMs,
    knownIds: new Set(knownIds),
  });
  const codesOf = (nowMs: number, over: Partial<Engram>, knownIds: string[] = []) =>
    lifecycleDiagnostics(entry(over), context(nowMs, knownIds)).map((d) => d.code);

  it("treats a reviewAfter at the check time as due (equality boundary)", () => {
    const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    expect(codesOf(nowMs, { reviewAfter: "2026-01-01T00:00:00.000Z" })).toEqual(["review_due"]);
    expect(codesOf(nowMs, { reviewAfter: "2025-12-31T23:59:59.999Z" })).toEqual(["review_due"]);
    expect(codesOf(nowMs, { reviewAfter: "2026-01-01T00:00:00.001Z" })).toEqual([]);
  });

  it("treats an expires at the check time as expired (equality boundary)", () => {
    const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    expect(codesOf(nowMs, { expires: "2026-01-01T00:00:00.000Z" })).toEqual(["expired"]);
    expect(codesOf(nowMs, { expires: "2025-12-31T23:59:59.999Z" })).toEqual(["expired"]);
    expect(codesOf(nowMs, { expires: "2026-01-01T00:00:00.001Z" })).toEqual([]);
  });

  it("reports offset-form timestamps at their instant, not their text", () => {
    // 2026-01-01T02:00:00+02:00 == 2026-01-01T00:00:00.000Z
    const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    expect(codesOf(nowMs, { reviewAfter: "2026-01-01T02:00:00+02:00" })).toEqual(["review_due"]);
  });

  it("warns when supersedes has no claimant in the known id set", () => {
    const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    expect(codesOf(nowMs, { supersedes: "0002" }, ["0002", "0003"])).toEqual([]);
    expect(codesOf(nowMs, { supersedes: "0002" }, ["0003"])).toEqual(["supersedes_not_found"]);
  });

  it("emits multiple findings for one entry in a fixed order", () => {
    const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    expect(
      codesOf(nowMs, {
        reviewAfter: "2025-06-01T00:00:00.000Z",
        expires: "2025-01-01T00:00:00.000Z",
        supersedes: "0099",
      }),
    ).toEqual(["supersedes_not_found", "review_due", "expired"]);
  });

  it("every lifecycle diagnostic is a warning", () => {
    const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const out = lifecycleDiagnostics(
      entry({
        reviewAfter: "2025-06-01T00:00:00.000Z",
        expires: "2025-01-01T00:00:00.000Z",
        supersedes: "0099",
      }),
      context(nowMs),
    );
    expect(out.map((d) => d.severity)).toEqual(["warning", "warning", "warning"]);
  });
});

/* ------------------------------------------------------------------ */
/* ENG-13 lifecycle metadata: supersedes scope resolution              */
/* ------------------------------------------------------------------ */

describe("EngramStore / supersedes scope resolution", () => {
  let origCwd = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";

  beforeEach(() => {
    origCwd = process.cwd();
    origHome = process.env.HOME;
    tmp = mkProject();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "amem-sups-home-"));
    process.chdir(tmp);
    process.env.HOME = home;
    fs.mkdirSync(globalEngramsDir(), { recursive: true });
  });
  afterEach(() => {
    process.chdir(origCwd);
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it.live(
    "a personal claimant does not satisfy a project supersedes (hard reject, ENG-17 R5)",
    () => {
      fs.writeFileSync(
        path.join(globalEngramsDir(), "0001-personal-note.md"),
        stringifyFrontmatter("Personal body\n", {
          id: "0001",
          title: "Personal note",
          type: "note",
          tags: [],
          scope: "personal",
          created: "2025-08-15T10:00:00.000Z",
          updated: "2025-08-15T11:00:00.000Z",
        }),
      );
      return Effect.gen(function* () {
        const store = yield* EngramStore;
        const e = yield* Effect.flip(
          store.add("project", input({ title: "Project referrer", supersedes: "0001" }), NOSCAN),
        );
        expect((e as { _tag: string })._tag).toBe("FrontmatterParseError");
        expect((e as { message: string }).message).toContain("personal");
        // the rejection wrote nothing into the project store
        const projectScan = yield* store.scan("project");
        expect(projectScan.entries).toEqual([]);
        expect(projectScan.diagnostics).toEqual([]);
        const personalScan = yield* store.scan("personal");
        expect(personalScan.diagnostics).toEqual([]);
      }).pipe(Effect.provide(StoreLive));
    },
  );
});

/** A store layer whose `readFileString` fails for selected paths; simulates
 * an unreadable .md candidate (e.g. EACCES) without relying on chmod. */
const unreadableFileStoreLive = (isBroken: (file: string) => boolean) =>
  EngramStoreLive.pipe(
    Layer.provide(
      Layer.effect(
        FileSystem,
        Effect.gen(function* () {
          const real = yield* FileSystem;
          return {
            ...real,
            readFileString: (p: string) =>
              isBroken(p)
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
      ).pipe(Layer.provide(NodeServices.layer)),
    ),
    Layer.provide(NodeServices.layer),
  );

/** A store layer whose `readDirectory` always fails; the store directory
 * itself cannot be listed, so validity cannot be established. */
const unreadableDirStoreLive = () =>
  EngramStoreLive.pipe(
    Layer.provide(
      Layer.effect(
        FileSystem,
        Effect.gen(function* () {
          const real = yield* FileSystem;
          return {
            ...real,
            readDirectory: (p: string) =>
              Effect.fail(
                systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readDirectory",
                  pathOrDescriptor: p,
                  syscall: "open",
                }),
              ),
          } satisfies FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer)),
    ),
    Layer.provide(NodeServices.layer),
  );

describe("EngramStore / unreadable candidates", () => {
  let orig = "";
  let tmp = "";
  const engramsDir = (): string => projectEngramsDir(tmp);
  beforeEach(() => {
    orig = process.cwd();
    tmp = mkProject();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(orig);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.live("a read failure becomes file_unreadable without hiding siblings", () => {
    const good = path.join(engramsDir(), "0001-good-note.md");
    fs.writeFileSync(
      good,
      stringifyFrontmatter("Body\n", {
        id: "0001",
        title: "Good note",
        type: "note",
        tags: [],
        scope: "project",
        created: "2025-08-15T10:00:00.000Z",
        updated: "2025-08-15T11:00:00.000Z",
      }),
    );
    const bad = path.join(engramsDir(), "0002-bad-note.md");
    fs.writeFileSync(
      bad,
      stringifyFrontmatter("Body\n", {
        id: "0002",
        title: "Bad note",
        type: "note",
        tags: [],
        scope: "project",
        created: "2025-08-15T10:00:00.000Z",
        updated: "2025-08-15T11:00:00.000Z",
      }),
    );
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const scanned = yield* store.scan("project");
      expect(scanned.entries.map((m) => m.path)).toEqual([good]);
      expect(scanned.omittedFiles).toBe(1);
      expect(scanned.diagnostics).toHaveLength(1);
      expect(scanned.diagnostics[0].code).toBe("file_unreadable");
      expect(scanned.diagnostics[0].file).toBe(bad);
      expect(scanned.diagnostics[0].message).toContain("PermissionDenied");
    }).pipe(Effect.provide(unreadableFileStoreLive((p) => p === bad)));
  });

  it.live("a directory read failure fails the scan", () => {
    const dir = engramsDir();
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      return yield* store.scan("project");
    }).pipe(
      Effect.provide(unreadableDirStoreLive()),
      Effect.flip,
      Effect.map((e) => {
        expect((e as { _tag: string })._tag).toBe("PlatformError");
        expect((e as unknown as { message: string }).message).toContain(dir);
      }),
    );
  });
});

describe("EngramStore / personal scan", () => {
  let origHome: string | undefined;
  let tmp = "";
  beforeEach(() => {
    origHome = process.env.HOME;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amem-home-scan-"));
    process.env.HOME = tmp;
    fs.mkdirSync(globalEngramsDir(), { recursive: true });
  });
  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.live("a missing directory returns a clean empty scan", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      fs.rmSync(globalEngramsDir(), { recursive: true, force: true });
      const scanned = yield* store.scan("personal");
      expect(scanned.directory).toBe(globalEngramsDir());
      expect(scanned.filesChecked).toBe(0);
      expect(scanned.entries).toEqual([]);
      expect(scanned.diagnostics).toEqual([]);
      expect(scanned.omittedFiles).toBe(0);
    }).pipe(Effect.provide(StoreLive)),
  );
  it.live("a generated v0.4 personal store passes unchanged", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      yield* store.add("personal", input({ title: "Personal decision" }), NOSCAN);
      yield* store.add("personal", input({ title: "Another personal note" }), NOSCAN);
      const scanned = yield* store.scan("personal");
      expect(scanned.scope).toBe("personal");
      expect(scanned.directory).toBe(globalEngramsDir());
      expect(scanned.filesChecked).toBe(2);
      expect(scanned.diagnostics).toEqual([]);
      expect(scanned.entries).toHaveLength(2);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("a scope mismatch is diagnosed in the personal direction", () => {
    fs.writeFileSync(
      path.join(globalEngramsDir(), "0001-stray-project-note.md"),
      scanFm({ id: "0001", title: "Stray project note", scope: "project" }),
    );
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const scanned = yield* store.scan("personal");
      expect(scanned.diagnostics.map((d) => d.code)).toEqual(["scope_mismatch"]);
      expect(scanned.entries).toHaveLength(1);
    }).pipe(Effect.provide(StoreLive));
  });
});

/* ------------------------------------------------------------------ */
/* ENG-17: supersession side effect, lineage validation, atomicity     */
/* ------------------------------------------------------------------ */

/** A store layer whose `writeFileString` fails for selected paths (ENG-17
 * R2 failure injection): simulates an IO failure at any single write step
 * without relying on permissions or full disks. */
const failWriteStoreLive = (isBroken: (file: string) => boolean) =>
  EngramStoreLive.pipe(
    Layer.provide(
      Layer.effect(
        FileSystem,
        Effect.gen(function* () {
          const real = yield* FileSystem;
          return {
            ...real,
            writeFileString: (...args: Parameters<typeof real.writeFileString>) => {
              const p = args[0];
              if (isBroken(p)) {
                return Effect.fail(
                  systemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "writeFileString",
                    pathOrDescriptor: p,
                    syscall: "write",
                    cause: new Error("simulated write failure"),
                  }),
                );
              }
              return real.writeFileString(...args);
            },
          } satisfies FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer)),
    ),
    Layer.provide(NodeServices.layer),
  );

/** A store layer whose `writeFileString` fails for a path on selected calls
 * (1-based count per path): lets a test fail the FIRST write to one file and
 * a LATER write to another, e.g. the predecessor marking succeeds, the entry
 * write fails, and the compensating restore fails too. */
const failWriteCallsStoreLive = (isBroken: (file: string, call: number) => boolean) => {
  const calls = new Map<string, number>();
  return EngramStoreLive.pipe(
    Layer.provide(
      Layer.effect(
        FileSystem,
        Effect.gen(function* () {
          const real = yield* FileSystem;
          return {
            ...real,
            writeFileString: (...args: Parameters<typeof real.writeFileString>) => {
              const p = args[0];
              const n = (calls.get(p) ?? 0) + 1;
              calls.set(p, n);
              if (isBroken(p, n)) {
                return Effect.fail(
                  systemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "writeFileString",
                    pathOrDescriptor: p,
                    syscall: "write",
                    cause: new Error("simulated write failure"),
                  }),
                );
              }
              return real.writeFileString(...args);
            },
          } satisfies FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer)),
    ),
    Layer.provide(NodeServices.layer),
  );
};

/** A store layer with selected failing fs ops (ENG-17 review fixes):
 * - `writeFileString`: fails before delegating (destination never created);
 * - `createThenFailWriteFile`: creates the destination file first, then
 *   fails — simulating a write that got as far as creating its target
 *   before reporting failure, so compensating removal has real work to do;
 * - `remove`: fails the removal of selected paths. */
const failIoStoreLive = (opts: {
  writeFileString?: (file: string) => boolean;
  createThenFailWriteFile?: (file: string) => boolean;
  remove?: (file: string) => boolean;
}) =>
  EngramStoreLive.pipe(
    Layer.provide(
      Layer.effect(
        FileSystem,
        Effect.gen(function* () {
          const real = yield* FileSystem;
          return {
            ...real,
            writeFileString: (...args: Parameters<typeof real.writeFileString>) => {
              const p = args[0];
              if (opts.createThenFailWriteFile?.(p)) {
                fs.writeFileSync(p, "<partial write>\n");
                return Effect.fail(
                  systemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "writeFileString",
                    pathOrDescriptor: p,
                    syscall: "write",
                    cause: new Error("simulated write failure after creating the destination"),
                  }),
                );
              }
              if (opts.writeFileString?.(p)) {
                return Effect.fail(
                  systemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "writeFileString",
                    pathOrDescriptor: p,
                    syscall: "write",
                    cause: new Error("simulated write failure"),
                  }),
                );
              }
              return real.writeFileString(...args);
            },
            remove: (...args: Parameters<typeof real.remove>) => {
              const p = args[0];
              if (opts.remove?.(p)) {
                return Effect.fail(
                  systemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "remove",
                    pathOrDescriptor: p,
                    syscall: "unlink",
                    cause: new Error("simulated removal failure"),
                  }),
                );
              }
              return real.remove(...args);
            },
          } satisfies FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer)),
    ),
    Layer.provide(NodeServices.layer),
  );

/** Byte snapshot of every file in a directory, for byte-identical rejection
 * and rollback assertions. */
const snapshot = (dir: string): string =>
  fs
    .readdirSync(dir)
    .sort()
    .map((f) => f + "\n" + fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n---\n");

const expectFrontmatterParseError = (e: unknown): void => {
  expect((e as { _tag: string })._tag).toBe("FrontmatterParseError");
};

describe("EngramStore / supersession side effect (ENG-17 R1)", () => {
  let orig = "";
  let tmp = "";
  beforeEach(() => {
    orig = process.cwd();
    tmp = mkProject();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(orig);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.live("add with supersedes marks the predecessor superseded in the same operation", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const a = yield* store.add("project", input({ title: "Old decision" }), NOSCAN);
      yield* Effect.sleep("10 millis");
      const b = yield* store.add(
        "project",
        input({ title: "New decision", supersedes: a.id }),
        NOSCAN,
      );

      expect(b.supersedes).toBe(a.id);
      expect(b.status).toBeUndefined();
      const aAfter = yield* store.get("project", a.id);
      expect(aAfter.status).toBe("superseded");
      expect(fs.existsSync(a.path)).toBe(true);
      expect(fs.existsSync(b.path)).toBe(true);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("the predecessor's updated bumps to the operation time (documented convention)", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const a = yield* store.add("project", input({ title: "Old decision" }), NOSCAN);
      yield* Effect.sleep("10 millis");
      yield* store.add("project", input({ title: "New decision", supersedes: a.id }), NOSCAN);
      const aAfter = yield* store.get("project", a.id);
      expect(aAfter.updated > a.updated).toBe(true);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("add without supersedes leaves every other entry untouched", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const a = yield* store.add("project", input({ title: "Old decision" }), NOSCAN);
      yield* store.add("project", input({ title: "Unrelated note" }), NOSCAN);
      const aAfter = yield* store.get("project", a.id);
      expect(aAfter.status).toBeUndefined();
      expect(aAfter.updated).toBe(a.updated);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("clearing supersedes does not reactivate the predecessor", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const a = yield* store.add("project", input({ title: "Old decision" }), NOSCAN);
      const b = yield* store.add(
        "project",
        input({ title: "New decision", supersedes: a.id }),
        NOSCAN,
      );
      yield* store.update("project", b.id, { supersedes: null }, NOSCAN);
      const bAfter = yield* store.get("project", b.id);
      const aAfter = yield* store.get("project", a.id);
      expect(bAfter.supersedes).toBeUndefined();
      expect(aAfter.status).toBe("superseded");
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("get by id stays status-blind after supersession", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const a = yield* store.add("project", input({ title: "Old decision" }), NOSCAN);
      yield* store.add("project", input({ title: "New decision", supersedes: a.id }), NOSCAN);
      const got = yield* store.get("project", a.id);
      expect(got.id).toBe(a.id);
      expect(got.body).toBe("libfoo had an engram leak under load");
    }).pipe(Effect.provide(StoreLive)),
  );
});

describe("EngramStore / supersedes update transitions (ENG-17 R1)", () => {
  let orig = "";
  let tmp = "";
  const engramsDir = (): string => projectEngramsDir(tmp);
  beforeEach(() => {
    orig = process.cwd();
    tmp = mkProject();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(orig);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.live("unset -> X establishes the link and marks the target", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const a = yield* store.add("project", input({ title: "Target" }), NOSCAN);
      const b = yield* store.add("project", input({ title: "Editor" }), NOSCAN);
      const bAfter = yield* store.update("project", b.id, { supersedes: a.id }, NOSCAN);
      expect(bAfter.supersedes).toBe(a.id);
      const aAfter = yield* store.get("project", a.id);
      expect(aAfter.status).toBe("superseded");
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("X -> X is an idempotent no-op (no self-rejection, other patches apply)", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const a = yield* store.add("project", input({ title: "Target" }), NOSCAN);
      const b = yield* store.add("project", input({ title: "Editor", supersedes: a.id }), NOSCAN);
      const bAfter = yield* store.update(
        "project",
        b.id,
        {
          supersedes: a.id,
          body: "patched body",
        },
        NOSCAN,
      );
      expect(bAfter.supersedes).toBe(a.id);
      expect(bAfter.body).toBe("patched body");
      const aAfter = yield* store.get("project", a.id);
      expect(aAfter.status).toBe("superseded");
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("unset -> null is a no-op", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const b = yield* store.add("project", input({ title: "Plain" }), NOSCAN);
      const bAfter = yield* store.update("project", b.id, { supersedes: null }, NOSCAN);
      expect(bAfter.supersedes).toBeUndefined();
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("X -> Y (repoint) is rejected with byte-identical files", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const a = yield* store.add("project", input({ title: "First target" }), NOSCAN);
      const b = yield* store.add("project", input({ title: "Editor", supersedes: a.id }), NOSCAN);
      const c = yield* store.add("project", input({ title: "Second target" }), NOSCAN);
      const before = snapshot(engramsDir());
      const e = yield* Effect.flip(store.update("project", b.id, { supersedes: c.id }, NOSCAN));
      expectFrontmatterParseError(e);
      expect((e as { message: string }).message).toContain("clear");
      expect(snapshot(engramsDir())).toBe(before);
      expect((yield* store.get("project", b.id)).supersedes).toBe(a.id);
      expect((yield* store.get("project", c.id)).status).toBeUndefined();
    }).pipe(Effect.provide(StoreLive)),
  );
});

describe("EngramStore / lineage validation (ENG-17 R5)", () => {
  let orig = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  const engramsDir = (): string => projectEngramsDir(tmp);
  beforeEach(() => {
    orig = process.cwd();
    origHome = process.env.HOME;
    tmp = mkProject();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "amem-eng17-home-"));
    process.chdir(tmp);
    process.env.HOME = home;
    fs.mkdirSync(globalEngramsDir(), { recursive: true });
  });
  afterEach(() => {
    process.chdir(orig);
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  const failMessage = (e: unknown): string => (e as { message: string }).message;

  it.live("add: missing target rejects before any file is written", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const before = snapshot(engramsDir());
      const e = yield* Effect.flip(
        store.add(
          "project",
          input({ title: "Orphan", supersedes: "zzzzzzzzzzzzzzzzzzzzzzzzzz" }),
          NOSCAN,
        ),
      );
      expectFrontmatterParseError(e);
      expect(failMessage(e)).toContain("zzzzzzzzzzzzzzzzzzzzzzzzzz");
      expect(snapshot(engramsDir())).toBe(before);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("update: missing target rejects with byte-identical files", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const b = yield* store.add("project", input({ title: "Editor" }), NOSCAN);
      const before = snapshot(engramsDir());
      const e = yield* Effect.flip(
        store.update("project", b.id, { supersedes: "zzzzzzzzzzzzzzzzzzzzzzzzzz" }, NOSCAN),
      );
      expectFrontmatterParseError(e);
      expect(snapshot(engramsDir())).toBe(before);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("update: self-reference rejects", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const b = yield* store.add("project", input({ title: "Self ref" }), NOSCAN);
      const before = snapshot(engramsDir());
      const e = yield* Effect.flip(store.update("project", b.id, { supersedes: b.id }, NOSCAN));
      expectFrontmatterParseError(e);
      expect(failMessage(e)).toContain("itself");
      expect(snapshot(engramsDir())).toBe(before);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("add: an already-superseded target rejects", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const a = yield* store.add("project", input({ title: "Target" }), NOSCAN);
      yield* store.add("project", input({ title: "First successor", supersedes: a.id }), NOSCAN);
      const before = snapshot(engramsDir());
      const e = yield* Effect.flip(
        store.add("project", input({ title: "Second successor", supersedes: a.id }), NOSCAN),
      );
      expectFrontmatterParseError(e);
      expect(failMessage(e)).toContain("already superseded");
      expect(snapshot(engramsDir())).toBe(before);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("add: an archived target rejects", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const a = yield* store.add("project", input({ title: "Target" }), NOSCAN);
      yield* store.update("project", a.id, { status: "archived" }, NOSCAN);
      const before = snapshot(engramsDir());
      const e = yield* Effect.flip(
        store.add("project", input({ title: "Successor", supersedes: a.id }), NOSCAN),
      );
      expectFrontmatterParseError(e);
      expect(failMessage(e)).toContain("archived");
      expect(snapshot(engramsDir())).toBe(before);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("add: a duplicate-claimed target rejects", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      fs.writeFileSync(
        path.join(engramsDir(), "0001-first.md"),
        scanFm({ id: "0001", title: "First claim" }),
      );
      fs.writeFileSync(
        path.join(engramsDir(), "0001-second.md"),
        scanFm({ id: "0001", title: "Second claim" }),
      );
      const before = snapshot(engramsDir());
      const e = yield* Effect.flip(
        store.add("project", input({ title: "Successor", supersedes: "0001" }), NOSCAN),
      );
      expectFrontmatterParseError(e);
      expect(failMessage(e)).toContain("multiple files");
      expect(snapshot(engramsDir())).toBe(before);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("add: an unreadable/invalid target rejects with the target's diagnosis", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      fs.writeFileSync(
        path.join(engramsDir(), "0001-broken.md"),
        "---\ntitle: [unclosed\n---\nBody\n",
      );
      const before = snapshot(engramsDir());
      const e = yield* Effect.flip(
        store.add("project", input({ title: "Successor", supersedes: "0001" }), NOSCAN),
      );
      expectFrontmatterParseError(e);
      expect(failMessage(e)).toContain("not a valid readable entry");
      expect(snapshot(engramsDir())).toBe(before);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("add: a cross-scope target rejects", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      fs.writeFileSync(
        path.join(globalEngramsDir(), "0001-personal-note.md"),
        scanFm({ id: "0001", title: "Personal note", scope: "personal" }),
      );
      const before = snapshot(engramsDir());
      const e = yield* Effect.flip(
        store.add("project", input({ title: "Successor", supersedes: "0001" }), NOSCAN),
      );
      expectFrontmatterParseError(e);
      expect(failMessage(e)).toContain("personal");
      expect(snapshot(engramsDir())).toBe(before);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("add: a prefix id is not an exact target and rejects", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const a = yield* store.add("project", input({ title: "Target" }), NOSCAN);
      const before = snapshot(engramsDir());
      const e = yield* Effect.flip(
        store.add("project", input({ title: "Successor", supersedes: a.id.slice(0, 8) }), NOSCAN),
      );
      expectFrontmatterParseError(e);
      expect(snapshot(engramsDir())).toBe(before);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("update: closing a transitive cycle rejects with byte-identical files", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const a = yield* store.add("project", input({ title: "A" }), NOSCAN);
      const b = yield* store.add("project", input({ title: "B" }), NOSCAN);
      const c = yield* store.add("project", input({ title: "C" }), NOSCAN);
      yield* store.update("project", c.id, { supersedes: b.id }, NOSCAN); // C -> B (B superseded)
      yield* store.update("project", a.id, { supersedes: c.id }, NOSCAN); // A -> C (C superseded)
      // Editing B (superseded entries stay editable) to supersede A would
      // close the cycle B -> A -> C -> B.
      const before = snapshot(engramsDir());
      const e = yield* Effect.flip(store.update("project", b.id, { supersedes: a.id }, NOSCAN));
      expectFrontmatterParseError(e);
      expect(failMessage(e)).toContain("cycle");
      expect(snapshot(engramsDir())).toBe(before);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("update: a pre-existing hand-edited cycle rejects naming its closer, not the entry", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      // Hand-edited pre-existing cycle: 0001 -> 0002 -> 0001, both active.
      // The entry being edited is not part of the loop at all.
      fs.writeFileSync(
        path.join(engramsDir(), "0001-first.md"),
        scanFm({ id: "0001", title: "First", supersedes: "0002" }),
      );
      fs.writeFileSync(
        path.join(engramsDir(), "0002-second.md"),
        scanFm({ id: "0002", title: "Second", supersedes: "0001" }),
      );
      const e = yield* store.add("project", input({ title: "Editor" }), NOSCAN);
      const before = snapshot(engramsDir());
      const err = yield* Effect.flip(store.update("project", e.id, { supersedes: "0001" }, NOSCAN));
      expectFrontmatterParseError(err);
      // The true cycle is 0001 -> 0002 -> 0001, closed by 0002's link; the
      // edited entry must not be named as the loop-back target (ENG-63).
      expect(failMessage(err)).toContain("cycle");
      expect(failMessage(err)).toContain("0001 -> 0002 -> 0001");
      expect(failMessage(err)).toContain('closed by "0002"');
      expect(failMessage(err)).not.toContain(e.id);
      expect(snapshot(engramsDir())).toBe(before);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("add: a tail leading into a pre-existing cycle rejects naming the cycle's closer", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      // Rho shape: the walk from target 0001 runs 0001 -> 0002 -> 0003 ->
      // 0004 -> 0002. The cycle itself is 0002 -> 0003 -> 0004 -> 0002,
      // closed by 0004; the tail and the new probe id are in no cycle.
      const seed = (id: string, title: string, supersedes: string): void => {
        fs.writeFileSync(
          path.join(engramsDir(), `${id}-${slugify(title)}.md`),
          scanFm({ id, title, supersedes }),
        );
      };
      seed("0001", "Tail", "0002");
      seed("0002", "Loop b", "0003");
      seed("0003", "Loop c", "0004");
      seed("0004", "Loop d", "0002");
      const before = snapshot(engramsDir());
      const err = yield* Effect.flip(
        store.add("project", input({ title: "Successor", supersedes: "0001" }), NOSCAN),
      );
      expectFrontmatterParseError(err);
      // The rendered cycle starts at the repeated node, not at the target,
      // and names the node whose link closes it (ENG-63).
      expect(failMessage(err)).toContain("0002 -> 0003 -> 0004 -> 0002");
      expect(failMessage(err)).toContain('closed by "0004"');
      expect(failMessage(err)).not.toContain("0001 -> 0002");
      expect(snapshot(engramsDir())).toBe(before);
    }).pipe(Effect.provide(StoreLive)),
  );
});

describe("EngramStore / supersession atomicity (ENG-17 R2)", () => {
  let orig = "";
  let tmp = "";
  const engramsDir = (): string => projectEngramsDir(tmp);
  const seedEntry = (id: string, title: string): string => {
    const file = path.join(engramsDir(), `${id}-${slugify(title)}.md`);
    fs.writeFileSync(file, scanFm({ id, title }));
    return file;
  };
  beforeEach(() => {
    orig = process.cwd();
    tmp = mkProject();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(orig);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.live("add: total entry-write failure writes nothing and leaves the target untouched", () => {
    seedEntry("0001", "Target");
    const before = snapshot(engramsDir());
    // flakyWxStoreLive(6): all 6 attempts of the exclusive entry write fail.
    // The layer must wrap the whole test body: an inner Effect.provide does
    // not override the outer service in Effect v4.
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const e = yield* Effect.flip(
        store.add("project", input({ title: "Successor", supersedes: "0001" }), NOSCAN),
      );
      expect((e as { _tag: string })._tag).toBe("PlatformError");
      expect(snapshot(engramsDir())).toBe(before);
    }).pipe(Effect.provide(flakyWxStoreLive(6).layer));
  });

  it.live("add: predecessor-mark failure rolls the new entry back (compensating remove)", () => {
    seedEntry("0001", "Target");
    const before = snapshot(engramsDir());
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const e = yield* Effect.flip(
        store.add("project", input({ title: "Successor", supersedes: "0001" }), NOSCAN),
      );
      expect((e as { _tag: string })._tag).toBe("PlatformError");
      // every involved file byte-identical: the new file is gone, the target unchanged
      expect(snapshot(engramsDir())).toBe(before);
    }).pipe(Effect.provide(failWriteStoreLive((p) => p.includes("0001-"))));
  });

  it.live("update establish: predecessor-mark failure leaves both files untouched", () => {
    seedEntry("0001", "Target");
    seedEntry("0002", "Editor");
    const before = snapshot(engramsDir());
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const e = yield* Effect.flip(store.update("project", "0002", { supersedes: "0001" }, NOSCAN));
      expect((e as { _tag: string })._tag).toBe("PlatformError");
      expect(snapshot(engramsDir())).toBe(before);
    }).pipe(Effect.provide(failWriteStoreLive((p) => p.includes("0001-"))));
  });

  it.live("update establish: entry-write failure after marking restores the target bytes", () => {
    seedEntry("0001", "Target");
    seedEntry("0002", "Editor");
    const before = snapshot(engramsDir());
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const e = yield* Effect.flip(
        store.update("project", "0002", { supersedes: "0001", body: "new body" }, NOSCAN),
      );
      expect((e as { _tag: string })._tag).toBe("PlatformError");
      // the compensation rewrites 0001's original bytes, so the whole
      // directory is byte-identical to the pre-operation state
      expect(snapshot(engramsDir())).toBe(before);
    }).pipe(
      // only the entry write itself fails; the later same-path restore of the
      // pre-operation bytes must go through (see rollbackStep in store.ts)
      Effect.provide(failWriteCallsStoreLive((p, n) => p.includes("0002-editor.md") && n === 1)),
    );
  });

  it.live(
    "update establish + retitle: failure removing the original file rolls the whole operation back",
    () => {
      seedEntry("0001", "Target");
      seedEntry("0002", "Editor");
      const before = snapshot(engramsDir());
      return Effect.gen(function* () {
        const store = yield* EngramStore;
        const e = yield* Effect.flip(
          store.update("project", "0002", { supersedes: "0001", title: "Renamed editor" }, NOSCAN),
        );
        expect((e as { _tag: string })._tag).toBe("PlatformError");
        // no half-applied state: predecessor unmarked, renamed successor
        // gone, original successor still on disk — byte-identical directory
        expect(snapshot(engramsDir())).toBe(before);
      }).pipe(Effect.provide(failIoStoreLive({ remove: (p) => p.includes("0002-editor.md") })));
    },
  );

  it.live(
    "update establish + retitle: a destination created before a failed write is cleaned up byte-identically",
    () => {
      seedEntry("0001", "Target");
      seedEntry("0002", "Editor");
      const before = snapshot(engramsDir());
      return Effect.gen(function* () {
        const store = yield* EngramStore;
        const e = yield* Effect.flip(
          store.update("project", "0002", { supersedes: "0001", title: "Renamed editor" }, NOSCAN),
        );
        expect((e as { _tag: string })._tag).toBe("PlatformError");
        // the write created the destination before reporting failure; the
        // compensating remove must clean it up anyway
        expect(snapshot(engramsDir())).toBe(before);
      }).pipe(
        Effect.provide(
          failIoStoreLive({ createThenFailWriteFile: (p) => p.includes("0002-renamed-editor.md") }),
        ),
      );
    },
  );

  it.live("add: failed cleanup after a failed mark reports an incomplete rollback", () => {
    seedEntry("0001", "Target");
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const e = yield* Effect.flip(
        store.add("project", input({ title: "Successor", supersedes: "0001" }), NOSCAN),
      );
      expect((e as { _tag: string })._tag).toBe("FrontmatterParseError");
      const message = (e as { message: string }).message;
      expect(message).toContain("incomplete rollback");
      expect(message).toContain("Primary failure:");
      expect(message).toContain("Rollback failure:");
      // exact resulting state: the predecessor is byte-identical, and the new
      // entry file could NOT be removed, so it is still on disk
      expect(fs.readFileSync(path.join(engramsDir(), "0001-target.md"), "utf8")).toBe(
        scanFm({ id: "0001", title: "Target" }),
      );
      const files = fs.readdirSync(engramsDir());
      expect(files).toHaveLength(2);
      const leftover = files.find((f) => f.endsWith("-successor.md"));
      expect(leftover).toBeDefined();
      const leftoverRaw = fs.readFileSync(path.join(engramsDir(), leftover!), "utf8");
      expect(leftoverRaw).toContain('supersedes: "0001"');
      expect(leftoverRaw).not.toContain("status:");
    }).pipe(
      Effect.provide(
        failIoStoreLive({
          writeFileString: (p) => p.includes("0001-target.md"),
          remove: (p) => p.endsWith("-successor.md"),
        }),
      ),
    );
  });

  it.live("update establish: failed predecessor restoration reports an incomplete rollback", () => {
    seedEntry("0001", "Target");
    seedEntry("0002", "Editor");
    return Effect.gen(function* () {
      const store = yield* EngramStore;
      const e = yield* Effect.flip(
        store.update("project", "0002", { supersedes: "0001", body: "new body" }, NOSCAN),
      );
      expect((e as { _tag: string })._tag).toBe("FrontmatterParseError");
      const message = (e as { message: string }).message;
      expect(message).toContain("incomplete rollback");
      expect(message).toContain("Primary failure:");
      expect(message).toContain("Rollback failure:");
      // exact resulting state: the predecessor stays marked (half-applied);
      // the editor file is byte-identical to before
      const aRaw = fs.readFileSync(path.join(engramsDir(), "0001-target.md"), "utf8");
      expect(aRaw).toContain("status: superseded");
      expect(fs.readFileSync(path.join(engramsDir(), "0002-editor.md"), "utf8")).toBe(
        scanFm({ id: "0002", title: "Editor" }),
      );
    }).pipe(
      Effect.provide(
        failWriteCallsStoreLive(
          (p, n) => p.includes("0002-editor.md") || (p.includes("0001-target.md") && n >= 2),
        ),
      ),
    );
  });
});

describe("EngramStore / secret-scan gate (ENG-15)", () => {
  let orig = "";
  let tmp = "";
  beforeEach(() => {
    orig = process.cwd();
    tmp = mkProject();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(orig);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const SECRET = "S3cr3t-V4lue!";
  const secretInput = (over: Partial<EngramInput> = {}): EngramInput =>
    input({ body: `rotated the db password: "${SECRET}" after the incident`, ...over });
  const BLOCK: ScanOptions = { policy: "block", allowSecrets: false };
  const OVERRIDE: ScanOptions = { policy: "block", allowSecrets: true };
  const WARN: ScanOptions = { policy: "warn", allowSecrets: false };
  const OFF: ScanOptions = { policy: "off", allowSecrets: false };

  /** Like mkProject but without the engrams directory, so a blocked write
   * can prove it creates nothing at all (N1). */
  const mkBare = (): string => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), "amem-bare-"));
    fs.mkdirSync(path.join(t, ".engram"), { recursive: true });
    fs.writeFileSync(
      projectConfigPath(t),
      JSON.stringify({ version: 1, tracked: true, defaultType: "note" }),
    );
    return t;
  };

  /** Every file under `.engram/` as path -> exact bytes. Blocked writes
   * must leave this map unchanged (file existence AND bytes, R3: not the
   * directory tree). */
  const snapshot = (): string => {
    const root = path.join(tmp, ".engram");
    if (!fs.existsSync(root)) return "[]";
    const rel = fs.readdirSync(root, { recursive: true }).map(String).sort();
    const entries: string[] = [];
    for (const f of rel) {
      const full = path.join(root, f);
      if (fs.statSync(full).isFile()) {
        entries.push(`${f}:${fs.readFileSync(full).toString("base64")}`);
      }
    }
    return JSON.stringify(entries);
  };

  it.live("blocked add fails before any filesystem side effect", () =>
    Effect.gen(function* () {
      // a store whose engrams directory has never been created
      tmp = mkBare();
      process.chdir(tmp);
      const store = yield* EngramStore;
      const before = snapshot();
      const failure = yield* Effect.flip(store.add("project", secretInput(), BLOCK));
      expect((failure as { _tag: string })._tag).toBe("SecretScanBlockedError");
      // byte-identical storage AND, because the gate precedes directory
      // creation, no `.engram/engrams` directory was created either (N1)
      expect(snapshot()).toBe(before);
      expect(fs.existsSync(projectEngramsDir(tmp))).toBe(false);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("blocked personal add fails under block policy", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const failure = yield* Effect.flip(store.add("personal", secretInput(), BLOCK));
      expect((failure as { _tag: string })._tag).toBe("SecretScanBlockedError");
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("warn writes and surfaces redacted findings", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const written = yield* store.add("project", secretInput(), WARN);
      expect(written.scan.policy).toBe("warn");
      expect(written.scan.blocked).toBe(false);
      expect(written.scan.overrideUsed).toBe(false);
      expect(written.scan.findings).toHaveLength(1);
      expect(written.scan.findings[0].rule).toBe("SEC-CRED-ASSIGNMENT");
      expect(written.scan.findings[0].line).toBeGreaterThan(0);
      // zero-leak: the stored scan result never contains the matched text
      expect(JSON.stringify(written.scan)).not.toContain(SECRET);
      const [m] = yield* store.list("project");
      expect(m.id).toBe(written.id);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("block with allowSecrets writes and reports the override", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const written = yield* store.add("project", secretInput(), OVERRIDE);
      expect(written.scan.blocked).toBe(false);
      expect(written.scan.overrideUsed).toBe(true);
      expect(written.scan.findings).toHaveLength(1);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("off surfaces no findings", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const written = yield* store.add("project", secretInput(), OFF);
      expect(written.scan.policy).toBe("off");
      expect(written.scan.findings).toHaveLength(0);
      expect(written.scan.overrideUsed).toBe(false);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("blocked update leaves storage byte-identical", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const added = yield* store.add("project", input(), OFF);
      const before = snapshot();
      const failure = yield* Effect.flip(
        store.update("project", added.id, { body: secretInput().body }, BLOCK),
      );
      expect((failure as { _tag: string })._tag).toBe("SecretScanBlockedError");
      expect(snapshot()).toBe(before);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("title-only edits scan the complete resulting entry (legacy content)", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      // legacy entry stored with scanning off: its body holds a secret
      const legacy = yield* store.add("project", secretInput(), OFF);
      const failure = yield* Effect.flip(
        store.update("project", legacy.id, { title: "Renamed entry" }, BLOCK),
      );
      expect((failure as { _tag: string })._tag).toBe("SecretScanBlockedError");
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("edits that remove the secret succeed", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const legacy = yield* store.add("project", secretInput(), OFF);
      const fixed = yield* store.update(
        "project",
        legacy.id,
        { body: "rotated the credential in the secret manager" },
        BLOCK,
      );
      expect(fixed.scan.blocked).toBe(false);
      expect(fixed.scan.findings).toHaveLength(0);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("establishing supersedes scans the new entry but still marks the predecessor", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const pred = yield* store.add("project", input({ title: "Old way" }), BLOCK);
      const written = yield* store.add(
        "project",
        secretInput({ title: "New way", supersedes: pred.id }),
        WARN,
      );
      expect(written.scan.findings).toHaveLength(1);
      const marked = yield* store.get("project", pred.id);
      expect(marked.status).toBe("superseded");
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("a blocked supersedes add marks nothing", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const pred = yield* store.add("project", input({ title: "Old way" }), BLOCK);
      const before = snapshot();
      yield* Effect.flip(
        store.add("project", secretInput({ title: "New way", supersedes: pred.id }), BLOCK),
      );
      expect(snapshot()).toBe(before);
      const unmarked = yield* store.get("project", pred.id);
      // active is the implicit default: no status key was ever written
      expect(unmarked.status).toBeUndefined();
    }).pipe(Effect.provide(StoreLive)),
  );
});
