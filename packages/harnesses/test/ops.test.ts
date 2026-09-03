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
    ...(i.status !== undefined ? [`status: ${i.status}`] : []),
    ...(i.supersedes !== undefined ? [`supersedes: ${JSON.stringify(i.supersedes)}`] : []),
    ...(i.reviewAfter !== undefined ? [`reviewAfter: ${i.reviewAfter}`] : []),
    ...(i.expires !== undefined ? [`expires: ${i.expires}`] : []),
    ...(i.sourceType !== undefined ? [`sourceType: ${i.sourceType}`] : []),
    ...(i.sourceRef !== undefined ? [`sourceRef: ${JSON.stringify(i.sourceRef)}`] : []),
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

/* --------------------- integrity warnings --------------------- */

const WARNING_PREFIX = "WARNING: Engram memory is incomplete.";

const seedBroken = (dir: string, name: string): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "---\ntitle: [unclosed\n---\nBody\n");
  return file;
};

describe("shared ops / integrity warnings", () => {
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

  it("contextDigest returns valid memory plus one bounded warning for a malformed sibling", async () => {
    seed(tmp, "0001", { title: "Healthy note" });
    seedBroken(projectEngramsDir(tmp), "0002-broken.md");

    const res = await run(contextDigest({ scope: "project" }));
    expect(res.isError).toBe(false);
    expect(res.text.startsWith(WARNING_PREFIX)).toBe(true);
    expect(res.text).toContain("Healthy note");
    expect(res.text).toContain("engram check");
    // bounded: exactly one warning occurrence, no file lists
    expect(res.text.split(WARNING_PREFIX)).toHaveLength(2);
    expect(res.text).not.toContain("0002-broken.md");
    // structured details report incomplete memory and counts
    expect(res.details).toMatchObject({
      memoryIncomplete: true,
      omittedFiles: 1,
    });
    expect(res.details.diagnosticCount).toBeGreaterThanOrEqual(1);
  });

  it("a clean digest carries no warning and reports complete memory", async () => {
    // title slugifies to "entry", matching the seed's <id>-entry.md filename:
    // a fully consistent store, diagnostics-free
    seed(tmp, "0001", { title: "Entry" });

    const res = await run(contextDigest({ scope: "project" }));
    expect(res.isError).toBe(false);
    expect(res.text).not.toContain(WARNING_PREFIX);
    expect(res.details).toMatchObject({
      memoryIncomplete: false,
      omittedFiles: 0,
      diagnosticCount: 0,
    });
  });

  it("warnings aggregate across scopes into one line", async () => {
    seed(tmp, "0001", { title: "Healthy note" });
    seedBroken(projectEngramsDir(tmp), "0002-broken.md");
    seedBroken(path.join(home, ".engram", "engrams"), "0003-broken.md");

    const res = await run(contextDigest({ scope: "both" }));
    expect(res.isError).toBe(false);
    expect(res.text.startsWith(WARNING_PREFIX)).toBe(true);
    expect(res.text).toContain("Skipped 2 unreadable or invalid files");
    expect(res.text.split(WARNING_PREFIX)).toHaveLength(2);
  });

  it("the warning survives result capping (prepended, cap cuts the tail)", async () => {
    for (let i = 0; i < 200; i++) {
      seed(tmp, String(i).padStart(4, "0"), { title: `Filler entry number ${i} for the cap test` });
    }
    seedBroken(projectEngramsDir(tmp), "9001-broken.md");

    const res = await run(contextDigest({ scope: "project", limit: 250 }));
    expect(res.isError).toBe(false);
    // the body exceeded the cap and was truncated...
    expect(res.text).toContain("(result truncated)");
    // ...and the warning is still first, intact
    expect(res.text.startsWith(WARNING_PREFIX)).toBe(true);
    expect(res.details).toMatchObject({ memoryIncomplete: true, omittedFiles: 1 });
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

/* ------------------------- show: lifecycle ------------------------- */

describe("shared ops / showOp lifecycle", () => {
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

  it("renders all six lifecycle fields when set, with exact instants", async () => {
    seed(tmp, "0001", {
      title: "Entry",
      status: "superseded",
      supersedes: "0002",
      reviewAfter: "2026-01-01T00:00:00.000Z",
      expires: "2026-06-01T00:00:00.000Z",
      sourceType: "file",
      sourceRef: "docs/a.md",
    });

    const res = await run(showOp({ id: "0001", scope: "project" }));
    expect(res.isError).toBe(false);
    // exact stored instants, never date-shortened
    expect(res.text).toContain("status: superseded");
    expect(res.text).toContain("supersedes: 0002");
    expect(res.text).toContain("review-after: 2026-01-01T00:00:00.000Z");
    expect(res.text).toContain("expires: 2026-06-01T00:00:00.000Z");
    // independent provenance fields, renderFull-style join
    expect(res.text).toContain("source: file \u00b7 docs/a.md");
  });

  it("renders no lifecycle labels for an entry without lifecycle fields", async () => {
    seed(tmp, "0002", { title: "Plain entry", body: "b" });

    const res = await run(showOp({ id: "0002", scope: "project" }));
    expect(res.isError).toBe(false);
    expect(res.text).not.toContain("status:");
    expect(res.text).not.toContain("supersedes:");
    expect(res.text).not.toContain("review-after:");
    expect(res.text).not.toContain("expires:");
    expect(res.text).not.toContain("source:");
  });

  it("renders a one-sided provenance field without a placeholder", async () => {
    seed(tmp, "0003", { title: "Only a ref", sourceRef: "docs/a.md" });
    const refOnly = await run(showOp({ id: "0003", scope: "project" }));
    expect(refOnly.text).toContain("source: docs/a.md");
    expect(refOnly.text).not.toContain("undefined");

    seed(tmp, "0004", { title: "Only a type", sourceType: "command" });
    const typeOnly = await run(showOp({ id: "0004", scope: "project" }));
    expect(typeOnly.text).toContain("source: command");
    expect(typeOnly.text).not.toContain("undefined");
  });

  it("lifecycle header is built before body-capacity math: cursor walk stays lossless", async () => {
    seed(tmp, "0005", {
      title: "Huge with lifecycle",
      status: "active",
      reviewAfter: "2026-01-01T00:00:00.000Z",
      body: "z".repeat(30_000),
    });

    const page1 = await run(showOp({ id: "0005", scope: "project" }));
    expect(page1.text.length).toBeLessThanOrEqual(8192);
    expect(page1.text).toContain("body truncated - call");

    let offset = 0;
    let total = 0;
    for (let guard = 0; guard < 10; guard++) {
      const r = await run(showOp({ id: "0005", scope: "project", offset }));
      total += (r.text.match(/z/g) ?? []).length;
      const next = r.details.nextOffset as number | null;
      if (next === null) break;
      offset = next;
    }
    expect(total).toBe(30_000);
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

  it("carries all six lifecycle inputs end-to-end through the store", async () => {
    const res = await run(
      addOp({
        title: "Recorded with lifecycle",
        body: "b",
        status: "active",
        supersedes: "0001",
        reviewAfter: "2026-01-01T00:00:00.000Z",
        expires: "2026-06-01T00:00:00.000Z",
        sourceType: "conversation",
        sourceRef: "standup notes, 2026-08-01",
      }),
    );
    expect(res.isError).toBe(false);
    const file = res.details.path as string;
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain("status: active");
    expect(content).toContain('supersedes: "0001"');
    expect(content).toContain("reviewAfter: 2026-01-01T00:00:00.000Z");
    expect(content).toContain("expires: 2026-06-01T00:00:00.000Z");
    expect(content).toContain("sourceType: conversation");
    expect(content).toContain("standup notes, 2026-08-01");

    // round trip: the id from addOp renders through showOp
    const shown = await run(showOp({ id: res.details.id as string, scope: "project" }));
    expect(shown.text).toContain("status: active");
    expect(shown.text).toContain("source: conversation \u00b7 standup notes, 2026-08-01");
  });

  it("rejects an invalid status before anything is written", async () => {
    const res = await run(addOp({ title: "T", body: "b", status: "bogus" as never }));
    expect(res.isError).toBe(true);
    expect(res.text).toContain('"bogus"');
    expect(res.text).toContain("Valid: active, superseded, archived");
    expect(fs.readdirSync(projectEngramsDir(tmp))).toEqual([]);
  });

  it("rejects an invalid sourceType before anything is written", async () => {
    const res = await run(addOp({ title: "T", body: "b", sourceType: "website" as never }));
    expect(res.isError).toBe(true);
    expect(res.text).toContain('"website"');
    expect(res.text).toContain("Valid: conversation, file, url, command, other");
    expect(fs.readdirSync(projectEngramsDir(tmp))).toEqual([]);
  });

  it("store write boundary rejects a malformed supersedes id with no mutation", async () => {
    const res = await run(addOp({ title: "T", body: "b", supersedes: "nope" }));
    expect(res.isError).toBe(true);
    expect(fs.readdirSync(projectEngramsDir(tmp))).toEqual([]);
  });

  it("store write boundary rejects a date-only reviewAfter with no mutation", async () => {
    const res = await run(addOp({ title: "T", body: "b", reviewAfter: "2026-01-01" }));
    expect(res.isError).toBe(true);
    expect(fs.readdirSync(projectEngramsDir(tmp))).toEqual([]);
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
