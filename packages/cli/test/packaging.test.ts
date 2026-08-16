/**
 * Packaging test (pi-web-access pattern): pack the real tarball, assert the
 * Pi extension ships correctly, and install it the way `pi install` would.
 *
 * Runs `pnpm` with the inherited environment: the vite-plus test runner can
 * expose a different filesystem view to children than to this process, so
 * absolute-path pre-resolution is unreliable here. A spawn probe gates the
 * suite — it skips (rather than fails) on runners where spawning is blocked.
 */
import { describe, it, expect, afterAll } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const pkgDir = resolve(new URL("..", import.meta.url).pathname);
const repoRoot = resolve(pkgDir, "../..");

let spawnOk = true;
try {
  execFileSync("pnpm", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch {
  spawnOk = false;
}

/** Run pnpm, retrying once — transient ENOENT has been observed in runners. */
const run = (args: string[], cwd: string): string => {
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync("pnpm", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      if (attempt === 0) continue;
      throw e;
    }
  }
};

describe("engram-cli packaging (pi extension)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "engram-pack-"));

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("packs a tarball containing the pi extension, skill, and manifest", (ctx) => {
    if (!spawnOk) ctx.skip();

    run(["--filter", "engram-cli", "build"], repoRoot);
    const parsed = JSON.parse(run(["pack", "--json", "--pack-destination", tmp], pkgDir));
    const filename = (Array.isArray(parsed) ? parsed[0].filename : parsed.filename) as string;
    const tarball = join(tmp, basename(filename));

    const installed = join(tmp, "install-check");
    mkdirSync(installed, { recursive: true });
    run(["install", "--ignore-scripts", tarball], installed);

    const pkgRoot = join(installed, "node_modules", "engram-cli");
    // bundle + skill survived into the installed package
    expect(existsSync(join(pkgRoot, "dist", "pi-extension.js"))).toBe(true);
    expect(existsSync(join(pkgRoot, "dist", "index.js"))).toBe(true);
    expect(existsSync(join(pkgRoot, "skills", "engram", "SKILL.md"))).toBe(true);

    // manifest declares the extension, skill, and gallery keyword
    const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
    expect(manifest.keywords).toContain("pi-package");
    expect(manifest.pi).toEqual({
      extensions: ["./dist/pi-extension.js"],
      skills: ["./skills"],
    });

    // typebox is a real dependency (pi-web-access tested pattern) and resolves
    expect(manifest.peerDependencies?.typebox).toBeUndefined();
    expect(manifest.dependencies?.typebox).toMatch(/^\^1\./);
    const pkgRequire = createRequire(join(pkgRoot, "package.json"));
    expect(pkgRequire.resolve("typebox")).toMatch(/node_modules[\\/]typebox/);

    // the bundle imports typebox externally instead of inlining it
    const bundle = readFileSync(join(pkgRoot, "dist", "pi-extension.js"), "utf8");
    expect(bundle).toMatch(/from\s+["']typebox["']/);
  });

  it("prepack copies the skill from @engram/harnesses", (ctx) => {
    if (!spawnOk) ctx.skip();

    run(["pack", "--dry-run", "--json"], pkgDir); // triggers prepack
    expect(existsSync(join(pkgDir, "skills", "engram", "SKILL.md"))).toBe(true);
  });
});
