import { describe, it, expect, beforeEach, afterEach } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngramStore, EngramStoreLive } from "../src/store.js";
import { projectConfigPath, projectEngramsDir } from "../src/paths.js";
import type { EngramInput } from "../src/domain.js";

const StoreLive = EngramStoreLive.pipe(Layer.provide(NodeServices.layer));

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
      expect(m.id).toBe("0001");
      expect(m.path).toContain("0001-replaced-libfoo-with-libbar.md");

      const all = yield* store.list("project");
      expect(all).toHaveLength(1);
      expect(all[0].title).toBe("Replaced libfoo with libbar");

      const got = yield* store.get("project", "0001");
      expect(got.id).toBe("0001");

      const prefix = yield* store.get("project", "0");
      expect(prefix.id).toBe("0001");

      yield* store.remove("project", "0001");
      expect(yield* store.list("project")).toHaveLength(0);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("sequences ids across adds", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      const a = yield* store.add("project", input({ title: "A" }));
      const b = yield* store.add("project", input({ title: "B" }));
      const c = yield* store.add("project", input({ title: "C" }));
      expect([a.id, b.id, c.id]).toEqual(["0001", "0002", "0003"]);
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

      expect(patched.path).toContain("0001-a-brand-new-title.md");
      expect(fs.existsSync(patched.path)).toBe(true);
      expect(fs.existsSync(m.path)).toBe(false);

      const got = yield* store.get("project", "0001");
      expect(got.title).toBe("A brand new title");
      expect(got.body).toBe("libfoo had an engram leak under load");
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("update: toggles pinned and persists it", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      yield* store.add("project", input());

      yield* store.update("project", "0001", { pinned: true });
      const [pinned] = yield* store.list("project");
      expect(pinned.pinned).toBe(true);

      yield* store.update("project", "0001", { pinned: false });
      const [unpinned] = yield* store.list("project");
      expect(unpinned.pinned).toBe(false);
    }).pipe(Effect.provide(StoreLive)),
  );

  it.live("update: resolves id prefixes like get", () =>
    Effect.gen(function* () {
      const store = yield* EngramStore;
      yield* store.add("project", input());
      const patched = yield* store.update("project", "0", { title: "Via prefix" });
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
      expect(m.id).toBe("0001");
      expect(m.path).toContain(".engram");
      const all = yield* store.list("personal");
      expect(all).toHaveLength(1);
    }).pipe(Effect.provide(StoreLive)),
  );
});
