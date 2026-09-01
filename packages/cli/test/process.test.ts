/**
 * Process-level `engram check` behavior: command Effect tests cannot prove
 * process exit codes, so this suite shells out to the CLI entry point via
 * tsx (no dist build needed, so it cannot race the packaging suite's build).
 * Skips when spawning is blocked, like packaging.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
const cliEntry = join(repoRoot, "packages", "cli", "src", "index.ts");
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");

let spawnOk = true;
try {
  execFileSync("pnpm", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch {
  spawnOk = false;
}

interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCli = (args: ReadonlyArray<string>, cwd: string, home: string): CliResult => {
  try {
    const stdout = execFileSync(tsxBin, [cliEntry, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: home },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
};

describe("engram check (process level)", () => {
  let tmp = "";
  let home = "";

  beforeAll(() => {
    if (!spawnOk) return;
    tmp = mkdtempSync(join(tmpdir(), "engram-proc-"));
    home = mkdtempSync(join(tmpdir(), "engram-proc-home-"));
  });
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (home) rmSync(home, { recursive: true, force: true });
  });

  const freshProject = (): string => {
    const proj = join(tmp, "proj");
    mkdirSync(join(proj, ".engram", "engrams"), { recursive: true });
    writeFileSync(
      join(proj, ".engram", "config.json"),
      JSON.stringify({ version: 1, tracked: true, defaultType: "note" }),
    );
    return proj;
  };

  const fm = (id: string, title: string): string =>
    [
      "---",
      `id: "${id}"`,
      `title: ${JSON.stringify(title)}`,
      "type: note",
      "tags: []",
      "scope: project",
      "created: 2025-08-15T10:00:00.000Z",
      "updated: 2025-08-15T11:00:00.000Z",
      "---",
      "Body",
      "",
    ].join("\n");

  it("a clean store exits 0", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    writeFileSync(join(proj, ".engram", "engrams", "0001-fine.md"), fm("0001", "Fine"));
    const r = runCli(["check"], proj, home);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no problems found");
  });

  it("representative integrity defects exit 1", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    writeFileSync(
      join(proj, ".engram", "engrams", "0002-broken.md"),
      "---\ntitle: [unclosed\n---\n",
    );
    const r = runCli(["check"], proj, home);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("[yaml_invalid]");
  });

  it("a json failure exits 1 while stdout remains parseable", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    writeFileSync(
      join(proj, ".engram", "engrams", "0002-broken.md"),
      "---\ntitle: [unclosed\n---\n",
    );
    const r = runCli(["check", "--json"], proj, home);
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout) as { ok: boolean; diagnostics: ReadonlyArray<unknown> };
    expect(doc.ok).toBe(false);
    expect(doc.diagnostics.length).toBeGreaterThan(0);
    // the concise failure summary belongs on stderr, keeping stdout pure JSON
    expect(r.stderr).toContain("1 problem found");
  });

  it("an operational failure exits 1", (ctx) => {
    if (!spawnOk) ctx.skip();
    const bare = join(tmp, "bare");
    mkdirSync(bare, { recursive: true });
    const r = runCli(["check", "--scope", "project"], bare, home);
    expect(r.status).toBe(1);
    // human report on stdout carries the exact reason and init guidance...
    expect(r.stdout).toContain("project: could not be checked");
    expect(r.stdout).toContain("engram init");
    // ...and the concise summary goes to stderr
    expect(r.stderr).toContain("project scope could not be checked");
  });

  it("an explicit uncheckable project scope exits 1 with parseable json stdout", (ctx) => {
    if (!spawnOk) ctx.skip();
    const bare = join(tmp, "bare-json");
    mkdirSync(bare, { recursive: true });
    const r = runCli(["check", "--scope", "project", "--json"], bare, home);
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout) as {
      ok: boolean;
      scopes: string[];
      uncheckableScopes: Array<{ scope: string; message: string; hint: string }>;
    };
    expect(doc.ok).toBe(false);
    expect(doc.scopes).toEqual([]);
    expect(doc.uncheckableScopes).toHaveLength(1);
    expect(doc.uncheckableScopes[0].scope).toBe("project");
    expect(doc.uncheckableScopes[0].hint).toContain("engram init");
  });

  it("all outside a project exits 1 with the unchecked scope structured in json", (ctx) => {
    if (!spawnOk) ctx.skip();
    const bare = join(tmp, "bare-all-json");
    mkdirSync(bare, { recursive: true });
    const r = runCli(["check", "--scope", "all", "--json"], bare, home);
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout) as {
      ok: boolean;
      scopes: string[];
      uncheckableScopes: Array<{ scope: string }>;
    };
    expect(doc.ok).toBe(false);
    expect(doc.scopes).toEqual(["personal"]);
    expect(doc.uncheckableScopes.map((u) => u.scope)).toEqual(["project"]);
  });

  it("an unlistable store directory exits 1 with parseable json stdout", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    const dir = join(proj, ".engram", "engrams");
    chmodSync(dir, 0o000);
    try {
      // chmod is unreliable under elevated permissions: probe and skip if it
      // had no effect instead of failing the suite
      try {
        readdirSync(dir);
        chmodSync(dir, 0o755);
        ctx.skip();
        return;
      } catch {
        // blocked as intended
      }
      const r = runCli(["check", "--scope", "project", "--json"], proj, home);
      expect(r.status).toBe(1);
      const doc = JSON.parse(r.stdout) as {
        ok: boolean;
        uncheckableScopes: Array<{ scope: string; message: string }>;
      };
      expect(doc.ok).toBe(false);
      expect(doc.uncheckableScopes).toHaveLength(1);
      expect(doc.uncheckableScopes[0].scope).toBe("project");
      expect(doc.uncheckableScopes[0].message).toContain(dir);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});
