/**
 * `engram review` command tests (ENG-17 WU-2): the versioned report contract
 * (stable reason codes, one finding per entry, deterministic order), clock
 * boundaries via the `now` seam, scope resolution and operation errors, and
 * the rule that candidate-level scan defects stay report data with exit 0
 * while discovery failures are non-zero. Runs the real command Effect over
 * MainLive (or a wrapped-FS layer) with stdout captured; nothing shells out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import { Effect, Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import { FileSystem } from "effect/FileSystem";
import { systemError } from "effect/PlatformError";
import fs from "node:fs";
import path from "node:path";
import {
  EngramStore,
  EngramStoreLive,
  MainLive,
  projectConfigPath,
  projectEngramsDir,
  slugify,
  stringifyFrontmatter,
} from "@engram/core";
import { reviewCommand } from "../src/commands/review.js";

/* ------------------------------ helpers ------------------------------ */

const NOW = Date.parse("2026-06-15T12:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

const mkProject = (): string => {
  const tmp = fs.mkdtempSync(path.join("/var/tmp", "engram-cli-review-"));
  fs.mkdirSync(projectEngramsDir(tmp), { recursive: true });
  fs.writeFileSync(
    projectConfigPath(tmp),
    JSON.stringify({ version: 1, tracked: true, defaultType: "note" }),
  );
  return tmp;
};

const mkPlain = (): string => fs.mkdtempSync(path.join("/var/tmp", "engram-cli-review-plain-"));

const mkHome = (): string => {
  const tmp = fs.mkdtempSync(path.join("/var/tmp", "engram-cli-review-home-"));
  fs.mkdirSync(path.join(tmp, ".engram", "engrams"), { recursive: true });
  return tmp;
};

const seed = (
  proj: string,
  id: string,
  over: Record<string, unknown> & { title?: string },
): string => {
  const title = (over.title as string) ?? `Entry ${id}`;
  const data: Record<string, unknown> = {
    id,
    title,
    type: "note",
    tags: [],
    scope: "project",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    ...over,
  };
  const file = path.join(projectEngramsDir(proj), `${id}-${slugify(title)}.md`);
  fs.writeFileSync(file, stringifyFrontmatter("Body\n", data));
  return file;
};

const seedPersonal = (
  home: string,
  id: string,
  title: string,
  over: Record<string, unknown> = {},
): string => {
  const file = path.join(home, ".engram", "engrams", `${id}-personal.md`);
  fs.writeFileSync(
    file,
    stringifyFrontmatter("Personal body\n", {
      id,
      title,
      type: "note",
      tags: [],
      scope: "personal",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      ...over,
    }),
  );
  return file;
};

/** A MainLive-shaped layer whose `readFileString` fails for matching paths
 * (simulates EACCES without chmod), for unreadable-candidate review tests. */
const blockedReadLive = (blocked: (p: string) => boolean) =>
  EngramStoreLive.pipe(
    Layer.provide(
      Layer.effect(
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
      ).pipe(Layer.provide(NodeServices.layer)),
    ),
    Layer.provide(NodeServices.layer),
  );

/** Like `blockedReadLive` but fails `readDirectory`: the store directory
 * cannot be listed, which is a discovery failure (non-zero exit per R11). */
const blockedDirLive = (blocked: (p: string) => boolean) =>
  EngramStoreLive.pipe(
    Layer.provide(
      Layer.effect(
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
      ).pipe(Layer.provide(NodeServices.layer)),
    ),
    Layer.provide(NodeServices.layer),
  );

describe("engram review", () => {
  let origCwd = "";
  let origHome: string | undefined;
  let tmp = "";
  let home = "";
  let outLines: string[] = [];
  let spies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    origCwd = process.cwd();
    origHome = process.env.HOME;
    tmp = mkProject();
    home = mkHome();
    process.chdir(tmp);
    process.env.HOME = home;
    outLines = [];
    spies = [
      vi.spyOn(console, "log").mockImplementation(((...args: unknown[]) => {
        outLines.push(args.map(String).join(" "));
        return undefined;
      }) as typeof console.log),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
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
  const run = (
    eff: Effect.Effect<unknown, unknown, EngramStore>,
    layer?: Layer.Layer<EngramStore, never, never>,
  ): Promise<unknown> =>
    Effect.runPromise(Effect.provide(eff as never, layer ?? MainLive)) as Promise<unknown>;
  const runOk = async (
    eff: Effect.Effect<unknown, unknown, EngramStore>,
    layer?: Layer.Layer<EngramStore, never, never>,
  ): Promise<void> => {
    await run(eff, layer);
  };
  const runFail = async (
    eff: Effect.Effect<unknown, unknown, EngramStore>,
    layer?: Layer.Layer<EngramStore, never, never>,
  ): Promise<{ _tag: string; message?: string }> =>
    Effect.runPromise(Effect.provide(Effect.flip(eff) as never, layer ?? MainLive)) as Promise<{
      _tag: string;
      message?: string;
    }>;
  const json = (): ReturnType<typeof JSON.parse> => JSON.parse(output());

  /* --------------------- report contract (R10) --------------------- */

  it("pins the documented JSON report shape on a clean store", async () => {
    seed(tmp, "0001", { title: "Healthy note" });
    await runOk(reviewCommand({ json: true, now: NOW }));
    const report = json();
    expect(report).toMatchObject({
      report: "review",
      version: 1,
      ok: true,
      scopes: [{ scope: "project", entries: 1, findings: 0, diagnostics: 0 }],
      findings: [],
      diagnostics: [],
    });
  });

  it("surfaces all five lifecycle classes in both output modes with exit 0", async () => {
    seed(tmp, "0001", { title: "Dangling claim", supersedes: "9999" });
    seed(tmp, "0002", { title: "Superseded note", status: "superseded" });
    seed(tmp, "0003", { title: "Archived note", status: "archived" });
    seed(tmp, "0004", { title: "Expired note", expires: iso(NOW - 1) });
    seed(tmp, "0005", { title: "Due note", reviewAfter: iso(NOW - 1) });
    seed(tmp, "0006", { title: "Healthy note" });

    // human mode: every class appears, exit path succeeds (no throw)
    await runOk(reviewCommand({ now: NOW }));
    const human = output();
    for (const title of [
      "Dangling claim",
      "Superseded note",
      "Archived note",
      "Expired note",
      "Due note",
    ]) {
      expect(human).toContain(title);
    }
    expect(human).not.toContain("Healthy note");
    expect(human).not.toContain("(nothing to review");

    // JSON mode: parseable, one finding per affected entry, ok false
    outLines = [];
    await runOk(reviewCommand({ json: true, now: NOW }));
    const report = json();
    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(5);
    const byId = new Map<string, { reasons: string[] }>(
      report.findings.map((f: { id: string; reasons: string[] }) => [f.id, f]),
    );
    expect(byId.get("0001")!.reasons).toEqual(["broken_supersedes"]);
    expect(byId.get("0002")!.reasons).toEqual(["superseded"]);
    expect(byId.get("0003")!.reasons).toEqual(["archived"]);
    expect(byId.get("0004")!.reasons).toEqual(["expired"]);
    expect(byId.get("0005")!.reasons).toEqual(["review_due"]);
    for (const f of report.findings) {
      expect(f).toMatchObject({
        scope: "project",
        file: expect.any(String),
        title: expect.any(String),
      });
    }
  });

  it("emits ONE finding per entry with reasons in the canonical order", async () => {
    seed(tmp, "0001", {
      title: "Everything at once",
      status: "archived",
      expires: iso(NOW - 1),
      reviewAfter: iso(NOW - 1),
      supersedes: "9999",
    });
    await runOk(reviewCommand({ json: true, now: NOW }));
    const report = json();
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].reasons).toEqual([
      "archived",
      "expired",
      "review_due",
      "broken_supersedes",
    ]);
  });

  it("does not label valid, expired, or inactive supersedes targets as broken", async () => {
    seed(tmp, "0001", { title: "Valid target" });
    seed(tmp, "0002", { title: "Points at valid", supersedes: "0001" });
    seed(tmp, "0003", { title: "Expired target", expires: iso(NOW - 1) });
    seed(tmp, "0004", { title: "Points at expired", supersedes: "0003" });
    seed(tmp, "0005", { title: "Inactive target", status: "superseded" });
    seed(tmp, "0006", { title: "Points at inactive", supersedes: "0005" });
    await runOk(reviewCommand({ json: true, now: NOW }));
    const report = json();
    const byId = new Map<string, { reasons: string[] }>(
      report.findings.map((f: { id: string; reasons: string[] }) => [f.id, f]),
    );
    for (const id of ["0002", "0004", "0006"]) {
      expect(byId.get(id)?.reasons ?? []).not.toContain("broken_supersedes");
    }
    // the targets themselves are still reviewed on their own merits
    expect(byId.get("0003")!.reasons).toEqual(["expired"]);
    expect(byId.get("0005")!.reasons).toEqual(["superseded"]);
    expect(byId.has("0001")).toBe(false);
  });

  it("findings sort deterministically by scope order then id", async () => {
    seed(tmp, "0004", { title: "Late", status: "superseded" });
    seed(tmp, "0002", { title: "Early", status: "superseded" });
    seedPersonal(home, "0007", "Personal stale", { status: "archived" });
    await runOk(reviewCommand({ json: true, scope: "all", now: NOW }));
    const report = json();
    expect(report.findings.map((f: { id: string }) => f.id)).toEqual(["0002", "0004", "0007"]);
    expect(report.scopes.map((s: { scope: string }) => s.scope)).toEqual(["project", "personal"]);
  });

  /* --------------------- clock boundaries (R12) --------------------- */

  it("uses <= now inclusively for both timestamps (now-1, ==, +1)", async () => {
    const cases: Array<[string, string]> = [
      ["0030", "Before"],
      ["0031", "Equal"],
      ["0032", "After"],
    ];
    let n = 0;
    for (const delta of [NOW - 1, NOW, NOW + 1]) {
      n += 1;
      seed(tmp, `004${n}`, { title: `Expires ${cases[n - 1][1]}`, expires: iso(delta) });
      seed(tmp, `005${n}`, {
        title: `Review ${cases[n - 1][1]}`,
        reviewAfter: iso(delta),
      });
    }
    await runOk(reviewCommand({ json: true, now: NOW }));
    const report = json();
    const byId = new Map<string, { reasons: string[] }>(
      report.findings.map((f: { id: string; reasons: string[] }) => [f.id, f]),
    );
    expect(byId.get("0041")!.reasons).toEqual(["expired"]);
    expect(byId.get("0042")!.reasons).toEqual(["expired"]);
    expect(byId.has("0043")).toBe(false);
    expect(byId.get("0051")!.reasons).toEqual(["review_due"]);
    expect(byId.get("0052")!.reasons).toEqual(["review_due"]);
    expect(byId.has("0053")).toBe(false);
  });

  it("captures one now for the whole invocation (single-seam determinism)", async () => {
    // Both timestamps sit exactly at the seam instant: both must fire under
    // the same captured now (a per-scope Date.now() could straddle it).
    seed(tmp, "0001", { title: "Both at the line", expires: iso(NOW), reviewAfter: iso(NOW) });
    await runOk(reviewCommand({ json: true, now: NOW }));
    const report = json();
    expect(report.findings[0].reasons).toEqual(["expired", "review_due"]);
  });

  /* --------------------- empty report (R10) --------------------- */

  it("empty store: defined shape and a clear human line, exit 0 in both modes", async () => {
    await runOk(reviewCommand({}));
    expect(output()).toContain("(nothing to review");
    outLines = [];
    await runOk(reviewCommand({ json: true }));
    const report = json();
    expect(report).toMatchObject({
      report: "review",
      version: 1,
      ok: true,
      findings: [],
      diagnostics: [],
    });
  });

  /* --------------------- scan defects vs errors (R11) --------------------- */

  it("a malformed candidate is report data in both modes with exit 0", async () => {
    seed(tmp, "0001", { title: "Healthy note" });
    fs.writeFileSync(
      path.join(projectEngramsDir(tmp), "0009-broken.md"),
      "---\ntitle: [unclosed\n---\nBody\n",
    );
    await runOk(reviewCommand({ now: NOW }));
    expect(output()).toContain("0009-broken.md");
    outLines = [];
    await runOk(reviewCommand({ json: true, now: NOW }));
    const report = json();
    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics[0].file).toContain("0009-broken.md");
    expect(report.ok).toBe(false);
  });

  it("an unreadable candidate is report data with exit 0", async () => {
    const file = seed(tmp, "0001", { title: "Locked note" });
    await runOk(
      reviewCommand({ json: true, now: NOW }),
      blockedReadLive((p) => p === file),
    );
    const report = json();
    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics[0].code).toBe("file_unreadable");
    expect(report.ok).toBe(false);
  });

  it("an unlistable store directory is an operation error (non-zero)", async () => {
    const e = await runFail(
      reviewCommand({}),
      blockedDirLive(() => true),
    );
    expect(e._tag).toBe("PlatformError");
  });

  it("an uninitialized explicit project scope is an operation error (non-zero)", async () => {
    process.chdir(origCwd);
    const plain = mkPlain();
    process.chdir(plain);
    try {
      const e = await runFail(reviewCommand({ scope: "project" }));
      expect(e._tag).toBe("ProjectNotInitializedError");
    } finally {
      process.chdir(origCwd);
      fs.rmSync(plain, { recursive: true, force: true });
      process.chdir(tmp);
    }
  });

  /* --------------------- scope resolution --------------------- */

  it("scope=all outside a project degrades to personal (documented)", async () => {
    process.chdir(origCwd);
    const plain = mkPlain();
    process.chdir(plain);
    try {
      const file = seedPersonal(home, "0001", "Personal only");
      void file;
      await runOk(
        reviewCommand({ json: true, scope: "all", now: NOW }),
        blockedDirLive(() => false),
      );
      const report = json();
      expect(report.scopes.map((s: { scope: string }) => s.scope)).toEqual(["personal"]);
      expect(report.findings).toHaveLength(0);
    } finally {
      process.chdir(origCwd);
      fs.rmSync(plain, { recursive: true, force: true });
      process.chdir(tmp);
    }
  });

  it("an invalid scope arg is a ValidationError, not a silent default", async () => {
    const e = await runFail(reviewCommand({ scope: "bogus" }));
    expect(e._tag).toBe("ValidationError");
    expect(e.message).toContain("bogus");
  });

  it("human output renders findings sorted with a scope summary", async () => {
    seed(tmp, "0002", { title: "Superseded note", status: "superseded" });
    seed(tmp, "0001", { title: "Expired note", expires: iso(NOW - 1) });
    await runOk(reviewCommand({ now: NOW }));
    const lines = output().split("\n");
    const idxSummary = lines.findIndex((l) => l.includes("project: 2 entries, 2 finding"));
    const idx0001 = lines.findIndex((l) => l.includes("0001"));
    const idx0002 = lines.findIndex((l) => l.includes("0002"));
    expect(idxSummary).toBeGreaterThan(-1);
    expect(idx0001).toBeGreaterThan(idxSummary);
    expect(idx0002).toBeGreaterThan(idx0001);
    expect(output()).toContain("superseded");
    expect(output()).toContain("expired");
  });
});
