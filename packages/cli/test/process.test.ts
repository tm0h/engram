/**
 * Process-level `engram check` behavior: command Effect tests cannot prove
 * process exit codes, so this suite shells out to the CLI entry point via
 * tsx (no dist build needed, so it cannot race the packaging suite's build).
 * Skips when spawning is blocked, like packaging.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

  const freshProject = (name = "proj"): string => {
    const proj = join(tmp, name);
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

  it("search dispatches JSON/explain flags and validates complete numeric arguments", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject("search-proj");
    writeFileSync(join(proj, ".engram", "engrams", "0001-auth.md"), fm("0001", "Auth"));
    const result = runCli(
      ["search", "auth", "--json", "--explain", "--limit", "1", "--offset", "0"],
      proj,
      home,
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      schemaVersion: number;
      query: string;
      results: Array<{ id: string; score: number }>;
    };
    expect(parsed).toMatchObject({ schemaVersion: 1, query: "auth", results: [{ id: "0001" }] });
    // ENG-18 BM25 title points: 3 x ln(4/3) x tfNorm(len 1, avgdl 1)
    expect(parsed.results[0]?.score).toBeCloseTo(0.3922937351615193, 5);
    for (const arg of ["1x", "1.5", "-1", "Infinity", "9007199254740992"]) {
      const invalid = runCli(["search", "auth", "--json", "--limit", arg], proj, home);
      expect(invalid.status).not.toBe(0);
      expect(invalid.stdout).toBe("");
    }
    const invalidOffset = runCli(["search", "auth", "--json", "--offset", "1.5"], proj, home);
    expect(invalidOffset.status).not.toBe(0);
    expect(invalidOffset.stdout).toBe("");
  });

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

  it("a project discovery failure exits 1 with parseable json stdout", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    const engramDir = join(proj, ".engram");
    chmodSync(engramDir, 0o000);
    try {
      // stat through the blocked directory is the discovery probe: skip when
      // elevated permissions made the chmod ineffective
      try {
        readdirSync(engramDir);
        chmodSync(engramDir, 0o755);
        ctx.skip();
        return;
      } catch {
        // blocked as intended: discovery's exists() will fail with EACCES
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
      expect(doc.uncheckableScopes[0].message).toContain("could not locate the project root");
    } finally {
      chmodSync(engramDir, 0o755);
    }
  });
});

/* ---------------- ENG-13 lifecycle flag wiring (process level) ---------------- */

