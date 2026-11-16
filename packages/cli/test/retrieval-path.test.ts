import { it, expect } from "vite-plus/test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const cli = join(repo, "packages/cli/src/index.ts");
// Load TypeScript in Node directly; the tsx executable requires an IPC socket.
const loader = join(repo, "node_modules/tsx/dist/loader.mjs");
it("accepts path filtering on search and rejects it on unsupported commands", () => {
  const root = mkdtempSync(join(tmpdir(), "engram-path-review-"));
  const env = { ...process.env, HOME: root };
  const run = (...args: string[]) =>
    execFileSync(process.execPath, ["--import", loader, cli, ...args], {
      cwd: root,
      env,
      encoding: "utf8",
    });
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    run("init", "--tracked");
    run(
      "add",
      "--title",
      "Database convention",
      "--triggers",
      "node:fs",
      "--applies-to",
      "packages/api/**",
      "Use durable writes",
    );
    const matching = JSON.parse(
      run("search", "node:fs", "--path", "packages/api/a.ts", "--json", "--explain"),
    );
    expect(matching.results).toHaveLength(1);
    expect(matching.results[0].explanation.contributions).toContainEqual({
      field: "trigger",
      token: "node:fs",
      component: "trigger",
      score: 4,
    });
    expect(
      JSON.parse(run("search", "node:fs", "--path", "packages/web/a.ts", "--json")).results,
    ).toEqual([]);
    for (const command of ["list", "context"]) {
      const result = spawnSync(
        process.execPath,
        ["--import", loader, cli, command, "--path", "packages/api/a.ts"],
        { cwd: root, env, encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unknown option '--path'");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
