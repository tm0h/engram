import { describe, it, expect, beforeEach, afterEach } from "@effect/vitest";
import { Effect, Layer } from "effect";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MainLive, projectConfigPath, projectEngramsDir, projectReadmePath } from "@engram/core";
import {
  EngramStore,
  ConfigRepo,
  computeLinkAdjacency,
  slugify,
  type LinkAdjacency,
  type Scope,
} from "@engram/core";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import type { EngramInput } from "@engram/core";
import type { OpResult } from "../src/shared/types.js";
import {
  contextDigest,
  searchOp,
  showOp,
  addOp,
  editOp,
  initOp,
  linksOp,
} from "../src/shared/ops.js";
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
    // ENG-18 BM25 body points for 0002: 1 x ln(2) x tfNorm(len 3, avgdl 2.5)
    const bodyPoints = 0.2912383111596409;
    expect(res.details).toMatchObject({
      schemaVersion: 1,
      query: "auth",
      total: 2,
      offset: 1,
      results: [
        {
          id: "0002",
          scope: "project",
          explanation: { contributions: [{ field: "body", token: "auth" }] },
        },
      ],
    });
    const first = (
      res.details.results as Array<{
        score: number;
        explanation: { contributions: Array<{ score: number }> };
      }>
    )[0];
    expect(first.score).toBeCloseTo(bodyPoints, 5);
    expect(first.explanation.contributions[0]?.score).toBeCloseTo(bodyPoints, 5);
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

describe("shared ops / ENG-42 related", () => {
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
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  const rawFile = (needle: string): string => {
    const dir = projectEngramsDir(tmp);
    for (const f of fs.readdirSync(dir).sort()) {
      const raw = fs.readFileSync(path.join(dir, f), "utf8");
      if (raw.includes(needle)) return raw;
    }
    throw new Error(`no entry containing ${needle}`);
  };

  it("addOp sets an ordered related list without touching missing targets", async () => {
    const res = await run(addOp({ title: "Op source", body: "b", related: ["0002", "0003"] }));
    expect(res.isError).toBe(false);
    const raw = rawFile("Op source");
    expect(raw).toMatch(/^related:\n  - "0002"\n  - "0003"$/m);
  });

  it("editOp replaces, preserves on omission, and clears with null", async () => {
    seed(tmp, "0001", { title: "Op target" });
    seed(tmp, "0002", { title: "Op other" });

    const set = await run(editOp({ id: "0001", related: ["0002"] }));
    expect(set.isError).toBe(false);
    expect(rawFile("Op target")).toMatch(/^related:\n  - "0002"$/m);

    const preserve = await run(editOp({ id: "0001", title: "Op target" }));
    expect(preserve.isError).toBe(false);
    expect(rawFile("Op target")).toMatch(/^related:\n  - "0002"$/m);

    const replace = await run(editOp({ id: "0001", related: [] }));
    expect(replace.isError).toBe(false);
    expect(rawFile("Op target")).toMatch(/^related: \[\]$/m);

    const clear = await run(editOp({ id: "0001", related: null }));
    expect(clear.isError).toBe(false);
    expect(rawFile("Op target")).not.toMatch(/^related:/m);
  });

  it("exact arrays reach the store boundary: duplicates are the store's error", async () => {
    seed(tmp, "0001", { title: "Op dup" });
    const res = await run(editOp({ id: "0001", related: ["0002", "0002"] }));
    expect(res.isError).toBe(true);
    expect(res.text).toContain("more than once");
  });

  it("invalid ids and self-links surface the standard captured validation error", async () => {
    seed(tmp, "0001", { title: "Op invalid" });
    const prefix = await run(editOp({ id: "0001", related: ["12"] }));
    expect(prefix.isError).toBe(true);
    expect(prefix.text).toContain("not a valid engram id");

    const self = await run(editOp({ id: "0001", related: ["0001"] }));
    expect(self.isError).toBe(true);
    expect(self.text).toContain("itself");
    expect(rawFile("Op invalid")).not.toMatch(/^related:/m);
  });

  it("a missing same-scope target stays a successful advisory write", async () => {
    const res = await run(addOp({ title: "Op dangle", body: "b", related: ["0099"] }));
    expect(res.isError).toBe(false);
    expect(rawFile("Op dangle")).toMatch(/- "0099"/);
  });

  it("showOp prints one ordered related header line, or none when unset", async () => {
    seed(tmp, "0001", { title: "Op shown", related: undefined });
    seed(tmp, "0002", { title: "Op linked" });
    await run(editOp({ id: "0001", related: ["0002", "0099"] }));

    const shown = await run(showOp({ id: "0001" }));
    expect(shown.isError).toBe(false);
    expect(shown.text).toContain("related: 0002, 0099");
    expect(shown.text.split("\n").filter((l) => l.startsWith("related:"))).toHaveLength(1);

    await run(editOp({ id: "0001", related: null }));
    const cleared = await run(showOp({ id: "0001" }));
    expect(cleared.text).not.toMatch(/^related:/m);
  });
});

