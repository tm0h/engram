import { describe, it, expect, beforeEach, afterEach } from "@effect/vitest";
import { Effect } from "effect";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MainLive, projectConfigPath, projectEngramsDir, projectReadmePath } from "@engram/core";
import { EngramStore, ConfigRepo } from "@engram/core";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import type { EngramInput } from "@engram/core";
import { contextDigest, searchOp, showOp, addOp, initOp } from "../src/shared/ops.js";

/* ------------------------------ helpers ------------------------------ */

const input = (over: Partial<EngramInput> = {}): EngramInput => ({
  title: "Some title",
  type: "note",
  tags: [],
  body: "Some body",
  pinned: false,
  author: "Tester",
  ...over,
});

const mkProject = (defaultType = "note"): string => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-harness-"));
  fs.mkdirSync(projectEngramsDir(tmp), { recursive: true });
  fs.writeFileSync(
    projectConfigPath(tmp),
    JSON.stringify({ version: 1, tracked: true, defaultType }),
  );
  return tmp;
};

const mkHome = (): string => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-home-"));
  fs.mkdirSync(path.join(tmp, ".engram", "engrams"), { recursive: true });
  return tmp;
};

/** Seed an engram file directly (bypasses the store's id sequencing). */
const seed = (root: string, id: string, over: Partial<EngramInput>): string => {
  const i = input({ ...over, title: over.title ?? `Entry ${id}` });
  const file = path.join(projectEngramsDir(root), `${id}-entry.md`);
  const fm = [
    `id: "${id}"`,
    `title: ${JSON.stringify(i.title)}`,
    `type: ${i.type}`,
    `tags: [${i.tags.map((t) => JSON.stringify(t)).join(", ")}]`,
    "scope: project",
    "created: 2026-08-16T10:00:00.000Z",
    "updated: 2026-08-16T10:00:00.000Z",
    `author: ${JSON.stringify(i.author ?? "Tester")}`,
    ...(i.pinned ? ["pinned: true"] : []),
  ].join("\n");
  fs.writeFileSync(file, `---\n${fm}\n---\n${i.body}\n`);
  return file;
};

const seedPersonal = (home: string, id: string, over: Partial<EngramInput>): void => {
  const i = input({ ...over, title: over.title ?? `Personal ${id}` });
  const file = path.join(home, ".engram", "engrams", `${id}-personal.md`);
  const fm = [
    `id: "${id}"`,
    `title: ${JSON.stringify(i.title)}`,
    `type: ${i.type}`,
    "tags: []",
    "scope: personal",
    "created: 2026-08-16T10:00:00.000Z",
    "updated: 2026-08-16T10:00:00.000Z",
  ].join("\n");
  fs.writeFileSync(file, `---\n${fm}\n---\n${i.body}\n`);
};

const run = <A>(
  eff: Effect.Effect<A, never, EngramStore | ConfigRepo | FileSystem | Path>,
): Promise<A> => Effect.runPromise(Effect.provide(eff, MainLive));