describe("engram add/edit lifecycle flags (process level)", () => {
  let tmp = "";
  let home = "";

  beforeAll(() => {
    if (!spawnOk) return;
    tmp = mkdtempSync(join(tmpdir(), "engram-proc-life-"));
    home = mkdtempSync(join(tmpdir(), "engram-proc-life-home-"));
  });
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (home) rmSync(home, { recursive: true, force: true });
  });

  let projSeq = 0;
  const freshProject = (): string => {
    projSeq += 1;
    const proj = join(tmp, `proj-${projSeq}`);
    mkdirSync(join(proj, ".engram", "engrams"), { recursive: true });
    writeFileSync(
      join(proj, ".engram", "config.json"),
      JSON.stringify({ version: 1, tracked: true, defaultType: "note" }),
    );
    return proj;
  };
  const entryFile = (proj: string, needle?: string): string => {
    const dir = join(proj, ".engram", "engrams");
    const name = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .find((f) => {
        if (needle === undefined) return true;
        return readFileSync(join(dir, f), "utf8").includes(needle);
      });
    if (name === undefined) throw new Error("no entry file written");
    return join(dir, name);
  };

  it("add maps every kebab-case lifecycle flag to its camelCase option", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    // a legacy entry to supersede
    writeFileSync(
      join(proj, ".engram", "engrams", "0001-legacy.md"),
      '---\nid: "0001"\ntitle: Legacy\ntype: note\ntags: []\nscope: project\ncreated: 2025-08-15T10:00:00.000Z\nupdated: 2025-08-15T11:00:00.000Z\n---\nB\n',
    );
    const r = runCli(
      [
        "add",
        "--title",
        "Flag mapping",
        "--status",
        "active",
        "--supersedes",
        "0001",
        "--review-after",
        "2026-06-01T00:00:00.000Z",
        "--expires",
        "2027-01-01T00:00:00.000Z",
        "--source-type",
        "file",
        "--source-ref",
        "docs/spec.md",
        "body",
      ],
      proj,
      home,
    );
    expect(r.status).toBe(0);
    const raw = readFileSync(entryFile(proj, "Flag mapping"), "utf8");
    expect(raw).toMatch(/^status: active$/m);
    expect(raw).toMatch(/^supersedes: "0001"$/m);
    expect(raw).toMatch(/^reviewAfter: 2026-06-01T00:00:00\.000Z$/m);
    expect(raw).toMatch(/^expires: 2027-01-01T00:00:00\.000Z$/m);
    expect(raw).toMatch(/^sourceType: file$/m);
    expect(raw).toMatch(/^sourceRef: docs\/spec\.md$/m);
  });

  it("edit maps value and clear lifecycle flags to their camelCase options", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    writeFileSync(
      join(proj, ".engram", "engrams", "0001-edit-me.md"),
      '---\nid: "0001"\ntitle: Edit me\ntype: note\ntags: []\nscope: project\ncreated: 2025-08-15T10:00:00.000Z\nupdated: 2025-08-15T11:00:00.000Z\n---\nB\n',
    );
    // ENG-17 R5: the supersedes target must exist and be active
    writeFileSync(
      join(proj, ".engram", "engrams", "0002-target.md"),
      '---\nid: "0002"\ntitle: Target\ntype: note\ntags: []\nscope: project\ncreated: 2025-08-15T10:00:00.000Z\nupdated: 2025-08-15T11:00:00.000Z\n---\nB\n',
    );
    // set all six via kebab-case flags
    const set = runCli(
      [
        "edit",
        "0001",
        "--status",
        "archived",
        "--supersedes",
        "0002",
        "--review-after",
        "2026-06-01T00:00:00.000Z",
        "--expires",
        "2027-01-01T00:00:00.000Z",
        "--source-type",
        "command",
        "--source-ref",
        "grep -r foo",
        "body",
      ],
      proj,
      home,
    );
    expect(set.status).toBe(0);
    let raw = readFileSync(entryFile(proj, "Edit me"), "utf8");
    expect(raw).toMatch(/^status: archived$/m);
    expect(raw).toMatch(/^supersedes: "0002"$/m);
    expect(raw).toMatch(/^reviewAfter: 2026-06-01T00:00:00\.000Z$/m);
    expect(raw).toMatch(/^expires: 2027-01-01T00:00:00\.000Z$/m);
    expect(raw).toMatch(/^sourceType: command$/m);
    expect(raw).toMatch(/^sourceRef: grep -r foo$/m);

    // clear all six via the paired kebab-case flags
    const clear = runCli(
      [
        "edit",
        "0001",
        "--clear-status",
        "--clear-supersedes",
        "--clear-review-after",
        "--clear-expires",
        "--clear-source-type",
        "--clear-source-ref",
        "body",
      ],
      proj,
      home,
    );
    expect(clear.status).toBe(0);
    raw = readFileSync(entryFile(proj, "Edit me"), "utf8");
    for (const key of [
      "status",
      "supersedes",
      "reviewAfter",
      "expires",
      "sourceType",
      "sourceRef",
    ]) {
      expect(raw).not.toMatch(new RegExp(`^${key}:`, "m"));
    }
  });

  it("a value plus clear pair on the same field exits nonzero without mutation", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    writeFileSync(
      join(proj, ".engram", "engrams", "0001-conflict.md"),
      '---\nid: "0001"\ntitle: Conflict\ntype: note\ntags: []\nscope: project\ncreated: 2025-08-15T10:00:00.000Z\nupdated: 2025-08-15T11:00:00.000Z\n---\nB\n',
    );
    const file = entryFile(proj);
    const before = readFileSync(file, "utf8");
    const r = runCli(["edit", "0001", "--status", "active", "--clear-status", "body"], proj, home);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--clear-status");
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

describe("engram add/edit secret scan (process level, ENG-15)", () => {
  let tmp = "";
  let home = "";

  beforeAll(() => {
    if (!spawnOk) return;
    tmp = mkdtempSync(join(tmpdir(), "engram-proc-scan-"));
    home = mkdtempSync(join(tmpdir(), "engram-proc-scan-home-"));
  });
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (home) rmSync(home, { recursive: true, force: true });
  });

  let projSeq = 0;
  const freshProject = (): string => {
    projSeq += 1;
    const proj = join(tmp, `proj-${projSeq}`);
    mkdirSync(join(proj, ".engram", "engrams"), { recursive: true });
    writeFileSync(
      join(proj, ".engram", "config.json"),
      JSON.stringify({ version: 1, tracked: true, defaultType: "note" }),
    );
    return proj;
  };

  const SECRET = "S3cr3t-V4lue!";
  const SECRET_BODY = `rotated the db password: "${SECRET}" after the incident`;

  it("add with a secret exits 1 under the project default, writes nothing, and leaks nothing to stdout", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    const r = runCli(["add", "--title", "Leaky", SECRET_BODY], proj, home);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("secret scanner");
    expect(r.stderr).toContain("SEC-CRED-ASSIGNMENT");
    expect(r.stderr).not.toContain(SECRET);
    expect(readdirSync(join(proj, ".engram", "engrams"))).toEqual([]);
  });

  it("add --allow-secrets exits 0, writes the entry, and prints the bypass notice on stdout", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    const r = runCli(["add", "--title", "Leaky", SECRET_BODY, "--allow-secrets"], proj, home);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("bypassed");
    expect(r.stdout).toContain("SEC-CRED-ASSIGNMENT");
    expect(r.stdout).not.toContain(SECRET);
    expect(r.stderr).toBe("");
    expect(readdirSync(join(proj, ".engram", "engrams"))).toHaveLength(1);
  });

  it("personal add warns by default and exits 0", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    const r = runCli(["add", "--title", "Leaky", SECRET_BODY, "--scope", "personal"], proj, home);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Secret scan warning");
    expect(r.stdout).not.toContain(SECRET);
  });

  it("config set secretScan off re-enables plain writes", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    const off = runCli(["config", "set", "secretScan", "off"], proj, home);
    expect(off.status).toBe(0);
    const r = runCli(["add", "--title", "Leaky", SECRET_BODY], proj, home);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("Secret scan warning");
  });

  it("edit with a secret exits 1 without mutating the entry", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    writeFileSync(
      join(proj, ".engram", "engrams", "0001-clean.md"),
      '---\nid: "0001"\ntitle: Clean\ntype: note\ntags: []\nscope: project\ncreated: 2025-08-15T10:00:00.000Z\nupdated: 2025-08-15T11:00:00.000Z\n---\nB\n',
    );
    const file = join(proj, ".engram", "engrams", "0001-clean.md");
    const before = readFileSync(file, "utf8");
    const r = runCli(["edit", "0001", SECRET_BODY], proj, home);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("secret scanner");
    expect(r.stderr).not.toContain(SECRET);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

describe("engram add/edit related flags (process level, ENG-42)", () => {
  let tmp = "";
  let home = "";

  beforeAll(() => {
    if (!spawnOk) return;
    tmp = mkdtempSync(join(tmpdir(), "engram-proc-related-"));
    home = mkdtempSync(join(tmpdir(), "engram-proc-related-home-"));
  });
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (home) rmSync(home, { recursive: true, force: true });
  });

  let projSeq = 0;
  const freshProject = (): string => {
    projSeq += 1;
    const proj = join(tmp, `proj-${projSeq}`);
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
  const entryRaw = (proj: string, needle: string): string => {
    const dir = join(proj, ".engram", "engrams");
    const name = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .find((f) => readFileSync(join(dir, f), "utf8").includes(needle));
    if (name === undefined) throw new Error(`no entry matching ${needle}`);
    return readFileSync(join(dir, name), "utf8");
  };

  it("add --related writes the exact ordered array and trims members", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    const r = runCli(["add", "--title", "Linked", "--related", "0003, 0002", "body"], proj, home);
    expect(r.status).toBe(0);
    expect(entryRaw(proj, "Linked")).toMatch(/^related:\n  - "0003"\n  - "0002"$/m);
  });

  it("add --related with a value that trims to nothing records no key (Q1)", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    const r = runCli(["add", "--title", "Empty", "--related", "   ", "body"], proj, home);
    expect(r.status).toBe(0);
    expect(entryRaw(proj, "Empty")).not.toMatch(/^related:/m);
  });

  it("add --related with empty tokens is a usage error, not a write (Q2)", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    const r = runCli(["add", "--title", "Bad", "--related", "0001,,0002", "body"], proj, home);
    expect(r.status).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toContain("--related");
    expect(readdirSync(join(proj, ".engram", "engrams"))).toHaveLength(0);
  });

  it("edit --related replaces, omission preserves, and --clear-related omits the key", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    writeFileSync(join(proj, ".engram", "engrams", "0001-linked.md"), fm("0001", "Linked"));
    writeFileSync(join(proj, ".engram", "engrams", "0002-target.md"), fm("0002", "Target"));
    writeFileSync(join(proj, ".engram", "engrams", "0003-other.md"), fm("0003", "Other"));

    const set = runCli(["edit", "0001", "--related", "0002"], proj, home);
    expect(set.status).toBe(0);
    expect(entryRaw(proj, "Linked")).toMatch(/^related:\n  - "0002"$/m);

    const preserve = runCli(["edit", "0001", "--title", "Linked"], proj, home);
    expect(preserve.status).toBe(0);
    expect(entryRaw(proj, "Linked")).toMatch(/^related:\n  - "0002"$/m);

    const replace = runCli(["edit", "0001", "--related", "0003"], proj, home);
    expect(replace.status).toBe(0);
    expect(entryRaw(proj, "Linked")).toMatch(/^related:\n  - "0003"$/m);
    expect(entryRaw(proj, "Linked")).not.toMatch(/- "0002"/);

    const clear = runCli(["edit", "0001", "--clear-related"], proj, home);
    expect(clear.status).toBe(0);
    expect(entryRaw(proj, "Linked")).not.toMatch(/^related:/m);
  });

  it("edit --related rejects a bare prefix and a self-link without mutation", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    writeFileSync(join(proj, ".engram", "engrams", "0001-linked.md"), fm("0001", "Linked"));
    const before = entryRaw(proj, "Linked");

    const prefix = runCli(["edit", "0001", "--related", "00"], proj, home);
    expect(prefix.status).not.toBe(0);
    expect(entryRaw(proj, "Linked")).toBe(before);

    const self = runCli(["edit", "0001", "--related", "0001"], proj, home);
    expect(self.status).not.toBe(0);
    expect(entryRaw(proj, "Linked")).toBe(before);
  });

  it("the --related + --clear-related conflict is a usage error on a nonexistent id", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    const r = runCli(["edit", "9999", "--related", "0001", "--clear-related"], proj, home);
    expect(r.status).not.toBe(0);
    const text = `${r.stderr}${r.stdout}`;
    expect(text).toContain("--clear-related");
    // usage ordering: the flag conflict fires before the entry lookup
    expect(text).not.toMatch(/not found/i);
  });

  it("a dangling relation is a warning-only check: --json exits 0 with related_not_found", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    writeFileSync(join(proj, ".engram", "engrams", "0001-linked.md"), fm("0001", "Linked"));
    const set = runCli(["edit", "0001", "--related", "0099"], proj, home);
    expect(set.status).toBe(0);

    const check = runCli(["check", "--json"], proj, home);
    expect(check.status).toBe(0);
    const report = JSON.parse(check.stdout) as {
      ok: boolean;
      diagnostics: Array<{ code: string; severity: string }>;
    };
    expect(report.ok).toBe(true);
    const related = report.diagnostics.find((d) => d.code === "related_not_found");
    expect(related).toBeDefined();
    expect(related?.severity).toBe("warning");
  });
});

