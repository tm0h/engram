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
    // ENG-37: the claude scaffold assets ship in the payload
    expect(existsSync(join(pkgRoot, "claude-scaffold", "bin", "engram"))).toBe(true);
    expect(existsSync(join(pkgRoot, "claude-scaffold", "SKILL.md"))).toBe(true);

    // manifest declares the extension, skill, and gallery keyword
    const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
    expect(manifest.keywords).toContain("pi-package");
    expect(manifest.pi).toEqual({
      extensions: ["./dist/pi-extension.js"],
      skills: ["./skills"],
    });

    // typebox is host-provided: Pi maps it into extensions at runtime. It
    // must be an optional "*" peer (docs/packages.md, "Declare
    // dependencies"); a physical dependencies copy bypasses the extension
    // module mapping and makes Pi warn on session start.
    expect(manifest.dependencies?.typebox).toBeUndefined();
    expect(manifest.peerDependencies?.typebox).toBe("*");
    expect(manifest.peerDependenciesMeta?.typebox).toEqual({ optional: true });
    // both Pi host packages stay declared as optional "*" peers
    expect(manifest.peerDependencies?.["@earendil-works/pi-ai"]).toBe("*");
    expect(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBe("*");
    expect(manifest.peerDependenciesMeta?.["@earendil-works/pi-ai"]).toEqual({ optional: true });
    expect(manifest.peerDependenciesMeta?.["@earendil-works/pi-coding-agent"]).toEqual({
      optional: true,
    });

    // the bundle imports typebox externally instead of inlining it
    const bundle = readFileSync(join(pkgRoot, "dist", "pi-extension.js"), "utf8");
    expect(bundle).toMatch(/from\s+["']typebox["']/);

    // opencode plugin ships and is declared as the npm-plugin server entry
    // (opencode's loader reads exports["./server"] before main)
    expect(existsSync(join(pkgRoot, "dist", "opencode-plugin.js"))).toBe(true);
    expect(existsSync(join(pkgRoot, "dist", "capture-adapter.js"))).toBe(true);
    expect(manifest.exports).toEqual({
      ".": "./dist/index.js",
      "./server": "./dist/opencode-plugin.js",
      "./capture": "./dist/capture-adapter.js",
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
    // ENG-37: the claude scaffold variant and launcher are copied too
    expect(existsSync(join(pkgDir, "claude-scaffold", "bin", "engram"))).toBe(true);
    expect(existsSync(join(pkgDir, "claude-scaffold", "SKILL.md"))).toBe(true);
  });

  it("shipped CLI installs and runs ENG-58 hooks from a fresh tarball (ENG-58)", (ctx) => {
    if (!spawnOk) ctx.skip();

    run(["--filter", "engram-cli", "build"], repoRoot);
    const parsed = JSON.parse(run(["pack", "--json", "--pack-destination", tmp], pkgDir));
    const filename = (Array.isArray(parsed) ? parsed[0].filename : parsed.filename) as string;
    const tarball = join(tmp, basename(filename));

    const installed = join(tmp, "eng58-install-check");
    mkdirSync(installed, { recursive: true });
    run(["install", "--ignore-scripts", tarball], installed);
    const pkgRoot = join(installed, "node_modules", "engram-cli");
    const bin = join(pkgRoot, "dist", "index.js");

    const home = mkdtempSync(join(tmpdir(), "engram-eng58-home-"));
    const emptyProject = mkdtempSync(join(tmpdir(), "engram-eng58-proj-"));
    try {
      // fresh machine: status is read-only and reports the target absent
      const status = execFileSync(
        process.execPath,
        [bin, "install", "claude-code", "--status", "--home", home],
        { cwd: pkgRoot, encoding: "utf8" },
      );
      expect(status).toContain("target: claude-code");
      expect(status).toContain("settings.json: absent");

      // install codex hooks into the isolated home
      const installOut = execFileSync(
        process.execPath,
        [bin, "install", "codex", "--yes", "--home", home],
        { cwd: pkgRoot, encoding: "utf8" },
      );
      expect(installOut).toContain("Installed 2 change(s)"); // hooks.json + sidecar
      const hooksPath = join(home, ".codex", "hooks.json");
      expect(existsSync(hooksPath)).toBe(true);
      const hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as Record<string, any>;
      expect(hooks.hooks.SessionStart).toHaveLength(1);
      // entries carry only spec-valid keys (turn-2, F2: no marker keys)
      expect(Object.keys(hooks.hooks.SessionStart[0])).toEqual(["hooks"]);
      const sidecarPath = join(home, ".codex", "engram-managed.json");
      expect(existsSync(sidecarPath)).toBe(true);
      const ledger = JSON.parse(readFileSync(sidecarPath, "utf8")) as any[];
      expect(ledger[1].target).toBe("codex");
      expect(ledger[1].configFile).toBe("hooks.json");
      expect(
        ledger[1].entries
          .map((e: any) => e.identity)
          .sort((a: string, b: string) => a.localeCompare(b)),
      ).toEqual(["engram-hook:codex:compact", "engram-hook:codex:startup"]);

      // the installed hook entry point runs, fails open, and stays bounded
      const hookOut = execFileSync(process.execPath, [bin, "hook", "codex", "startup"], {
        cwd: emptyProject,
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      });
      expect(hookOut).toBe("");

      // An empty payload must not conceal a broken packaged hook: initialize
      // a real store, then verify the shared curated policy through the bundle.
      const packagedCli = (...args: string[]): string =>
        execFileSync(process.execPath, [bin, ...args], {
          cwd: emptyProject,
          encoding: "utf8",
          env: { ...process.env, HOME: home },
        });
      execFileSync("git", ["init", "--quiet"], { cwd: emptyProject });
      packagedCli("init", "--tracked");
      packagedCli(
        "add",
        "--title",
        "Packaged pinned convention",
        "--pinned",
        "Private body must stay out of startup",
      );
      packagedCli("add", "--title", "Ordinary packaged note", "Ordinary note body");
      const curated = packagedCli("hook", "codex", "startup");
      expect(curated).toContain("Packaged pinned convention");
      expect(curated).not.toContain("Ordinary packaged note");
      expect(curated).not.toContain("Private body must stay out of startup");
      expect(curated.startsWith("<engram-memory>\n")).toBe(true);
      expect(curated.trimEnd().endsWith("</engram-memory>")).toBe(true);
      expect(Buffer.byteLength(curated, "utf8")).toBeLessThanOrEqual(8192);
      packagedCli("config", "set", "autoContext", "off");
      expect(packagedCli("hook", "codex", "startup")).toBe("");

      // uninstall removes only engram-owned entries
      execFileSync(
        process.execPath,
        [bin, "install", "codex", "--yes", "--uninstall", "--home", home],
        { cwd: pkgRoot, encoding: "utf8" },
      );
      const after = JSON.parse(readFileSync(hooksPath, "utf8")) as Record<string, any>;
      // the fresh install was wholly engram-owned: emptied containers prune
      expect(after.hooks).toBeUndefined();
      expect(Object.keys(after)).toHaveLength(0);
      // uninstall removes the sidecar itself (turn-2, F2)
      expect(existsSync(sidecarPath)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(emptyProject, { recursive: true, force: true });
    }
  });

  it("shipped CLI scaffolds the claude project skill from a fresh tarball (ENG-37)", (ctx) => {
    if (!spawnOk) ctx.skip();

    run(["--filter", "engram-cli", "build"], repoRoot);
    const parsed = JSON.parse(run(["pack", "--json", "--pack-destination", tmp], pkgDir));
    const filename = (Array.isArray(parsed) ? parsed[0].filename : parsed.filename) as string;
    const tarball = join(tmp, basename(filename));

    const installed = join(tmp, "eng37-install-check");
    mkdirSync(installed, { recursive: true });
    run(["install", "--ignore-scripts", tarball], installed);
    const pkgRoot = join(installed, "node_modules", "engram-cli");
    const bin = join(pkgRoot, "dist", "index.js");

    const proj = mkdtempSync(join(tmpdir(), "engram-eng37-proj-"));
    try {
      const out = execFileSync(
        process.execPath,
        [bin, "install", "claude", "--yes", "--root", proj],
        { cwd: pkgRoot, encoding: "utf8" },
      );
      expect(out).toContain("Installed 5 change(s) for claude");

      // the scaffold resolves the payload assets: frontmatter-first skill,
      // shebang-first launcher with the release pin, markers in between
      const skill = readFileSync(join(proj, ".claude", "skills", "engram", "SKILL.md"), "utf8");
      expect(skill.startsWith("---\n")).toBe(true);
      expect(skill).toContain("description:");
      expect(skill).toContain("<!-- BEGIN: engram-claude-skill -->");
      const launcher = readFileSync(
        join(proj, ".claude", "skills", "engram", "bin", "engram"),
        "utf8",
      );
      expect(launcher.startsWith("#!/bin/sh\n")).toBe(true);
      expect(launcher).toContain("# BEGIN: engram-claude-launcher");
      expect(launcher).toMatch(/engram-cli@\d+\.\d+\.\d+/);

      // repair after a simulated older release pin
      writeFileSync(
        join(proj, ".claude", "skills", "engram", "bin", "engram"),
        launcher.replace(/engram-cli@\d+\.\d+\.\d+/, "engram-cli@0.0.1"),
      );
      execFileSync(process.execPath, [bin, "install", "claude", "--yes", "--root", proj], {
        cwd: pkgRoot,
        encoding: "utf8",
      });
      expect(readFileSync(join(proj, ".claude", "skills", "engram", "bin", "engram"), "utf8")).toBe(
        launcher,
      );
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it("shipped opencode plugin delivers recall for the active turn and refreshes after writes", (ctx) => {
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
    // invalid export mapping fails this test. Use separate initialization and
    // turn directories with a fixture that mirrors the SDK's session endpoints.
    const script = `
      import assert from "node:assert/strict";
      import { mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const mod = await import("engram-cli/server");
      const init = process.cwd();
      const active = join(init, "worktree");
      const fixture = (directory) => {
        mkdirSync(join(directory, ".engram", "engrams"), { recursive: true });
        writeFileSync(join(directory, ".engram", "config.json"),
          JSON.stringify({ version: 1, tracked: true, defaultType: "note" }));
      };
      fixture(init);
      fixture(active);

      const sessionID = "s1";
      const model = { id: "model", providerID: "provider" };
      let messageID = "user-1";
      let prompt = "bluebird";
      const client = { session: {
        messages: async ({ path, query }) => {
          assert.equal(path.id, sessionID);
          assert.equal(query.limit, 1);
          return { data: [{ info: {
            role: "assistant", sessionID, parentID: messageID, time: {}, path: { cwd: active },
            modelID: model.id, providerID: model.providerID,
          }, parts: [] }] };
        },
        message: async ({ path }) => {
          assert.deepEqual(path, { id: sessionID, messageID });
          return { data: {
            info: { role: "user", id: messageID, sessionID },
            parts: [{ type: "text", text: prompt, sessionID, messageID }],
          } };
        },
      } };
      const hooks = await mod.default({ directory: init, client });
      const tools = Object.keys(hooks.tool ?? {}).sort();
      const expected = [
        "engram_add",
        "engram_context",
        "engram_edit",
        "engram_search",
        "engram_show",
      ];
      if (JSON.stringify(tools) !== JSON.stringify(expected))
        throw new Error("unexpected tool map: " + tools.join(","));
      if (typeof hooks["experimental.chat.system.transform"] !== "function")
        throw new Error("system transform missing");
      if (typeof hooks.event !== "function") throw new Error("event hook missing");
      const out = { system: ["base", "prior plugin"] };
      const transform = hooks["experimental.chat.system.transform"];
      const render = async () => {
        await transform({ sessionID, model }, out);
        assert.deepEqual(out.system.slice(0, 2), ["base", "prior plugin"]);
        return out.system.slice(2).join("\\n");
      };
      assert.equal(await render(), "");

      const add = async (directory, title, body) => {
        const result = await hooks.tool.engram_add.execute({ title, body }, { directory, sessionID });
        assert.equal(result.metadata?.isError, false, result.output);
      };
      await add(init, "Bluebird", "bluebird initialization memory");
      await add(active, "Bluebird", "bluebird rollout advice");
      await add(active, "Redfinch", "redfinch followup advice");

      const first = await render();
      assert.match(first, /bluebird rollout advice/);
      assert.doesNotMatch(first, /initialization memory|redfinch followup advice/);
      assert.equal(await render(), first);
      assert.equal(first.split("<engram-memory>").length, 2);

      messageID = "user-2";
      prompt = "redfinch";
      const next = await render();
      assert.match(next, /redfinch followup advice/);
      assert.doesNotMatch(next, /bluebird/);
      assert.equal(next.split("<engram-memory>").length, 2);

      await add(active, "Redfinch extra", "redfinch revised advice");
      const refreshed = await render();
      assert.match(refreshed, /redfinch revised advice/);
      assert.equal(refreshed.split("<engram-memory>").length, 2);
      assert.equal(out.system.length, 3);
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

    // typebox is host-provided too (docs/packages.md): with the optional peer
    // left uninstalled, a stub stands in for the host mapping the same way.
    // Schemas are only built, never inspected, so a call-tolerant Type covers
    // registration.
    const typeboxStub = join(installed, "node_modules", "typebox");
    mkdirSync(typeboxStub, { recursive: true });
    writeFileSync(
      join(typeboxStub, "package.json"),
      JSON.stringify({ name: "typebox", version: "0.0.0-stub", type: "module" }),
    );
    writeFileSync(
      join(typeboxStub, "index.js"),
      "const anySchema = () => ({});\n" +
        "export const Type = new Proxy({}, { get: () => anySchema });\n",
    );

    // Import the packed pi-extension bundle exactly like pi loads it and drive
    // the factory: tools, the /engram command, and the auto-context lifecycle
    // handlers must all register against the extension API surface.
    const extUrl = pathToFileURL(
      join(installed, "node_modules", "engram-cli", "dist", "pi-extension.js"),
    ).href;
    const home = join(installed, "isolated-home");
    mkdirSync(join(home, ".engram"), { recursive: true });
    const engrams = join(installed, ".engram", "engrams");
    mkdirSync(engrams, { recursive: true });
    writeFileSync(
      join(installed, ".engram", "config.json"),
      JSON.stringify({ version: 1, tracked: true }),
    );
    writeFileSync(
      join(engrams, "0001-orchid-cache.md"),
      [
        "---",
        'id: "0001"',
        "title: Orchid cache",
        "type: note",
        "tags: []",
        "scope: project",
        "created: 2026-08-16T10:00:00.000Z",
        "updated: 2026-08-16T10:00:00.000Z",
        "---",
        "Store Orchid assets for seven days.",
      ].join("\n") + "\n",
    );
    const script = `
      const mod = await import(${JSON.stringify(extUrl)});
      if (typeof mod.default !== "function") throw new Error("default export is not a function");
      const tools = [];
      const commands = [];
      const handlers = new Map();
      mod.default({
        registerTool: (t) => tools.push(t.name),
        registerCommand: (name) => commands.push(name),
        on: (name, handler) => handlers.set(name, handler),
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
      const ctx = {
        cwd: process.cwd(),
        hasUI: false,
        get ui() { throw new Error("unexpected headless UI use"); },
      };
      await handlers.get("session_start")({ reason: "startup" }, ctx);
      const before = handlers.get("before_agent_start");
      const recall = await before({ prompt: "Orchid cache", systemPrompt: "BASE" }, ctx);
      if (!recall?.systemPrompt.startsWith("BASE") ||
          !recall.systemPrompt.includes("Store Orchid assets for seven days.") ||
          recall.systemPrompt.split("<engram-memory>").length !== 2 ||
          recall.message !== undefined)
        throw new Error("packed Pi did not deliver exactly one task-specific block");
      const weak = await before({ prompt: "Orchid seismology", systemPrompt: "BASE" }, ctx);
      if (weak !== undefined) throw new Error("packed Pi did not abstain");
      console.log("OK");
    `;
    const res = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: installed,
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    }).trim();
    expect(res).toBe("OK");
  });
});