describe("shared ops / showOp related header budget (ENG-42 turn 2)", () => {
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
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** A valid 26-character generated-style id (digits then base32 'a's). */
  const wideId = (n: number): string => (String(1000 + n) + "a".repeat(26)).slice(0, 26);

  const writeWide = (relatedCount: number, bodyTail = ""): void => {
    const ids = Array.from({ length: relatedCount }, (_, i) => wideId(i));
    const fm = [
      "---",
      'id: "0001"',
      'title: "Wide linked"',
      "type: note",
      "tags: []",
      "scope: project",
      "created: 2026-08-16T10:00:00.000Z",
      "updated: 2026-08-16T10:00:00.000Z",
      "related:",
      ...ids.map((i) => `  - "${i}"`),
      "---",
      "start-of-body",
      bodyTail,
      "end-of-body",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(projectEngramsDir(tmp), "0001-wide-linked.md"), fm);
  };

  it("a very long related list cannot squeeze the body out of the show budget", async () => {
    // ~400 x 28 chars of related header previously pushed the header past
    // MAX_RESULT_CHARS - footerReserve, zeroing the body slice and dropping
    // the continuation footer entirely.
    writeWide(400, "x".repeat(11000));
    const first = await run(showOp({ id: "0001" }));
    expect(first.isError).toBe(false);
    expect(first.text).toContain("start-of-body");
    expect(first.text).toContain("(body truncated");
    expect(first.details.nextOffset).toBeGreaterThan(0);
    // the line is bounded with an explicit remainder marker, never silently cut
    expect(first.text).toMatch(/related: .*\u2026 \(\+\d+ more\)/);
    expect(first.text).not.toContain(wideId(399));
    // the elided ids stay retrievable through the op's machine-readable
    // details: the full exact list, in stored order, on every page
    expect(first.details.related).toEqual(Array.from({ length: 400 }, (_, i) => wideId(i)));

    // the continuation offset makes the rest of the body reachable
    const second = await run(showOp({ id: "0001", offset: first.details.nextOffset as number }));
    expect(second.isError).toBe(false);
    expect(second.details.related).toEqual(first.details.related);
    expect(second.text).toContain("end-of-body");
  });

  it("a related line within the header budget renders every id without a marker", async () => {
    writeWide(10);
    const res = await run(showOp({ id: "0001" }));
    expect(res.isError).toBe(false);
    const ids = Array.from({ length: 10 }, (_, i) => wideId(i));
    expect(res.text).toContain(`related: ${ids.join(", ")}`);
    expect(res.text).not.toMatch(/\(\+\d+ more\)/);
    expect(res.text).toContain("start-of-body");
    expect(res.text).toContain("end-of-body");
    expect(res.details.nextOffset).toBeNull();
    expect(res.details.related).toEqual(ids);
  });
});