describe("engram check relation exit codes (process level, ENG-44)", () => {
  let tmp = "";
  let home = "";

  beforeAll(() => {
    if (!spawnOk) return;
    tmp = mkdtempSync(join(tmpdir(), "engram-proc-eng44-"));
    home = mkdtempSync(join(tmpdir(), "engram-proc-eng44-home-"));
  });
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (home) rmSync(home, { recursive: true, force: true });
  });

  let projSeq = 0;
  const freshProject = (): string => {
    projSeq += 1;
    const proj = join(tmp, "proj-" + String(projSeq));
    mkdirSync(join(proj, ".engram", "engrams"), { recursive: true });
    writeFileSync(
      join(proj, ".engram", "config.json"),
      JSON.stringify({ version: 1, tracked: true, defaultType: "note" }),
    );
    return proj;
  };
  /* Hand-edited raw frontmatter: ENG-42 rejects invalid relation writes at
   * the boundary, so these files are seeded directly (appendix step 7). */
  const seedRaw = (proj: string, name: string, lines: ReadonlyArray<string>): string => {
    const file = join(proj, ".engram", "engrams", name);
    writeFileSync(file, lines.join("\n"));
    return file;
  };
  const header = (id: string, title: string): ReadonlyArray<string> => [
    "---",
    'id: "' + id + '"',
    "title: " + JSON.stringify(title),
    "type: note",
    "tags: []",
    "scope: project",
    "created: 2025-08-15T10:00:00.000Z",
    "updated: 2025-08-15T11:00:00.000Z",
  ];

  it("a malformed related list fails check with exit 1 in human and JSON modes", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    seedRaw(proj, "0001-linked.md", [
      ...header("0001", "Linked"),
      'related: "nope"',
      "---",
      "Body",
      "",
    ]);
    expect(runCli(["check"], proj, home).status).toBe(1);
    const json = runCli(["check", "--json"], proj, home);
    expect(json.status).toBe(1);
    const doc = JSON.parse(json.stdout) as {
      ok: boolean;
      diagnostics: Array<{ code: string; severity: string }>;
    };
    expect(doc.ok).toBe(false);
    expect(
      doc.diagnostics.some((d) => d.code === "related_invalid" && d.severity === "error"),
    ).toBe(true);
  });

  it("a self relation fails check with exit 1 in human and JSON modes", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    seedRaw(proj, "0001-linked.md", [
      ...header("0001", "Linked"),
      "related:",
      '  - "0001"',
      "---",
      "Body",
      "",
    ]);
    expect(runCli(["check"], proj, home).status).toBe(1);
    const json = runCli(["check", "--json"], proj, home);
    expect(json.status).toBe(1);
    const doc = JSON.parse(json.stdout) as { diagnostics: Array<{ code: string }> };
    expect(doc.diagnostics.some((d) => d.code === "self_relation")).toBe(true);
  });

  it("a duplicate related list fails check with exit 1 in human and JSON modes", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    seedRaw(proj, "0001-linked.md", [
      ...header("0001", "Linked"),
      "related:",
      '  - "0002"',
      '  - "0002"',
      "---",
      "Body",
      "",
    ]);
    seedRaw(proj, "0002-target.md", [...header("0002", "Target"), "---", "Body", ""]);
    expect(runCli(["check"], proj, home).status).toBe(1);
    const json = runCli(["check", "--json"], proj, home);
    expect(json.status).toBe(1);
    const doc = JSON.parse(json.stdout) as { diagnostics: Array<{ code: string }> };
    expect(doc.diagnostics.some((d) => d.code === "duplicate_relation")).toBe(true);
  });

  it("a missing-only relation store passes: exit 0 in human and JSON modes", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    seedRaw(proj, "0001-linked.md", [
      ...header("0001", "Linked"),
      "related:",
      '  - "0099"',
      "---",
      "Body",
      "",
    ]);
    expect(runCli(["check"], proj, home).status).toBe(0);
    const json = runCli(["check", "--json"], proj, home);
    expect(json.status).toBe(0);
    const doc = JSON.parse(json.stdout) as {
      ok: boolean;
      diagnostics: Array<{ code: string; severity: string }>;
    };
    expect(doc.ok).toBe(true);
    expect(
      doc.diagnostics.some((d) => d.code === "related_not_found" && d.severity === "warning"),
    ).toBe(true);
  });

  /* A related_ambiguous warning requires two claimant files for one id, and
   * those claimants always carry pre-existing duplicate_id errors, so the
   * store cannot exit 0. This pins the real behavior: exit 1 on the claimant
   * errors, ambiguity warning present as a warning, stdout one parseable
   * JSON document. Flagged to the leader: AC8's "ambiguous-only exit 0" is
   * infeasible as literally written. */
  it("an ambiguous relation store exits 1 on the claimants' duplicate ids, warning present in JSON", (ctx) => {
    if (!spawnOk) ctx.skip();
    const proj = freshProject();
    seedRaw(proj, "0002-copy-a.md", [...header("0002", "Copy a"), "---", "Body", ""]);
    seedRaw(proj, "0002-copy-b.md", [...header("0002", "Copy b"), "---", "Body", ""]);
    seedRaw(proj, "0001-linked.md", [
      ...header("0001", "Linked"),
      "related:",
      '  - "0002"',
      "---",
      "Body",
      "",
    ]);
    expect(runCli(["check"], proj, home).status).toBe(1);
    const json = runCli(["check", "--json"], proj, home);
    expect(json.status).toBe(1);
    // stdout stays exactly one parseable JSON document
    const doc = JSON.parse(json.stdout) as {
      ok: boolean;
      diagnostics: Array<{ code: string; severity: string; message: string }>;
    };
    expect(doc.ok).toBe(false);
    const ambiguous = doc.diagnostics.find((d) => d.code === "related_ambiguous");
    expect(ambiguous).toBeDefined();
    expect(ambiguous?.severity).toBe("warning");
    expect(ambiguous?.message).toContain('"0002"');
    expect(doc.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)).toEqual([
      "duplicate_id",
      "duplicate_id",
    ]);
  });
});

