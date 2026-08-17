import { describe, it, expect, beforeEach, afterEach } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { systemError } from "effect/PlatformError";
import { NodeServices } from "@effect/platform-node";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngramStore, EngramStoreLive } from "../src/store.js";
import { projectConfigPath, projectEngramsDir } from "../src/paths.js";
import type { EngramInput } from "../src/domain.js";

const StoreLive = EngramStoreLive.pipe(Layer.provide(NodeServices.layer));

/** A store whose first `n` exclusive (`wx`) writes fail with EEXIST —
 * simulates another process winning the exact-filename race. */
const flakyWxStoreLive = (failures: number) => {
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
          return o?.flag === "wx" && left-- > 0
            ? Effect.fail(
                systemError({
                  _tag: "AlreadyExists",
                  module: "FileSystem",
                  method: "writeFile",
                  pathOrDescriptor: p,
                  syscall: "open",
                  cause: new Error("simulated EEXIST"),
                }),
              )
            : real.writeFileString(p, d, o);
        },
      };
      return wrapped;
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  return EngramStoreLive.pipe(Layer.provide(FlakyFs), Layer.provide(NodeServices.layer));
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
      const m = yield* store.add("project", input());
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
      const a = yield* store.add("project", input({ title: "A" }));
      const b = yield* store.add("project", input({ title: "B" }));
      const c = yield* store.add("project", input({ title: "C" }));
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
      yield* store.add("project", input());
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
      const m = yield* store.add("project", input());
      yield* Effect.sleep("5 millis");

      const patched = yield* store.update("project", m.id, {
        body: "new body text",
        tags: ["new-tag"],
      });

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
      const m = yield* store.add("project", input({ title: "Old title" }));
      expect(fs.existsSync(m.path)).toBe(true);

      const patched = yield* store.update("project", m.id, {
        title: "A brand new title",
      });

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
      const m = yield* store.add("project", input());

      yield* store.update("project", m.id, { pinned: true });
      const [pinned] = yield* store.list("project");
      expect(pinned.pinned).toBe(true);

      yield* store.update("project", m.id, { pinned: false });
      const [unpinned] = yield* store.list("project");
      expect(unpinned.pinned).toBe(false);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("update: resolves id prefixes like get", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const m = yield* store.add("project", input());
      const patched = yield* store.update("project", m.id.slice(0, 6), { title: "Via prefix" });
      expect(patched.title).toBe("Via prefix");
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("update: unknown id fails with EngramNotFoundError", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      return yield* store.update("project", "9999", { title: "nope" });
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
      const m = yield* store.add("project", input({ body: "Intro\n\n---\n\nSection two" }));
      const got = yield* store.get("project", m.id);
      expect(got.body).toBe("Intro\n\n---\n\nSection two");
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("skips files with invalid YAML on list; get reports not-found", () =>
    Effect.gen(function* () {
      const file = path.join(engramsDir(), "0001-broken.md");
      fs.writeFileSync(file, "---\ntitle: [unclosed\n---\nBody\n");
      const store = yield* EngramStore;

      // malformed files are skipped on list…
      expect(yield* store.list("project")).toEqual([]);

      // …and therefore surface as not-found on direct get (no crash, no defect)
      return yield* store.get("project", "0001");
    }).pipe(
      Effect.provide(StoreLive),
      Effect.flip,
      Effect.map((e) => expect((e as { _tag: string })._tag).toBe("EngramNotFoundError")),
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
      const m = yield* store.add("project", input());
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
      const patched = yield* store.update("project", "0001", { title: "Renamed" });
      expect(patched.id).toBe("0001");
      expect(patched.path).toContain("0001-renamed.md");
    }).pipe(Effect.provide(StoreLive));
  });

  it.live("concurrent adds allocate unique ids", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const added = yield* Effect.forEach(
        Array.from({ length: 6 }, (_, i) => input({ title: `Concurrent ${i}` })),
        (inp) => store.add("project", inp),
        { concurrency: "unbounded" },
      );
      const ids = added.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
      const all = yield* store.list("project");
      expect(all).toHaveLength(6);
      expect(new Set(all.map((m) => m.id)).size).toBe(6);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("add retries past an EEXIST race on the exact filename", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      // both exclusive writes race-losses — add must retry with fresh ids
      const m = yield* store.add("project", input());
      expect(m.id).toMatch(ULID);
      expect(fs.existsSync(m.path)).toBe(true);
    }).pipe(Effect.provide(flakyWxStoreLive(2))),
  );

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
      yield* store.add("project", input());
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
      const m = yield* store.add("personal", input());
      expect(m.id).toMatch(ULID);
      expect(m.path).toContain(".engram");
      const all = yield* store.list("personal");
      expect(all).toHaveLength(1);
    }).pipe(Effect.provide(StoreLive)),
  );
});