describe("shared ops / showOp header budgets (ENG-77)", () => {
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
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** A valid 26-character generated-style id (digits then base32 'a's). */
  const wideId = (n: number): string => (String(1000 + n) + "a".repeat(26)).slice(0, 26);

  const writeRaw = (fmLines: string[], body = "start-of-body"): void => {
    const fm = fmLines.join("\n");
    fs.writeFileSync(
      path.join(projectEngramsDir(tmp), "0001-entry.md"),
      `---\n${fm}\n---\n${body}\n`,
    );
  };

  const baseFm = (over: string[] = []): string[] => {
    // the default `tags` line is dropped when `over` supplies its own
    const overridden = (prefix: string): boolean => over.some((l) => l.startsWith(prefix));
    return [
      'id: "0001"',
      `title: ${JSON.stringify("Some title")}`,
      "type: note",
      ...(overridden("tags:") ? [] : ["tags: []"]),
      "scope: project",
      "created: 2026-08-16T10:00:00.000Z",
      "updated: 2026-08-16T10:00:00.000Z",
      ...over,
    ];
  };

  const lineOf = (text: string, prefix: string): string => {
    const line = text.split("\n").find((l) => l.startsWith(prefix));
    if (line === undefined) throw new Error(`no line starting with ${prefix}`);
    return line;
  };

  it("golden: a small entry renders byte-identical to today", async () => {
    seed(tmp, "0004", {
      title: "Use date-fns",
      type: "decision",
      tags: ["deps", "time"],
      author: "Tester",
      body: "moment is deprecated; date-fns is tree-shakeable.",
    });
    const res = await run(showOp({ id: "0004", scope: "project" }));
    expect(res.isError).toBe(false);
    expect(res.text).toBe(
      [
        "# [0004] Use date-fns",
        "type: decision",
        "tags: #deps #time",
        "scope: project",
        "created: 2026-08-16 (updated: 2026-08-16)",
        "author: Tester",
        "moment is deprecated; date-fns is tree-shakeable.",
      ].join("\n"),
    );
  });

  it("tags: a list exactly at the 1024 content budget renders whole and unmarked", async () => {
    // unit = 24-char tag -> #tag cost 25, +2 separator cost beyond first:
    // 25 + 37*27 = 1024 exactly -> all 38 render, no marker.
    const tags = Array.from({ length: 38 }, (_, i) =>
      `t${String(i).padStart(2, "0")}`.padEnd(24, "a"),
    );
    writeRaw(baseFm([`tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`]));
    const res = await run(showOp({ id: "0001" }));
    expect(res.isError).toBe(false);
    const line = lineOf(res.text, "tags:");
    expect(line).toBe(`tags: ${tags.map((t) => `#${t}`).join(" ")}`);
    expect(line).not.toContain("\u2026");
  });

  it("tags: one char over the budget truncates with an exact marker and no partial tag", async () => {
    const tags = Array.from({ length: 39 }, (_, i) =>
      `t${String(i).padStart(2, "0")}`.padEnd(24, "a"),
    );
    writeRaw(baseFm([`tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`]));
    const res = await run(showOp({ id: "0001" }));
    expect(res.isError).toBe(false);
    const line = lineOf(res.text, "tags:");
    const shown = tags.slice(0, 38);
    expect(line).toBe(`tags: ${shown.map((t) => `#${t}`).join(" ")} \u2026 (+1 more)`);
    expect(line).not.toContain(`#${tags[38]}`);
  });

  it("tags: an oversized list names the exact remainder and renders only whole tags", async () => {
    // unit = 20-char tag -> #tag cost 21, +2 beyond first: 44 tags fit
    // (21 + 43*23 = 1010); 45 would not (1033 > 1024) -> rest = 56.
    const tags = Array.from({ length: 100 }, (_, i) =>
      `t${String(i).padStart(2, "0")}`.padEnd(20, "a"),
    );
    writeRaw(baseFm([`tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`]));
    const res = await run(showOp({ id: "0001" }));
    expect(res.isError).toBe(false);
    const line = lineOf(res.text, "tags:");
    expect(line).toBe(
      `tags: ${tags
        .slice(0, 44)
        .map((t) => `#${t}`)
        .join(" ")} \u2026 (+56 more)`,
    );
    expect(line).not.toContain(`#${tags[44]}`);
    expect(res.details.tags).toEqual(tags);
  });

  it("tags: a single oversized tag renders the marker, never a partial tag", async () => {
    const giant = "g".repeat(2000);
    writeRaw(baseFm([`tags: [${JSON.stringify(giant)}]`]));
    const res = await run(showOp({ id: "0001" }));
    expect(res.isError).toBe(false);
    expect(lineOf(res.text, "tags:")).toBe("tags:  \u2026 (+1 more)");
  });

  it("title: exactly at the 1024-char budget renders byte-identical and unmarked", async () => {
    const title = "t".repeat(1024);
    writeRaw([`id: "0001"`, `title: ${JSON.stringify(title)}`, ...baseFm().slice(2)]);
    const res = await run(showOp({ id: "0001" }));
    expect(res.isError).toBe(false);
    expect(res.text.split("\n")[0]).toBe(`# [0001] ${title}`);
  });

  it("title: one char over truncates with the marker and keeps the id prefix", async () => {
    const title = "t".repeat(1025);
    writeRaw([`id: "0001"`, `title: ${JSON.stringify(title)}`, ...baseFm().slice(2)]);
    const res = await run(showOp({ id: "0001" }));
    expect(res.isError).toBe(false);
    expect(res.text.split("\n")[0]).toBe(`# [0001] ${"t".repeat(1024)} \u2026 (+1 chars)`);
    expect(res.details.title).toBe(title);
  });

  it("title: a multi-line oversized title truncates to one line cut at the first newline", async () => {
    const title = `${"a".repeat(600)}\n${"b".repeat(600)}`;
    writeRaw([`id: "0001"`, `title: ${JSON.stringify(title)}`, ...baseFm().slice(2)]);
    const res = await run(showOp({ id: "0001" }));
    expect(res.isError).toBe(false);
    expect(res.text.split("\n")[0]).toBe(`# [0001] ${"a".repeat(600)} \u2026 (+601 chars)`);
    expect(res.text).not.toContain("bbbbbb");
  });

  it("title: a newline past the budget truncates at the budget, still one line", async () => {
    const title = `${"a".repeat(1080)}\n${"b".repeat(100)}`;
    writeRaw([`id: "0001"`, `title: ${JSON.stringify(title)}`, ...baseFm().slice(2)]);
    const res = await run(showOp({ id: "0001" }));
    expect(res.isError).toBe(false);
    expect(res.text.split("\n")[0]).toBe(`# [0001] ${"a".repeat(1024)} \u2026 (+157 chars)`);
  });

  it("combined worst case: header stays bounded, body stays reachable page by page", async () => {
    const title = "t".repeat(1100);
    const tags = Array.from({ length: 400 }, (_, i) =>
      `t${String(i).padStart(3, "0")}`.padEnd(20, "a"),
    );
    const related = Array.from({ length: 400 }, (_, i) => wideId(i));
    writeRaw(
      [
        `id: "0001"`,
        `title: ${JSON.stringify(title)}`,
        "type: note",
        `tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`,
        "scope: project",
        "created: 2026-08-16T10:00:00.000Z",
        "updated: 2026-08-16T10:00:00.000Z",
        "related:",
        ...related.map((r) => `  - "${r}"`),
      ],
      `start-of-body\n${"x".repeat(11000)}\nend-of-body`,
    );
    const first = await run(showOp({ id: "0001" }));
    expect(first.isError).toBe(false);
    expect(first.text.length).toBeLessThanOrEqual(8192);
    expect(first.text).toContain("start-of-body");
    expect(first.text).toContain("(body truncated");
    expect(first.details.nextOffset).toBeGreaterThan(0);
    // no silent loss: the full values stay in details on every page
    expect(first.details.title).toBe(title);
    expect(first.details.tags).toEqual(tags);
    expect(first.details.related).toEqual(related);
    // the continuation cursor reassembles the full body; header and footer
    // contain no "x", so counting x per page reassembles exactly the body
    let offset = 0;
    let xCount = 0;
    let lastText = "";
    for (let guard = 0; guard < 10; guard++) {
      const page = await run(showOp({ id: "0001", offset }));
      lastText = page.text;
      xCount += (page.text.match(/x/g) ?? []).length;
      const next = page.details.nextOffset as number | null;
      if (next === null) break;
      offset = next;
    }
    expect(xCount).toBe(11000);
    expect(lastText).toContain("end-of-body");
  });

  it("F6: author and source lines stay unbounded", async () => {
    const longAuthor = "a".repeat(2000);
    const longRef = "s".repeat(2000);
    writeRaw(
      baseFm([
        `author: ${JSON.stringify(longAuthor)}`,
        "sourceType: conversation",
        `sourceRef: ${JSON.stringify(longRef)}`,
      ]),
    );
    const res = await run(showOp({ id: "0001" }));
    expect(res.isError).toBe(false);
    expect(lineOf(res.text, "author: ")).toBe(`author: ${longAuthor}`);
    expect(lineOf(res.text, "source: ")).toBe(`source: conversation \u00b7 ${longRef}`);
    expect(res.text).not.toContain("\u2026 (+");
  });
});

/* ---------------- ENG-43 link adjacency consumer ---------------- */

describe("shared ops / link adjacency consumer (ENG-43)", () => {
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
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("computeLinkAdjacency consumes one scan through @engram/core and returns serializable data", async () => {
    seed(tmp, "0001", { title: "Adjacency source" });
    seed(tmp, "0002", { title: "Adjacency target" });
    const linked = await run(editOp({ id: "0001", related: ["0002"] }));
    expect(linked.isError).toBe(false);

    // Compile-time assertion: the public core export types the result for
    // shared-layer consumers without any adapter.
    const adjacency: LinkAdjacency = await run(
      Effect.gen(function* () {
        const store = yield* EngramStore;
        const scanned = yield* Effect.orDie(store.scan("project"));
        return computeLinkAdjacency(scanned, "0002");
      }),
    );

    // Runtime assertion: the result is plain JSON-serializable data.
    const roundTripped = JSON.parse(JSON.stringify(adjacency)) as LinkAdjacency;
    expect(roundTripped).toEqual(adjacency);

    expect(adjacency.target.status).toBe("found");
    if (adjacency.target.status === "found") {
      expect(adjacency.target.entry.id).toBe("0002");
    }
    expect(adjacency.incoming.map((m) => m.id)).toEqual(["0001"]);
    expect(adjacency.outgoing).toEqual([]);
  });
});

/* ------------------------- linksOp (ENG-45) ------------------------- */

describe("shared ops / linksOp", () => {
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

  /** Seed an entry with optional related list and creation time, directly
   * into one scope's engrams directory. The filename slug matches the title
   * (the scan's cross-check stays clean), so duplicate-id claim fixtures
   * distinguish themselves through distinct titles. */
  const seedWithRelated = (
    base: string,
    scope: Exclude<Scope, "all">,
    id: string,
    over: Partial<EngramInput> = {},
    created = "2026-08-16T10:00:00.000Z",
  ): void => {
    const i = input({ ...over, title: over.title ?? `Entry ${id}` });
    const file = path.join(base, `${id}-${slugify(i.title)}.md`);
    const fm = [
      `id: "${id}"`,
      `title: ${JSON.stringify(i.title)}`,
      `type: ${i.type}`,
      `tags: [${(i.tags ?? []).map((t) => JSON.stringify(t)).join(", ")}]`,
      `scope: ${scope}`,
      `created: ${created}`,
      `updated: ${created}`,
      `author: ${JSON.stringify(i.author ?? "Tester")}`,
      ...(i.related !== undefined
        ? [`related: [${i.related.map((r) => JSON.stringify(r)).join(", ")}]`]
        : []),
    ].join("\n");
    fs.writeFileSync(file, `---\n${fm}\n---\n${i.body}\n`);
  };

  /** Wrap MainLive's store so every scan call is counted. The proxy keeps
   * MainLive's store for every other method and service. */
  const countingRun = async <A>(
    counter: { scans: number; scopes: Scope[] },
    eff: Effect.Effect<A, never, EngramStore | ConfigRepo | FileSystem | Path>,
  ): Promise<A> => {
    const counting = Layer.effect(
      EngramStore,
      Effect.gen(function* () {
        const base = yield* EngramStore;
        return {
          ...base,
          scan: (scope: Scope) => {
            counter.scans += 1;
            counter.scopes.push(scope);
            return base.scan(scope);
          },
        };
      }),
    );
    return Effect.runPromise(Effect.provide(eff, Layer.provideMerge(counting, MainLive)));
  };

  /** Row ids (2-space-indented row lines) in rendered order. */
  const rowIds = (text: string): string[] =>
    text
      .split("\n")
      .filter((l) =>
        /^  \S+ (note|decision|fact|preference|issue|context) |^  \S+ (MISSING|AMBIGUOUS)/.test(l),
      )
      .map((l) => l.trimStart().split(" ")[0]!);

  it("defaults to project scope inside a project", async () => {
    seed(tmp, "0001", { title: "Lonely root" });
    const res = await run(linksOp({ id: "0001" }));
    expect(res.isError).toBe(false);
    expect(res.details).toMatchObject({ id: "0001", scope: "project", targetStatus: "found" });
  });

  it("defaults to personal scope outside a project", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "engram-empty-"));
    process.chdir(empty);
    try {
      seedPersonal(home, "9001", { title: "Personal only" });
      const res = await run(linksOp({ id: "9001" }));
      expect(res.isError).toBe(false);
      expect(res.details).toMatchObject({ scope: "personal", targetStatus: "found" });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("explicit personal scope wins inside a project", async () => {
    seed(tmp, "0001", { title: "Project entry" });
    seedPersonal(home, "9001", { title: "Personal 9001" });
    const res = await run(linksOp({ id: "9001", scope: "personal" }));
    expect(res.isError).toBe(false);
    expect(res.details).toMatchObject({ scope: "personal", targetStatus: "found" });
    expect(res.text).toContain("Personal 9001");
  });

  it("explicit project scope outside a project returns the degraded read error", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "engram-empty-"));
    process.chdir(empty);
    try {
      const res = await run(linksOp({ id: "0001", scope: "project" }));
      expect(res.isError).toBe(true);
      expect(res.text).toContain("No .engram/ project found");
      expect(res.text).toContain("personal scope");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("scans exactly once and feeds that same StoreScan to computeLinkAdjacency", async () => {
    seedWithRelated(projectEngramsDir(tmp), "project", "0001", { related: ["0002"] });
    seedWithRelated(projectEngramsDir(tmp), "project", "0002");
    const counter = { scans: 0, scopes: [] as Scope[] };
    const res = await countingRun(counter, linksOp({ id: "0001", scope: "project" }));
    expect(res.isError).toBe(false);
    expect(counter.scans).toBe(1);
    expect(counter.scopes).toEqual(["project"]);
    expect(res.details).toMatchObject({ outgoingTotal: 1, incomingTotal: 0 });
  });

  it("does not scan at all when numeric validation fails", async () => {
    seed(tmp, "0001", { title: "Root" });
    const counter = { scans: 0, scopes: [] as Scope[] };
    const res = await countingRun(counter, linksOp({ id: "0001", limit: 101 }));
    expect(res.isError).toBe(true);
    expect(res.text).toContain("limit must be at most 100");
    expect(counter.scans).toBe(0);
  });

  it("treats a strict prefix of an existing id as missing; the exact id resolves", async () => {
    seed(tmp, "0001", { title: "One" });
    seed(tmp, "0012", { title: "Twelve" });
    const prefix = await run(linksOp({ id: "001", scope: "project" }));
    expect(prefix.isError).toBe(false);
    expect(prefix.details).toMatchObject({ targetStatus: "missing" });
    expect(prefix.text).toContain("Links for 001 - MISSING");

    const exact = await run(linksOp({ id: "0012", scope: "project" }));
    expect(exact.details).toMatchObject({ targetStatus: "found" });
  });

  it("missing target with backlinks is a successful graph read", async () => {
    seedWithRelated(projectEngramsDir(tmp), "project", "0002", { related: ["9999"] });
    const res = await run(linksOp({ id: "9999", scope: "project" }));
    expect(res.isError).toBe(false);
    expect(res.details).toMatchObject({
      targetStatus: "missing",
      outgoingTotal: 0,
      incomingTotal: 1,
    });
    expect(res.text).toContain("Links for 9999 - MISSING");
    expect(res.text).toContain("Incoming");
    expect(res.text).toContain("0002 note Entry 0002");
  });

  it("ambiguous requested target is a successful read with claimant context and backlinks", async () => {
    const dir = projectEngramsDir(tmp);
    seedWithRelated(dir, "project", "0005", { title: "Claim A" }, "2026-08-16T10:00:00.000Z");
    seedWithRelated(dir, "project", "0005", { title: "Claim B" }, "2026-08-16T10:00:00.000Z");
    seedWithRelated(dir, "project", "0002", { related: ["0005"] });
    const res = await run(linksOp({ id: "0005", scope: "project" }));
    expect(res.isError).toBe(false);
    expect(res.details).toMatchObject({
      targetStatus: "ambiguous",
      outgoingTotal: 0,
      incomingTotal: 1,
    });
    expect(res.text).toContain("Links for 0005 - AMBIGUOUS (2 claimants)");
    expect(res.text).toContain("/0005-claim-a.md");
    expect(res.text).toContain("/0005-claim-b.md");
    expect(res.text).toContain("Incoming");
    expect(res.text).toContain("0002 note Entry 0002");
  });

  it("renders an ambiguous outgoing row with bounded claimant context", async () => {
    const dir = projectEngramsDir(tmp);
    seedWithRelated(dir, "project", "0001", { related: ["0005"] });
    seedWithRelated(dir, "project", "0005", { title: "Claim A" }, "2026-08-16T10:00:00.000Z");
    seedWithRelated(dir, "project", "0005", { title: "Claim B" }, "2026-08-16T10:00:00.000Z");
    seedWithRelated(dir, "project", "0005", { title: "Claim C" }, "2026-08-16T10:00:00.000Z");
    seedWithRelated(dir, "project", "0005", { title: "Claim D" }, "2026-08-16T10:00:00.000Z");
    const res = await run(linksOp({ id: "0001", scope: "project" }));
    expect(res.isError).toBe(false);
    expect(res.details).toMatchObject({ outgoingTotal: 1, targetStatus: "found" });
    expect(res.text).toContain("0005 AMBIGUOUS (4 claimants)");
    expect(res.text).toContain("+1 more");
    expect(res.text.match(/0005-claim-[abcd]\.md/g)).toHaveLength(3);
  });

  it("never falls back to the other scope", async () => {
    seed(tmp, "0001", { title: "Project entry" });
    seedPersonal(home, "9001", { title: "Personal 9001" });
    const res = await run(linksOp({ id: "9001", scope: "project" }));
    expect(res.isError).toBe(false);
    expect(res.details).toMatchObject({ targetStatus: "missing", scope: "project" });
    expect(res.text).not.toContain("Personal 9001");
  });

  it("details carry exactly the R5 contract fields and stay JSON-serializable", async () => {
    seedWithRelated(projectEngramsDir(tmp), "project", "0001", { related: ["0002"] });
    seedWithRelated(projectEngramsDir(tmp), "project", "0002");
    const res = await run(linksOp({ id: "0001", scope: "project" }));
    expect(res.isError).toBe(false);
    expect(Object.keys(res.details).sort()).toEqual([
      "diagnosticCount",
      "id",
      "incomingTotal",
      "limit",
      "nextOffset",
      "offset",
      "omittedFiles",
      "outgoingTotal",
      "scope",
      "targetStatus",
      "truncated",
    ]);
    expect(res.details).toMatchObject({
      id: "0001",
      scope: "project",
      targetStatus: "found",
      outgoingTotal: 1,
      incomingTotal: 0,
      offset: 0,
      limit: 10,
      nextOffset: null,
      diagnosticCount: 0,
      omittedFiles: 0,
      truncated: false,
    });
    const roundTripped = JSON.parse(JSON.stringify(res.details)) as Record<string, unknown>;
    expect(roundTripped).toEqual(res.details);
  });

  it("captures scan I/O failures as error results", async () => {
    seed(tmp, "0001", { title: "Root" });
    const dir = projectEngramsDir(tmp);
    fs.chmodSync(dir, 0o000);
    try {
      const res = await run(linksOp({ id: "0001", scope: "project" }));
      expect(res.isError).toBe(true);
      expect(typeof res.details.error).toBe("string");
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it("warnings never fail the read: damaged siblings stay omitted, valid adjacency renders", async () => {
    seedWithRelated(projectEngramsDir(tmp), "project", "0001", { related: ["0002"] });
    seedWithRelated(projectEngramsDir(tmp), "project", "0002");
    fs.writeFileSync(path.join(projectEngramsDir(tmp), "broken.md"), "not frontmatter at all");
    const res = await run(linksOp({ id: "0001", scope: "project" }));
    expect(res.isError).toBe(false);
    expect(res.details.diagnosticCount).toBeGreaterThanOrEqual(1);
    expect(res.details.omittedFiles).toBeGreaterThanOrEqual(1);
    expect(res.text).toContain("0002 note Entry 0002");
    expect(res.text).toContain("WARNING: Engram memory is incomplete");
    expect(res.text).toContain("store diagnostic");
    expect(res.text).not.toContain("broken.md");
  });

  it("defaults to the shared search limit of 10 and footers the slash continuation", async () => {
    seedWithRelated(projectEngramsDir(tmp), "project", "0001", {
      related: [
        "0002",
        "0003",
        "0004",
        "0005",
        "0006",
        "0007",
        "0008",
        "0009",
        "0010",
        "0011",
        "0012",
        "0013",
      ],
    });
    for (let i = 2; i <= 13; i++) {
      seedWithRelated(projectEngramsDir(tmp), "project", String(i).padStart(4, "0"), {
        title: `Peer ${String(i).padStart(4, "0")}`,
      });
    }
    const res = await run(linksOp({ id: "0001", scope: "project" }));
    expect(res.isError).toBe(false);
    expect(res.details).toMatchObject({ outgoingTotal: 12, limit: 10, offset: 0, nextOffset: 10 });
    expect(rowIds(res.text)).toHaveLength(10);
    expect(res.text).toContain("/engram links 0001 --scope project --offset 10 for more");
    expect(res.text.length).toBeLessThanOrEqual(8192);
  });

  it("passes explicit scope and limit through to the continuation footer", async () => {
    seedWithRelated(projectEngramsDir(tmp), "project", "0001", {
      related: ["0002", "0003", "0004"],
    });
    for (const i of ["0002", "0003", "0004"]) seed(tmp, i, { title: `Peer ${i}` });
    const res = await run(linksOp({ id: "0001", scope: "project", limit: 2 }));
    expect(res.text).toContain("/engram links 0001 --scope project --offset 2 --limit 2 for more");
  });

  it("rejects negative offsets, zero limits, and limits over the shared maximum", async () => {
    seed(tmp, "0001", { title: "Root" });
    const negative = await run(linksOp({ id: "0001", scope: "project", offset: -1 }));
    expect(negative.isError).toBe(true);
    expect(negative.text).toContain("offset must be a nonnegative safe integer");

    const zero = await run(linksOp({ id: "0001", scope: "project", limit: 0 }));
    expect(zero.isError).toBe(true);
    expect(zero.text).toContain("limit must be a positive safe integer");

    const excessive = await run(linksOp({ id: "0001", scope: "project", limit: 101 }));
    expect(excessive.isError).toBe(true);
    expect(excessive.text).toContain("limit must be at most 100");
  });

  it("renders an explicit offset note at and beyond the total", async () => {
    seedWithRelated(projectEngramsDir(tmp), "project", "0001", { related: ["0002", "0003"] });
    seed(tmp, "0002", { title: "Peer 0002" });
    seed(tmp, "0003", { title: "Peer 0003" });

    const atTotal = await run(linksOp({ id: "0001", scope: "project", offset: 2 }));
    expect(atTotal.isError).toBe(false);
    expect(atTotal.details).toMatchObject({ offset: 2, nextOffset: null });
    expect(atTotal.text).toContain("(offset 2 past the end - 2 rows total)");
    expect(atTotal.text).not.toContain("(none)");

    const beyond = await run(linksOp({ id: "0001", scope: "project", offset: 50 }));
    expect(beyond.text).toContain("(offset 50 past the end - 2 rows total)");
    expect(beyond.isError).toBe(false);
  });

  it("crosses the outgoing/incoming boundary across pages without dupes or omissions", async () => {
    const dir = projectEngramsDir(tmp);
    seedWithRelated(dir, "project", "0001", { related: ["0002", "0003"] });
    seedWithRelated(dir, "project", "0002", { title: "Peer 0002" });
    seedWithRelated(dir, "project", "0003", { title: "Peer 0003" });
    seedWithRelated(dir, "project", "0004", { title: "Backlink 0004", related: ["0001"] });
    seedWithRelated(dir, "project", "0005", { title: "Backlink 0005", related: ["0001"] });
    const page1 = await run(linksOp({ id: "0001", scope: "project", limit: 3 }));
    expect(page1.text).toContain("Outgoing");
    expect(page1.text).toContain("Incoming");
    expect(page1.details).toMatchObject({ nextOffset: 3, outgoingTotal: 2, incomingTotal: 2 });

    const page2 = await run(linksOp({ id: "0001", scope: "project", offset: 3, limit: 3 }));
    expect(page2.text).toContain("Incoming");
    expect(page2.text).not.toContain("Outgoing");
    expect(page2.details).toMatchObject({ nextOffset: null });

    const combined = [...rowIds(page1.text), ...rowIds(page2.text)];
    expect(combined).toEqual(["0002", "0003", "0004", "0005"]);
    expect(new Set(combined).size).toBe(combined.length);
  });

  it("reconstructs the whole stream over multiple pages: authored outgoing then chronological incoming", async () => {
    const dir = projectEngramsDir(tmp);
    const authored = [
      "0005",
      "0002",
      "0013",
      "0004",
      "0006",
      "0007",
      "0008",
      "0009",
      "0010",
      "0011",
      "0012",
      "0003",
    ];
    seedWithRelated(dir, "project", "0001", { related: authored });
    for (const id of authored) seedWithRelated(dir, "project", id, { title: `Peer ${id}` });
    seedWithRelated(
      dir,
      "project",
      "0020",
      { title: "Backlink 0020", related: ["0001"] },
      "2026-08-15T10:00:00.000Z",
    );
    seedWithRelated(
      dir,
      "project",
      "0015",
      { title: "Backlink 0015", related: ["0001"] },
      "2026-08-16T11:00:00.000Z",
    );
    seedWithRelated(
      dir,
      "project",
      "0014",
      { title: "Backlink 0014", related: ["0001"] },
      "2026-08-16T11:00:00.000Z",
    );

    const collected: string[] = [];
    let offset = 0;
    for (let page = 0; page < 5; page++) {
      const res = await run(linksOp({ id: "0001", scope: "project", offset, limit: 10 }));
      expect(res.isError).toBe(false);
      collected.push(...rowIds(res.text));
      expect(res.text.length).toBeLessThanOrEqual(8192);
      const next = res.details.nextOffset as number | null;
      if (next === null) break;
      offset = next;
    }
    expect(collected).toEqual([...authored, "0020", "0014", "0015"]);
  });

  it("caps oversized rows: bounded marker, footer survives, deterministic advance", async () => {
    const dir = projectEngramsDir(tmp);
    seedWithRelated(dir, "project", "0001", { related: ["0002", "0003"] });
    seedWithRelated(dir, "project", "0002", { title: "x".repeat(10_000) });
    seedWithRelated(dir, "project", "0003", { title: "Small peer" });
    const res = await run(linksOp({ id: "0001", scope: "project", limit: 1 }));
    expect(res.isError).toBe(false);
    expect(res.text.length).toBeLessThanOrEqual(8192);
    expect(res.text).toContain("(list truncated to fit the size cap)");
    expect(res.text).toContain("(showing 1-1 of 2");
    expect(res.text).toContain("/engram links 0001 --scope project --offset 1 --limit 1 for more");
    expect(res.details).toMatchObject({ truncated: true, nextOffset: 1 });

    // The next page renders the small row whole: no loop, no re-emission.
    const page2 = await run(linksOp({ id: "0001", scope: "project", offset: 1, limit: 1 }));
    expect(page2.details).toMatchObject({ truncated: false, nextOffset: null });
    expect(page2.text).toContain("0003 note Small peer");
  });

  it("keeps the no-footer truncated page within the hard cap (F1)", async () => {
    const dir = projectEngramsDir(tmp);
    seedWithRelated(dir, "project", "0001", { related: ["0003", "0002"] });
    seedWithRelated(dir, "project", "0003", { title: "Small peer" });
    seedWithRelated(dir, "project", "0002", { title: "x".repeat(10_000) });

    // Page 1: the small leading row fits; the oversized row is deferred.
    const page1 = await run(linksOp({ id: "0001", scope: "project" }));
    expect(page1.isError).toBe(false);
    expect(page1.details).toMatchObject({ nextOffset: 1, truncated: false });
    expect(page1.text).toContain("0003 note Small peer");

    // Page 2 holds the single oversized last row: no continuation exists, so
    // the no-footer truncated branch bounds it at the cap with the marker.
    const page2 = await run(linksOp({ id: "0001", scope: "project", offset: 1 }));
    expect(page2.isError).toBe(false);
    expect(page2.details).toMatchObject({ nextOffset: null, truncated: true });
    expect(page2.text.length).toBeLessThanOrEqual(8192);
    expect(page2.text).toContain("(result truncated)");
    expect(page2.text).not.toContain("call /engram links");
  });

  it("continues at the first hidden row when the cap cuts the page (P1a)", async () => {
    const dir = projectEngramsDir(tmp);
    seedWithRelated(dir, "project", "0001", { related: ["0002", "0003", "0004"] });
    seedWithRelated(dir, "project", "0002", { title: "x".repeat(10_000) });
    seedWithRelated(dir, "project", "0003", { title: "Peer 0003" });
    seedWithRelated(dir, "project", "0004", { title: "Peer 0004" });

    // Greptile's scenario: limit 2 over three links, first peer pathological.
    // The cap cuts the second row, so the continuation must point at the
    // first hidden row (1), never past it (2).
    const page1 = await run(linksOp({ id: "0001", scope: "project", limit: 2 }));
    expect(page1.isError).toBe(false);
    expect(page1.text.length).toBeLessThanOrEqual(8192);
    expect(page1.text).toContain("(list truncated to fit the size cap)");
    expect(page1.text).toContain("(showing 1-1 of 3");
    expect(page1.text).toContain(
      "/engram links 0001 --scope project --offset 1 --limit 2 for more",
    );
    expect(page1.details).toMatchObject({ nextOffset: 1 });

    // Full reconstruction covers every row: page 2 starts at the hidden row.
    const page2 = await run(linksOp({ id: "0001", scope: "project", offset: 1, limit: 2 }));
    expect(page2.isError).toBe(false);
    expect(rowIds(page2.text)).toEqual(["0003", "0004"]);
    expect(page2.details).toMatchObject({ nextOffset: null });
  });
});