describe("engram links (process level, ENG-45)", () => {
  let tmp = "";
  let home = "";

  beforeAll(() => {
    if (!spawnOk) return;
    tmp = mkdtempSync(join(tmpdir(), "engram-proc-links-"));
    home = mkdtempSync(join(tmpdir(), "engram-proc-links-home-"));
  });
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (home) rmSync(home, { recursive: true, force: true });
  });

  let projectCounter = 0;
  const freshProject = (name = "links-proj"): string => {
    // Unique directory per call: tests in this describe share `tmp`, and
    // leftover seeds from one test must never leak into another's scan.
    const proj = join(tmp, `${name}-${(projectCounter += 1)}`);
    mkdirSync(join(proj, ".engram", "engrams"), { recursive: true });
    writeFileSync(
      join(proj, ".engram", "config.json"),
      JSON.stringify({ version: 1, tracked: true, defaultType: "note" }),
    );
    return proj;
  };

  /** Seed an entry whose filename slug matches its title (the scan's
   * cross-check stays clean). */
  const seedLink = (
    proj: string,
    id: string,
    title: string,
    over: { related?: string[]; created?: string } = {},
  ): string => {
    const created = over.created ?? "2026-08-16T10:00:00.000Z";
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "engram";
    const file = join(proj, ".engram", "engrams", `${id}-${slug}.md`);
    const fm = [
      `id: "${id}"`,
      `title: ${JSON.stringify(title)}`,
      "type: note",
      "tags: []",
      "scope: project",
      `created: ${created}`,
      `updated: ${created}`,
      'author: "Tester"',
      ...(over.related !== undefined
        ? [`related: [${over.related.map((r) => JSON.stringify(r)).join(", ")}]`]
        : []),
    ].join("\n");
    writeFileSync(file, `---\n${fm}\n---\nBody\n`);
    return file;
  };

  const snapshot = (proj: string): string =>
    readdirSync(join(proj, ".engram", "engrams"))
      .sort()
      .map((f) => readFileSync(join(proj, ".engram", "engrams", f), "utf8"))
      .join("\n%%%\n");

  it("defaults to project scope and renders both directions with markers", () => {
    if (!spawnOk) return;
    const proj = freshProject();
    seedLink(proj, "0001", "Root entry", { related: ["0005", "0002", "9999"] });
    seedLink(proj, "0002", "Auth note");
    seedLink(proj, "0005", "Newer peer");
    seedLink(proj, "0007", "Backlink entry", { related: ["0001"] });
    const before = snapshot(proj);

    const res = runCli(["links", "0001"], proj, home);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Links for 0001 - Root entry (note)");
    expect(res.stdout).toContain("Outgoing");
    expect(res.stdout.indexOf("0005")).toBeLessThan(res.stdout.indexOf("0002"));
    expect(res.stdout).toContain("9999 MISSING");
    expect(res.stdout).toContain("Incoming");
    expect(res.stdout).toContain("0007 note Backlink entry");
    expect(snapshot(proj)).toBe(before);
  });

  it("uses personal scope by default outside a project and with an explicit flag", () => {
    if (!spawnOk) return;
    const proj = freshProject();
    const bare = join(tmp, "links-bare");
    mkdirSync(bare, { recursive: true });
    mkdirSync(join(home, ".engram", "engrams"), { recursive: true });
    writeFileSync(
      join(home, ".engram", "engrams", "9001-personal-entry.md"),
      [
        "---",
        'id: "9001"',
        'title: "Personal entry"',
        "type: note",
        "tags: []",
        "scope: personal",
        "created: 2026-08-16T10:00:00.000Z",
        "updated: 2026-08-16T10:00:00.000Z",
        "---",
        "Body",
        "",
      ].join("\n"),
    );

    const fromBare = runCli(["links", "9001"], bare, home);
    expect(fromBare.status).toBe(0);
    expect(fromBare.stdout).toContain("Links for 9001 - Personal entry (note)");

    const explicit = runCli(["links", "9001", "--scope", "personal"], proj, home);
    expect(explicit.status).toBe(0);
    expect(explicit.stdout).toContain("Links for 9001 - Personal entry (note)");

    // Same-scope only: the personal id never resolves through project fallback.
    const projectScope = runCli(["links", "9001", "--scope", "project"], proj, home);
    expect(projectScope.status).toBe(0);
    expect(projectScope.stdout).toContain("Links for 9001 - MISSING");
  });

  it("renders ambiguous targets with claimant context and exits zero", () => {
    if (!spawnOk) return;
    const proj = freshProject();
    seedLink(proj, "0005", "Claim A");
    seedLink(proj, "0005", "Claim B");
    seedLink(proj, "0002", "Referrer", { related: ["0005"] });
    const before = snapshot(proj);

    const res = runCli(["links", "0005"], proj, home);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Links for 0005 - AMBIGUOUS (2 claimants)");
    expect(res.stdout).toContain("0002 note Referrer");
    expect(snapshot(proj)).toBe(before);
  });

  it("paginates with the CLI footer and continues at the given offset", () => {
    if (!spawnOk) return;
    const proj = freshProject();
    const authored = ["0005", "0002", "0013", "0004", "0006", "0007", "0008", "0009", "0010", "0011", "0012", "0003"];
    seedLink(proj, "0001", "Root entry", { related: authored });
    for (const id of authored) seedLink(proj, id, `Peer ${id}`);

    const page1 = runCli(["links", "0001"], proj, home);
    expect(page1.status).toBe(0);
    expect(page1.stdout).toContain(
      "(showing 1-10 of 12 - call engram links 0001 --offset 10 for more)",
    );
    expect(page1.stdout.length).toBeLessThanOrEqual(8192);

    const page2 = runCli(["links", "0001", "--offset", "10"], proj, home);
    expect(page2.status).toBe(0);
    expect(page2.stdout).toContain("0003 note Peer 0003");
    expect(page2.stdout).not.toContain("call engram links");
  });

  it("renders a warning summary for damaged sibling stores without failing", () => {
    if (!spawnOk) return;
    const proj = freshProject();
    seedLink(proj, "0001", "Root entry", { related: ["0002"] });
    seedLink(proj, "0002", "Peer 0002");
    writeFileSync(join(proj, ".engram", "engrams", "broken.md"), "not frontmatter at all");
    const before = snapshot(proj);

    const res = runCli(["links", "0001"], proj, home);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("0002 note Peer 0002");
    expect(res.stdout).toContain("WARNING: Engram memory is incomplete");
    expect(res.stdout).toContain("store diagnostic");
    expect(res.stdout).not.toContain("broken.md");
    expect(snapshot(proj)).toBe(before);
  });

  it("exits nonzero on invalid flags and true read failures", () => {
    if (!spawnOk) return;
    const proj = freshProject();
    seedLink(proj, "0001", "Root entry");

    expect(runCli(["links", "0001", "--scope", "banana"], proj, home).status).not.toBe(0);
    expect(runCli(["links", "0001", "--limit", "0"], proj, home).status).not.toBe(0);
    expect(runCli(["links", "0001", "--limit", "101"], proj, home).status).not.toBe(0);
    expect(runCli(["links", "0001", "--offset", "-1"], proj, home).status).not.toBe(0);
    expect(runCli(["links", "0001", "--offset", "abc"], proj, home).status).not.toBe(0);

    const bare = join(tmp, "links-bare-2");
    mkdirSync(bare, { recursive: true });
    const degraded = runCli(["links", "0001", "--scope", "project"], bare, home);
    expect(degraded.status).toBe(1);
    expect(degraded.stderr).toContain("error:");
  });

  it("keeps every file byte-identical across the read surface", () => {
    if (!spawnOk) return;
    const proj = freshProject();
    seedLink(proj, "0001", "Root entry", { related: ["0002"] });
    seedLink(proj, "0002", "Peer 0002");
    const before = snapshot(proj);

    for (const args of [
      ["links", "0001"],
      ["links", "0001", "--offset", "1"],
      ["links", "0002", "--scope", "project", "--limit", "5"],
      ["links", "9999"],
    ]) {
      const res = runCli(args, proj, home);
      expect(res.status).toBe(0);
    }

    const names = readdirSync(join(proj, ".engram", "engrams")).sort();
    expect(names).toEqual(readdirSync(join(proj, ".engram", "engrams")).sort());
    expect(snapshot(proj)).toBe(before);
  });
});
