/**
 * Claude plugin structure + shim behavior. CI-safe: no claude CLI, no network.
 */
import { describe, it, expect } from "vite-plus/test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(pkgRoot, "claude");
const repoRoot = resolve(pkgRoot, "../..");

describe("claude plugin structure", () => {
  it("marketplace.json points at a valid plugin directory", () => {
    const marketplace = JSON.parse(
      readFileSync(join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"),
    );
    expect(marketplace.name).toBe("engram");
    const plugin = marketplace.plugins[0];
    expect(plugin.name).toBe("engram");
    expect(plugin.source).toBe("./packages/harnesses/claude");
    expect(existsSync(join(repoRoot, plugin.source, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  it("plugin.json is well-formed and version-synced with the CLI", () => {
    const plugin = JSON.parse(
      readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"),
    );
    expect(plugin.name).toBe("engram");
    expect(plugin.description.length).toBeGreaterThan(20);
    const cli = JSON.parse(readFileSync(join(repoRoot, "packages", "cli", "package.json"), "utf8"));
    expect(plugin.version).toBe(cli.version);
  });

  it("ships an engram skill with valid frontmatter", () => {
    const skill = readFileSync(join(pluginRoot, "skills", "engram", "SKILL.md"), "utf8");
    expect(skill.startsWith("---")).toBe(true);
    expect(skill).toMatch(/^name:\s*engram$/m);
    expect(skill).toMatch(/^description:\s*\S/m);
  });

  it("bin/engram exists, is executable, and is valid shell", () => {
    const shim = join(pluginRoot, "bin", "engram");
    expect(existsSync(shim)).toBe(true);
    const probe = spawnSync("sh", ["-n", shim], { encoding: "utf8" });
    expect(probe.status).toBe(0);
  });
});

describe("claude plugin shim dispatch", () => {
  it("prefers an engram binary found on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "engram-shim-"));
    const fakeBin = join(dir, "engram");
    writeFileSync(fakeBin, '#!/bin/sh\necho "fake-engram:$*"\n');
    chmodSync(fakeBin, 0o755);

    const res = spawnSync(join(pluginRoot, "bin", "engram"), ["--version"], {
      encoding: "utf8",
      env: { ...process.env, PATH: [dir, process.env.PATH].join(":") },
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("fake-engram:--version");

    rmSync(dir, { recursive: true, force: true });
  });

  it("npx fallback pins the CLI version (syntax only, no network)", () => {
    const shim = readFileSync(join(pluginRoot, "bin", "engram"), "utf8");
    const cli = JSON.parse(readFileSync(join(repoRoot, "packages", "cli", "package.json"), "utf8"));
    expect(shim).toContain(`npx -y engram-cli@${cli.version}`);
  });

  it("skips itself when the plugin bin dir is first on PATH (no recursion)", () => {
    const dir = mkdtempSync(join(tmpdir(), "engram-selfskip-"));
    // a real engram later on PATH must win
    const otherBin = join(dir, "other");
    mkdirSync(otherBin, { recursive: true });
    writeFileSync(join(otherBin, "engram"), '#!/bin/sh\necho "real-engram:$*"\n');
    chmodSync(join(otherBin, "engram"), 0o755);

    const res = spawnSync(join(pluginRoot, "bin", "engram"), ["--version"], {
      encoding: "utf8",
      env: {
        PATH: [join(pluginRoot, "bin"), otherBin, process.env.PATH].join(":"),
      },
      timeout: 10_000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("real-engram:--version");

    rmSync(dir, { recursive: true, force: true });
  });

  it("falls through to npx when only itself is on PATH (network-free stub)", () => {
    const dir = mkdtempSync(join(tmpdir(), "engram-npxstub-"));
    const npxDir = join(dir, "npxdir");
    mkdirSync(npxDir, { recursive: true });
    writeFileSync(join(npxDir, "npx"), '#!/bin/sh\necho "npx-stub:$*"\n');
    chmodSync(join(npxDir, "npx"), 0o755);

    const res = spawnSync(join(pluginRoot, "bin", "engram"), ["--version"], {
      encoding: "utf8",
      env: {
        PATH: [join(pluginRoot, "bin"), npxDir, "/usr/bin", "/bin"].join(":"),
      },
      timeout: 10_000,
    });
    expect(res.status).toBe(0);
    const cliVersion = JSON.parse(
      readFileSync(join(repoRoot, "packages", "cli", "package.json"), "utf8"),
    ).version;
    expect(res.stdout.trim()).toBe(`npx-stub:-y engram-cli@${cliVersion} --version`);

    rmSync(dir, { recursive: true, force: true });
  });
});