// eslint-disable-next-line no-control-regex -- intentionally detecting ANSI escapes
const ANSI = /\u001b\[/;

/* ------------------------- context digest ------------------------- */

describe("shared ops / contextDigest", () => {
  let orig = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  beforeEach(() => {
    orig = process.cwd();
    origHome = process.env.HOME;
    tmp = mkProject();
    home = mkHome();
    process.chdir(tmp);
    process.env.HOME = home;
  });
  afterEach(() => {
    process.chdir(orig);
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("groups decisions and pinned first, plain text only", async () => {
    seed(tmp, "0001", { type: "note", title: "Plain note" });
    seed(tmp, "0002", { type: "decision", title: "Big decision" });
    seed(tmp, "0003", { type: "note", title: "Pinned note", pinned: true });

    const res = await run(contextDigest({ scope: "project" }));
    expect(res.isError).toBe(false);
    expect(res.text).not.toMatch(ANSI);
    const decisionIdx = res.text.indexOf("Big decision");
    const plainIdx = res.text.indexOf("Plain note");
    expect(decisionIdx).toBeGreaterThan(-1);
    expect(plainIdx).toBeGreaterThan(decisionIdx);
    expect(res.text).toContain("Pinned note");
    expect(res.details).toMatchObject({ total: 3, offset: 0, nextOffset: null });
  });

  it("paginates: default limit 25, nextOffset set, footer instructs the next call", async () => {
    for (let i = 1; i <= 30; i++) seed(tmp, String(i).padStart(4, "0"), { title: `Entry ${i}` });

    const page1 = await run(contextDigest({ scope: "project" }));
    expect(page1.details).toMatchObject({ total: 30, nextOffset: 25 });
    expect(page1.text).toContain('engram_context({"offset":25,"scope":"project"})');

    const page2 = await run(contextDigest({ scope: "project", offset: 25 }));
    expect(page2.details).toMatchObject({ total: 30, nextOffset: null });
    expect(page2.text).toContain("Entry 30");
    expect(page2.text).not.toContain("Entry 24");
  });

  it("scope both renders a section per scope", async () => {
    seed(tmp, "0001", { type: "decision", title: "Project decision" });
    seedPersonal(home, "0007", { title: "Personal fact", type: "fact" });

    const res = await run(contextDigest({ scope: "both" }));
    expect(res.text).toContain("Project decision");
    expect(res.text).toContain("Personal fact");
    expect(res.details).toMatchObject({ total: 2 });
  });

  it("no project root: serves personal scope with a note, not an error", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "engram-empty-"));
    process.chdir(empty);
    try {
      seedPersonal(home, "0002", { title: "Lonely personal" });
      const res = await run(contextDigest({}));
      expect(res.isError).toBe(false);
      expect(res.text).toContain("Lonely personal");
      expect(res.text).toContain("personal");
      expect(res.text.toLowerCase()).toContain("no project");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("explicit project scope without a project root is an error with an init hint", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "engram-empty-"));
    process.chdir(empty);
    try {
      const res = await run(contextDigest({ scope: "project" }));
      expect(res.isError).toBe(true);
      expect(res.text).toContain("engram init");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("empty store: friendly text, not an error", async () => {
    const res = await run(contextDigest({ scope: "project" }));
    expect(res.isError).toBe(false);
    expect(res.text.length).toBeGreaterThan(0);
  });
});

/* ----------------------------- search ----------------------------- */

describe("shared ops / searchOp", () => {
  let orig = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  beforeEach(() => {
    orig = process.cwd();
    origHome = process.env.HOME;
    tmp = mkProject();
    home = mkHome();
    process.chdir(tmp);
    process.env.HOME = home;
  });
  afterEach(() => {
    process.chdir(orig);
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("matches by title and tag, orders by relevance", async () => {
    seed(tmp, "0001", { title: "Auth flow", tags: ["auth"], body: "b" });
    seed(tmp, "0002", { title: "Unrelated", tags: [], body: "mentions auth once" });
    seed(tmp, "0003", { title: "auth auth auth", tags: [], body: "b" });

    const res = await run(searchOp({ query: "auth", scope: "project" }));
    expect(res.isError).toBe(false);
    expect(res.details).toMatchObject({ total: 3 });
    // scores: "Auth flow" tag(+5)+title(+3)=8, "auth auth auth" title=3, "Unrelated" body=1
    const i1 = res.text.indexOf("Auth flow");
    const i2 = res.text.indexOf("Unrelated");
    const i3 = res.text.indexOf("auth auth auth");
    expect(i1).toBeGreaterThan(-1);
    expect(i1).toBeLessThan(i3);
    expect(i3).toBeLessThan(i2);
  });

  it("paginates with offset and a next-call footer", async () => {
    for (let i = 1; i <= 15; i++)
      seed(tmp, String(i).padStart(4, "0"), { title: `auth thing ${i}`, body: "auth" });

    const page1 = await run(searchOp({ query: "auth", scope: "project" }));
    expect(page1.details).toMatchObject({ total: 15, nextOffset: 10 });
    expect(page1.text).toContain('engram_search({"query":"auth","offset":10,"scope":"project"})');

    const page2 = await run(searchOp({ query: "auth", scope: "project", offset: 10 }));
    expect(page2.details).toMatchObject({ nextOffset: null });
    expect(page2.text).toContain("auth thing 15");
  });

  it("ranks across scopes: a strong personal match outranks a weak project match", async () => {
    seed(tmp, "0001", { title: "Unrelated", body: "mentions auth once" });
    seedPersonal(home, "0005", { title: "Auth flow", tags: ["auth"], body: "b" });

    const res = await run(searchOp({ query: "auth", scope: "both" }));
    const iProject = res.text.indexOf("Unrelated");
    const iPersonal = res.text.indexOf("Auth flow");
    expect(iPersonal).toBeGreaterThan(-1);
    expect(iProject).toBeGreaterThan(-1);
    expect(iPersonal).toBeLessThan(iProject);
  });

  it("no matches is not an error", async () => {
    seed(tmp, "0001", { title: "Auth flow" });
    const res = await run(searchOp({ query: "zzz-nothing", scope: "project" }));
    expect(res.isError).toBe(false);
    expect(res.text.toLowerCase()).toContain("no match");
  });
});

/* ------------------------------ show ------------------------------ */

describe("shared ops / showOp", () => {
  let orig = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  beforeEach(() => {
    orig = process.cwd();
    origHome = process.env.HOME;
    tmp = mkProject();
    home = mkHome();
    process.chdir(tmp);
    process.env.HOME = home;
  });
  afterEach(() => {
    process.chdir(orig);
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("renders frontmatter summary plus full body", async () => {
    seed(tmp, "0004", {
      title: "Use date-fns",
      type: "decision",
      tags: ["deps", "time"],
      body: "moment is deprecated; date-fns is tree-shakeable.",
    });

    const res = await run(showOp({ id: "0004", scope: "project" }));
    expect(res.isError).toBe(false);
    expect(res.text).toContain("Use date-fns");
    expect(res.text).toContain("decision");
    expect(res.text).toContain("#deps");
    expect(res.text).toContain("moment is deprecated; date-fns is tree-shakeable.");
    expect(res.details).toMatchObject({ id: "0004", scope: "project" });
  });

  it("resolves id prefixes", async () => {
    seed(tmp, "0001", { title: "Only one" });
    const res = await run(showOp({ id: "0", scope: "project" }));
    expect(res.isError).toBe(false);
    expect(res.text).toContain("Only one");
  });

  it("auto-detects scope: falls back to personal when no project root", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "engram-empty-"));
    process.chdir(empty);
    try {
      seedPersonal(home, "0009", { title: "Personal only entry" });
      const res = await run(showOp({ id: "0009" }));
      expect(res.isError).toBe(false);
      expect(res.text).toContain("Personal only entry");
      expect(res.details).toMatchObject({ scope: "personal" });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("slices long bodies with a nextOffset and footer", async () => {
    seed(tmp, "0002", { title: "Long one", body: "y".repeat(500) });

    const page1 = await run(showOp({ id: "0002", scope: "project", limit: 100 }));
    expect(page1.details).toMatchObject({ id: "0002", nextOffset: 100 });
    expect(page1.text).toContain(
      'engram_show({"id":"0002","scope":"project","offset":100,"limit":100})',
    );

    const page2 = await run(showOp({ id: "0002", scope: "project", offset: 400 }));
    expect(page2.details).toMatchObject({ nextOffset: null });
    expect(page2.text).toContain("y".repeat(100));
  });

  it("cap-aligned cursor: oversized bodies keep a valid continuation offset", async () => {
    seed(tmp, "0003", { title: "Huge", body: "z".repeat(30_000) });

    const page1 = await run(showOp({ id: "0003", scope: "project" }));
    expect(page1.text.length).toBeLessThanOrEqual(8192);
    expect(page1.text).toContain("body truncated - call");
    const next = page1.details.nextOffset as number;
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThanOrEqual(8192);

    // following the cursor repeatedly returns every char without skipping
    let offset = 0;
    let total = 0;
    for (let guard = 0; guard < 10; guard++) {
      const r = await run(showOp({ id: "0003", scope: "project", offset }));
      total += (r.text.match(/z/g) ?? []).length;
      const next = r.details.nextOffset as number | null;
      if (next === null) break;
      offset = next;
    }
    expect(total).toBe(30_000);
  });

  it("explicit project scope without a project root returns the init hint", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "engram-empty-"));
    process.chdir(empty);
    try {
      const res = await run(showOp({ id: "0001", scope: "project" }));
      expect(res.isError).toBe(true);
      expect(res.text).toContain("engram init");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("unknown id is an error", async () => {
    const res = await run(showOp({ id: "9999", scope: "project" }));
    expect(res.isError).toBe(true);
    expect(res.text).toContain("9999");
  });

  it("ambiguous prefix is an error listing the matches", async () => {
    seed(tmp, "0010", { title: "A" });
    seed(tmp, "0011", { title: "B" });
    const res = await run(showOp({ id: "001", scope: "project" }));
    expect(res.isError).toBe(true);
    expect(res.text).toContain("0010");
    expect(res.text).toContain("0011");
  });
});

/* ------------------------------- add ------------------------------- */

describe("shared ops / addOp", () => {
  let orig = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  beforeEach(() => {
    orig = process.cwd();
    origHome = process.env.HOME;
    tmp = mkProject("decision");
    home = mkHome();
    process.chdir(tmp);
    process.env.HOME = home;
  });
  afterEach(() => {
    process.chdir(orig);
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("defaults to project scope, config defaultType, and writes the file", async () => {
    const res = await run(addOp({ title: "Chose Postgres", body: "because of RLS", tags: ["db"] }));
    expect(res.isError).toBe(false);
    expect(res.details).toMatchObject({ scope: "project", type: "decision" });
    const id = res.details.id as string;
    expect(typeof id).toBe("string");
    const file = res.details.path as string;
    expect(fs.existsSync(file)).toBe(true);

    const listed = await run(contextDigest({ scope: "project" }));
    expect(listed.text).toContain("Chose Postgres");
  });

  it("explicit personal scope writes under $HOME/.engram", async () => {
    const res = await run(
      addOp({ title: "Private note", body: "b", scope: "personal", type: "note" }),
    );
    expect(res.isError).toBe(false);
    expect(res.details).toMatchObject({ scope: "personal" });
    expect((res.details.path as string).startsWith(home)).toBe(true);
  });

  it("uninitialized project + default scope is an error hinting init or personal", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "engram-empty-"));
    process.chdir(empty);
    try {
      const res = await run(addOp({ title: "T", body: "b" }));
      expect(res.isError).toBe(true);
      expect(res.text).toContain("engram init");
      expect(res.text).toContain("personal");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("empty title is a validation error", async () => {
    const res = await run(addOp({ title: "   ", body: "b" }));
    expect(res.isError).toBe(true);
    expect(res.text.toLowerCase()).toContain("title");
  });
});

/* ------------------------------- init ------------------------------- */

describe("shared ops / initOp", () => {
  let orig = "";
  let origHome: string | undefined;
  let home = "";
  beforeEach(() => {
    orig = process.cwd();
    origHome = process.env.HOME;
    home = mkHome();
    process.env.HOME = home;
  });
  afterEach(() => {
    process.chdir(orig);
    process.env.HOME = origHome;
  });

  it("creates .engram structure, config, README; seeds global author", async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "engram-init-"));
    process.chdir(fresh);
    try {
      const res = await run(initOp({ tracked: true }));
      expect(res.isError).toBe(false);
      expect(res.text).toContain(".engram");
      expect(res.details).toMatchObject({ root: fresh, tracked: true });
      expect(fs.existsSync(projectEngramsDir(fresh))).toBe(true);
      expect(fs.existsSync(projectReadmePath(fresh))).toBe(true);
      expect(JSON.parse(fs.readFileSync(projectConfigPath(fresh), "utf8"))).toMatchObject({
        tracked: true,
      });
      const globalCfg = JSON.parse(
        fs.readFileSync(path.join(home, ".engram", "config.json"), "utf8"),
      );
      expect(typeof globalCfg.author).toBe("string");
      expect(globalCfg.author.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("tracked=false with a .git dir adds the gitignore line", async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "engram-init-"));
    fs.mkdirSync(path.join(fresh, ".git"));
    process.chdir(fresh);
    try {
      const res = await run(initOp({ tracked: false }));
      expect(res.isError).toBe(false);
      expect(res.details).toMatchObject({ tracked: false });
      const gi = fs.readFileSync(path.join(fresh, ".gitignore"), "utf8");
      expect(gi).toContain(".engram/");
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("already-initialized project reports so without error", async () => {
    const ready = mkProject();
    process.chdir(ready);
    try {
      const res = await run(initOp({ tracked: true }));
      expect(res.isError).toBe(false);
      expect(res.text.toLowerCase()).toContain("already");
    } finally {
      fs.rmSync(ready, { recursive: true, force: true });
    }
  });
});
