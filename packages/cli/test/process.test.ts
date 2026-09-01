/**
 * Process-level `engram check` behavior: command Effect tests cannot prove
 * process exit codes, so this suite shells out to the CLI entry point via
 * tsx (no dist build needed, so it cannot race the packaging suite's build).
 * Skips when spawning is blocked, like packaging.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
    expect(r.stderr).toContain("engram init");
  });
});
