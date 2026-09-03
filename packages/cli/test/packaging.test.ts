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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

    // opencode plugin ships and is declared as the npm-plugin server entry
    // (opencode's loader reads exports["./server"] before main)
    expect(existsSync(join(pkgRoot, "dist", "opencode-plugin.js"))).toBe(true);
    expect(manifest.exports).toEqual({
      ".": "./dist/index.js",
      "./server": "./dist/opencode-plugin.js",
    });
    expect(manifest.dependencies?.zod).toMatch(/^\^4\./);
    const ocBundle = readFileSync(join(pkgRoot, "dist", "opencode-plugin.js"), "utf8");
    expect(ocBundle).toMatch(/from\s+["']zod["']/);

    // the shipped CLI reports the manifest version (guards the five-place
    // version sync; this catches a missed .version() bump)
    const cliManifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    const versionOut = execFileSync(
      process.execPath,
      [join(pkgRoot, "dist", "index.js"), "--version"],
      {
        cwd: pkgRoot,
        encoding: "utf8",
      },
    ).trim();
    expect(versionOut).toBe(cliManifest.version);
  });

  it("prepack copies the skill from @engram/harnesses", (ctx) => {
    if (!spawnOk) ctx.skip();

    run(["pack", "--dry-run", "--json"], pkgDir); // triggers prepack
    expect(existsSync(join(pkgDir, "skills", "engram", "SKILL.md"))).toBe(true);
  });

  it("shipped opencode plugin imports and registers tools + system transform", (ctx) => {
    if (!spawnOk) ctx.skip();

    run(["--filter", "engram-cli", "build"], repoRoot);
    const parsed = JSON.parse(run(["pack", "--json", "--pack-destination", tmp], pkgDir));
    const filename = (Array.isArray(parsed) ? parsed[0].filename : parsed.filename) as string;
    const tarball = join(tmp, basename(filename));

    const installed = join(tmp, "opencode-import-check");
    mkdirSync(installed, { recursive: true });
    run(["install", "--ignore-scripts", tarball], installed);

    // Import the package's exported ./server subpath exactly like opencode
    // resolves it (via exports["./server"], not the dist file path) so an
    // invalid export mapping fails this test, and drive the plugin factory:
    // tools + the experimental system transform must be present, and a
    // transform over an empty store must be a no-op.
    const script = `
      const mod = await import("engram-cli/server");
      if (typeof mod.default !== "function") throw new Error("default export is not a function");
      const hooks = await mod.default({ directory: process.cwd() });
      const tools = Object.keys(hooks.tool ?? {}).sort();
      if (JSON.stringify(tools) !== JSON.stringify(["engram_add", "engram_context", "engram_search", "engram_show"]))
        throw new Error("unexpected tool map: " + tools.join(","));
      if (typeof hooks["experimental.chat.system.transform"] !== "function")
        throw new Error("system transform missing");
      if (typeof hooks.event !== "function") throw new Error("event hook missing");
      const out = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, out);
      if (out.system[0] !== "base") throw new Error("empty store must not inject: " + JSON.stringify(out));
      console.log("OK");
    `;
    const res = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: installed,
      encoding: "utf8",
    }).trim();
    expect(res).toBe("OK");
  });

  it("shipped pi extension imports and registers tools, command, and lifecycle hooks", (ctx) => {
    if (!spawnOk) ctx.skip();

    run(["--filter", "engram-cli", "build"], repoRoot);
    const parsed = JSON.parse(run(["pack", "--json", "--pack-destination", tmp], pkgDir));
    const filename = (Array.isArray(parsed) ? parsed[0].filename : parsed.filename) as string;
    const tarball = join(tmp, basename(filename));

    const installed = join(tmp, "pi-import-check");
    mkdirSync(installed, { recursive: true });
    run(["install", "--ignore-scripts", tarball], installed);

    // The pi host provides @earendil-works/pi-ai to extensions at runtime; the
    // tarball deliberately does not depend on it. Stub it the way the host
    // would so the raw import below can resolve.
    const hostStub = join(installed, "node_modules", "@earendil-works", "pi-ai");
    mkdirSync(hostStub, { recursive: true });
    writeFileSync(
      join(hostStub, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.0.0-stub", type: "module" }),
    );
    writeFileSync(
      join(hostStub, "index.js"),
      "export const StringEnum = (values) => ({ enum: values });\n",
    );

    // Import the packed pi-extension bundle exactly like pi loads it and drive
    // the factory: tools, the /engram command, and the auto-context lifecycle
    // handlers must all register against the extension API surface.
    const extUrl = pathToFileURL(
      join(installed, "node_modules", "engram-cli", "dist", "pi-extension.js"),
    ).href;
    const script = `
      const mod = await import(${JSON.stringify(extUrl)});
      if (typeof mod.default !== "function") throw new Error("default export is not a function");
      const tools = [];
      const commands = [];
      const handlers = new Map();
      mod.default({
        registerTool: (t) => tools.push(t.name),
        registerCommand: (name) => commands.push(name),
        on: (name) => handlers.set(name, true),
      });
      const expectedTools = [
        "engram_context",
        "engram_search",
        "engram_show",
        "engram_add",
        "engram_edit",
      ];
      if (JSON.stringify(tools) !== JSON.stringify(expectedTools))
        throw new Error("unexpected tools: " + tools.join(","));
      if (JSON.stringify(commands) !== JSON.stringify(["engram"]))
        throw new Error("unexpected commands: " + commands.join(","));
      for (const h of ["session_start", "before_agent_start"])
        if (!handlers.has(h)) throw new Error("missing lifecycle handler: " + h);
      console.log("OK");
    `;
    const res = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: installed,
      encoding: "utf8",
    }).trim();
    expect(res).toBe("OK");
  });
});
