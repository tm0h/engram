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
import type { OpResult } from "../src/shared/types.js";
import { contextDigest, searchOp, showOp, addOp, editOp, initOp } from "../src/shared/ops.js";
import type { EditOptions } from "../src/shared/types.js";

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

  it("exposes paginated score metadata and optional reasons without bodies or paths", async () => {
    seed(tmp, "0001", { title: "Auth", body: "PRIVATE_BODY" });
    seed(tmp, "0002", { title: "Other", body: "auth PRIVATE_DETAIL" });
    const res = await run(
      searchOp({ query: "auth", scope: "project", explain: true, limit: 1, offset: 1 }),
    );
    expect(res.details).toMatchObject({
      schemaVersion: 1,
      query: "auth",
      total: 2,
      offset: 1,
      results: [
        {
          id: "0002",
          scope: "project",
          score: 1,
          explanation: { contributions: [{ field: "body", token: "auth", score: 1 }] },
        },
      ],
    });
    expect(JSON.stringify(res)).not.toMatch(/PRIVATE_BODY|PRIVATE_DETAIL/);
    expect(JSON.stringify(res)).not.toContain(tmp);
    const plain = await run(searchOp({ query: "auth", scope: "project" }));
    expect((plain.details.results as object[])[0]).not.toHaveProperty("explanation");
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
    // ENG-17 R5: supersedes must resolve to an existing active entry
    seed(tmp, "0001", { type: "note", title: "Predecessor" });
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

/* ------------------------------- edit ------------------------------- */

/** Just the serialized lifecycle lines of one engram file (order kept). */
const lifecycleLines = (file: string): string =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => /^(status|supersedes|reviewAfter|expires|sourceType|sourceRef):/.test(l))
    .join("\n");

describe("shared ops / editOp", () => {
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

  /** Entry with every lifecycle field set, plus a plain sibling for supersedes. */
  const seedLifecycle = (id = "0001"): void => {
    seed(tmp, "0002", { title: "Predecessor" });
    seed(tmp, id, {
      status: "active",
      supersedes: "0000",
      reviewAfter: "2027-01-01T00:00:00.000Z",
      expires: "2027-06-01T00:00:00.000Z",
      sourceType: "file",
      sourceRef: "docs/a.md",
    });
  };

  /** Run a doomed editOp and prove the target file kept its exact bytes. */
  const expectByteIdenticalRejection = async (
    file: string,
    opts: EditOptions,
  ): Promise<OpResult> => {
    const before = fs.readFileSync(file, "utf8");
    const res = await run(editOp(opts));
    expect(res.isError).toBe(true);
    expect(typeof res.details.error).toBe("string");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    return res;
  };

  it("replaces title, type, tags, and body; normalizes tags", async () => {
    const file = seed(tmp, "0001", { type: "note", tags: ["old"], body: "Old body" });
    const res = await run(
      editOp({
        id: "0001",
        title: "  Renamed entry  ",
        type: "decision",
        tags: [" Auth ", "auth", "DEPS", ""],
        body: "  Fresh body  ",
      }),
    );
    expect(res.isError).toBe(false);
    expect(res.text).not.toMatch(ANSI);
    expect(res.details).toMatchObject({ id: "0001", scope: "project", type: "decision" });
    expect(res.text).toBe(
      `Updated [0001] Renamed entry\n  ${res.details.path as string}\n  scope: project`,
    );
    // title edit renames the file and removes the old one
    expect(fs.existsSync(res.details.path as string)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    const text = fs.readFileSync(res.details.path as string, "utf8");
    expect(text).toContain("Renamed entry");
    expect(text).toMatch(/^type: decision$/m);
    expect(text).toContain("Fresh body");
    expect(text).toContain("auth");
    expect(text).toContain("deps");
    expect(text).not.toContain("Old body");
    expect(text).not.toContain("old");
  });

  it("lifecycle fields replace, preserve on omission, and clear with null", async () => {
    seedLifecycle();
    // ENG-17 R1: the seed's dangling supersedes "0000" cannot be re-pointed
    // to "0002" in one step; clear it first, then establish the new link.
    const clearedSeed = await run(editOp({ id: "0001", supersedes: null }));
    expect(clearedSeed.isError).toBe(false);
    const replaced = await run(
      editOp({
        id: "0001",
        status: "superseded",
        supersedes: "0002",
        reviewAfter: "2028-01-01T00:00:00.000Z",
        expires: "2028-06-01T00:00:00.000Z",
        sourceType: "url",
        sourceRef: "https://example.com/a",
      }),
    );
    expect(replaced.isError).toBe(false);
    const after = fs.readFileSync(replaced.details.path as string, "utf8");
    expect(after).toMatch(/^status: superseded$/m);
    expect(after).toMatch(/^supersedes: "0002"$/m);
    expect(after).toMatch(/^reviewAfter: 2028-01-01T00:00:00\.000Z$/m);
    expect(after).toMatch(/^expires: 2028-06-01T00:00:00\.000Z$/m);
    expect(after).toMatch(/^sourceType: url$/m);
    expect(after).toMatch(/^sourceRef: https:\/\/example\.com\/a$/m);

    // Omission preserves: an edit without lifecycle fields leaves every
    // serialized lifecycle line byte-for-byte identical.
    const before = lifecycleLines(replaced.details.path as string);
    expect(before.split("\n")).toHaveLength(6);
    const preserved = await run(editOp({ id: "0001", title: "Retitled with lifecycle" }));
    expect(preserved.isError).toBe(false);
    expect(lifecycleLines(preserved.details.path as string)).toBe(before);

    // null clears: the six YAML keys disappear entirely.
    const cleared = await run(
      editOp({
        id: "0001",
        status: null,
        supersedes: null,
        reviewAfter: null,
        expires: null,
        sourceType: null,
        sourceRef: null,
      }),
    );
    expect(cleared.isError).toBe(false);
    expect(lifecycleLines(cleared.details.path as string)).toBe("");
  });

  it("scope: explicit wins; default is project inside a project, personal outside", async () => {
    seed(tmp, "0001", {});
    seedPersonal(home, "0007", {});

    const explicitProject = await run(editOp({ id: "0001", scope: "project", body: "p" }));
    expect(explicitProject.details).toMatchObject({ scope: "project" });
    const explicitPersonal = await run(editOp({ id: "0007", scope: "personal", body: "p" }));
    expect(explicitPersonal.details).toMatchObject({ scope: "personal" });
    const defaultProject = await run(editOp({ id: "0001", body: "p" }));
    expect(defaultProject.details).toMatchObject({ scope: "project" });

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "engram-edit-out-"));
    process.chdir(outside);
    try {
      const defaultPersonal = await run(editOp({ id: "0007", body: "h" }));
      expect(defaultPersonal.details).toMatchObject({ scope: "personal" });
      const noProject = await run(editOp({ id: "0007", scope: "project", body: "h" }));
      expect(noProject.isError).toBe(true);
      expect(noProject.details.error).toContain("No .engram/ project found");
      expect(noProject.details.error).toContain("engram init");
    } finally {
      process.chdir(tmp);
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("resolves unique prefixes; reports not-found and ambiguous ids", async () => {
    seed(tmp, "0001", {});
    seed(tmp, "0002", {});
    seed(tmp, "0003", {});
    seed(tmp, "aaaaaaaaaaaaaaaaaaaaaaaa01", {});

    const prefix = await run(editOp({ id: "aaaaaaaaaaaaaaaaaaaaaaaa", body: "x" }));
    expect(prefix.isError).toBe(false);
    expect(prefix.details).toMatchObject({ id: "aaaaaaaaaaaaaaaaaaaaaaaa01" });

    const notFound = await run(editOp({ id: "9999", body: "x" }));
    expect(notFound.isError).toBe(true);
    expect(notFound.details.error).toContain("9999");

    const ambiguous = await run(editOp({ id: "000", body: "x" }));
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.details.error).toMatch(/ambiguous/i);
  });

  it("op-level rejections leave the file byte-identical", async () => {
    seedLifecycle();
    const target = path.join(
      projectEngramsDir(tmp),
      fs.readdirSync(projectEngramsDir(tmp)).find((f) => f.startsWith("0001"))!,
    );

    await expectByteIdenticalRejection(target, {
      id: "0001",
      title: "   ",
    });
    await expectByteIdenticalRejection(target, { id: "0001", type: "bogus" as never });
    await expectByteIdenticalRejection(target, { id: "0001", status: "bogus" as never });
    await expectByteIdenticalRejection(target, { id: "0001", sourceType: "website" as never });
  });

  it("store-boundary rejections leave the file byte-identical", async () => {
    seedLifecycle();
    const target = path.join(
      projectEngramsDir(tmp),
      fs.readdirSync(projectEngramsDir(tmp)).find((f) => f.startsWith("0001"))!,
    );

    await expectByteIdenticalRejection(target, {
      id: "0001",
      reviewAfter: "2026-01-01",
    });
    await expectByteIdenticalRejection(target, { id: "0001", supersedes: "nope" });
    await expectByteIdenticalRejection(target, { id: "0001", supersedes: "0001" });
    await expectByteIdenticalRejection(target, { id: "0001", sourceRef: "   " });
  });

  it("pinned and author replace without touching unrelated fields", async () => {
    seed(tmp, "0001", { author: "Tester" });
    const res = await run(editOp({ id: "0001", pinned: true, author: "New Author" }));
    expect(res.isError).toBe(false);
    const text = fs.readFileSync(res.details.path as string, "utf8");
    expect(text).toMatch(/^pinned: true$/m);
    expect(text).toMatch(/^author: New Author$/m);
  });
});

/* ------------------- ENG-17: lifecycle-aware delivery ------------------- */

describe("shared ops / inactive filtering (ENG-17 R3)", () => {
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

  const seedLifecycleSet = (): void => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    seed(tmp, "0001", { type: "note", title: "Active alpha" });
    seed(tmp, "0002", { type: "note", title: "Superseded beta", status: "superseded" });
    seed(tmp, "0003", { type: "note", title: "Archived gamma", status: "archived" });
    seed(tmp, "0004", { type: "note", title: "Expired delta", expires: past });
    seed(tmp, "0005", { type: "note", title: "Future epsilon", expires: future });
  };

  it("contextDigest excludes inactive entries by default", async () => {
    seedLifecycleSet();
    const res = await run(contextDigest({ scope: "project" }));
    expect(res.isError).toBe(false);
    expect(res.text).toContain("Active alpha");
    expect(res.text).toContain("Future epsilon");
    expect(res.text).not.toContain("Superseded beta");
    expect(res.text).not.toContain("Archived gamma");
    expect(res.text).not.toContain("Expired delta");
    expect(res.details).toMatchObject({ total: 2 });
  });

  it("searchOp inherits the same default via searchEngrams", async () => {
    seedLifecycleSet();
    // "body" matches every seeded entry (they share the default body text)
    const res = await run(searchOp({ query: "body" }));
    expect(res.isError).toBe(false);
    expect(res.text).toContain("Active alpha");
    expect(res.text).toContain("Future epsilon");
    expect(res.text).not.toContain("Superseded beta");
    expect(res.text).not.toContain("Archived gamma");
    expect(res.text).not.toContain("Expired delta");
    expect(res.details).toMatchObject({ total: 2 });
  });
});

describe("shared ops / secret-scan gate (ENG-15)", () => {
  let orig = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  beforeEach(() => {
    orig = process.cwd();
    origHome = process.env.HOME;
    tmp = mkProject("note");
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

  const SECRET = "S3cr3t-V4lue!";
  const SECRET_BODY = `rotated the db password: "${SECRET}" after the incident`;

  it("project add blocks by default as a structured error result, leaving storage untouched", async () => {
    const res = await run(addOp({ title: "Leaky note", body: SECRET_BODY }));
    expect(res.isError).toBe(true);
    expect(res.details).toMatchObject({ reason: "secret_scan_blocked", policy: "block" });
    expect(res.details.findings).toHaveLength(1);
    expect(res.text).not.toContain(SECRET);
    expect(fs.readdirSync(projectEngramsDir(tmp))).toEqual([]);
  });

  it("personal add warns by default and still writes", async () => {
    const res = await run(addOp({ title: "Leaky private", body: SECRET_BODY, scope: "personal" }));
    expect(res.isError).toBe(false);
    expect(res.text).toContain("Secret scan warning");
    expect(res.text).toContain("SEC-CRED-ASSIGNMENT");
    expect(res.text).not.toContain(SECRET);
    const scan = res.details.scan as { policy: string; overrideUsed: boolean };
    expect(scan).toMatchObject({ policy: "warn", overrideUsed: false });
  });

  it("allowSecrets overrides a project block and reports the bypass", async () => {
    const res = await run(addOp({ title: "Leaky note", body: SECRET_BODY, allowSecrets: true }));
    expect(res.isError).toBe(false);
    expect(res.text).toContain("Secret scan bypassed (allowSecrets)");
    expect(res.text).not.toContain(SECRET);
    const scan = res.details.scan as { policy: string; overrideUsed: boolean; findings: unknown[] };
    expect(scan.policy).toBe("block");
    expect(scan.overrideUsed).toBe(true);
    expect(scan.findings).toHaveLength(1);
  });

  it("project policy off disables scanning on the add surface", async () => {
    fs.writeFileSync(
      projectConfigPath(tmp),
      JSON.stringify({ version: 1, tracked: true, defaultType: "note", secretScan: "off" }),
    );
    const res = await run(addOp({ title: "Leaky note", body: SECRET_BODY }));
    expect(res.isError).toBe(false);
    const scan = res.details.scan as { policy: string; findings: unknown[] };
    expect(scan.policy).toBe("off");
    expect(scan.findings).toHaveLength(0);
  });

  it("edit blocks under the project default and never rewrites the file", async () => {
    const seeded = seed(tmp, "0001", { title: "Clean entry", body: "b" });
    const before = fs.readFileSync(seeded, "utf8");
    const res = await run(editOp({ id: "0001", body: SECRET_BODY }));
    expect(res.isError).toBe(true);
    expect(res.details).toMatchObject({ reason: "secret_scan_blocked", policy: "block" });
    expect(res.text).not.toContain(SECRET);
    expect(fs.readFileSync(seeded, "utf8")).toBe(before);
  });

  it("edit with allowSecrets writes and reports the bypass; removing the secret needs no override", async () => {
    // seed a legacy entry whose body holds a secret (scanning was off then);
    // project policy is the default block
    const seeded = seed(tmp, "0002", { title: "Legacy entry", body: SECRET_BODY });
    const bypass = await run(editOp({ id: "0002", title: "Renamed legacy", allowSecrets: true }));
    expect(bypass.isError).toBe(false);
    expect(bypass.text).toContain("Secret scan bypassed (allowSecrets)");
    // removing the secret from the body succeeds under plain block
    const fixed = await run(editOp({ id: "0002", body: "secret moved to the vault" }));
    expect(fixed.isError).toBe(false);
    expect(fs.readFileSync(fixed.details.path as string, "utf8")).toContain(
      "secret moved to the vault",
    );
  });
});
