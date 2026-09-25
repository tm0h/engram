import { describe, expect, it } from "vite-plus/test";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const resolveFileUrl = (url: URL): string => resolve(fileURLToPath(url));
const repoRoot = resolveFileUrl(new URL("../../..", import.meta.url));
const readRepoFile = (path: string): string => readFileSync(resolve(repoRoot, path), "utf8");

describe("Docker E2E runner", () => {
  it("decodes encoded checkout paths", () => {
    expect(resolveFileUrl(new URL("file:///tmp/engram%20checkout/"))).toBe("/tmp/engram checkout");
  });

  it("builds an isolated image containing the packaged CLI", () => {
    const dockerfile = readRepoFile("Dockerfile.e2e");

    expect(dockerfile).toContain("FROM node:24-bookworm-slim");
    expect(dockerfile).toContain("COREPACK_HOME=/opt/corepack");
    expect(dockerfile).toContain("--cache-dir /opt/pnpm-cache");
    expect(dockerfile).toContain("--store-dir /opt/pnpm-store");
    expect(dockerfile).toContain("PNPM_CONFIG_OFFLINE=true");
    expect(dockerfile).toContain("PNPM_CONFIG_CACHE_DIR=/opt/pnpm-cache");
    expect(dockerfile).toContain("PNPM_CONFIG_STORE_DIR=/opt/pnpm-store");
    expect(dockerfile).toContain("corepack install --global pnpm@11.21.0");
    expect(dockerfile).toContain("pnpm install --frozen-lockfile");
    expect(dockerfile).toContain("pnpm --filter engram-cli build");
    expect(dockerfile).toContain("pnpm --filter engram-cli pack");
    expect(dockerfile).toContain("install --ignore-scripts");
    expect(dockerfile).toContain("npm install --global --prefix /opt/engram");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain('ENTRYPOINT ["bash", "/workspace/scripts/e2e-cli.sh"]');
  });

  it("uses only a clean committed snapshot and disables the runtime network", () => {
    const runner = readRepoFile("scripts/run-e2e-container.sh");
    const dockerignore = readRepoFile(".dockerignore");

    expect(runner).toContain("git status --porcelain");
    expect(runner).toContain("git archive");
    expect(runner).toContain("docker build");
    expect(runner).toContain("--network none");
    expect(runner).toContain("--cap-drop ALL");
    expect(runner).toContain("--security-opt no-new-privileges");
    expect(runner).toContain("--tmpfs /var/tmp:rw,nosuid,nodev,exec");
    expect(runner).not.toMatch(/(?:--volume|-v)\s+[^\n]*(?:HOME|\.engram)/);
    expect(dockerignore).toContain(".engram");
    expect(dockerignore).toContain(".env");
    expect(dockerignore).toContain("node_modules");
  });

  it("runs the release gate and CLI journey inside disposable storage", () => {
    const e2e = readRepoFile("scripts/e2e-cli.sh");

    expect(e2e).toContain("pnpm check");
    expect(e2e).toContain("pnpm test");
    expect(e2e).toContain("pnpm --filter @engram/core benchmark");
    expect(e2e).toContain("mktemp -d /var/tmp/engram-e2e.XXXXXX");
    expect(e2e).toContain("engram init --tracked");
    expect(e2e).toContain("engram search");
    expect(e2e).toContain("engram check --json");
    expect(e2e).toContain("engram review --json");
    expect(e2e).toContain("engram remove");
  });

  it("pins packaged CLI coverage for every post-0.4.0 command surface", () => {
    const e2e = readRepoFile("scripts/e2e-cli.sh");

    for (const scenario of [
      "Integrity failure diagnostics",
      "Lifecycle clearing and validation",
      "BM25 query syntax and pagination",
      "Secret scanner policies",
      "Duplicate repair",
      "Pipe closure",
      "Related entry links",
      "Call-form body search",
      "Host hook install surface",
    ]) {
      expect(e2e).toContain(`step "${scenario}"`);
    }

    expect(e2e).toContain("--clear-review-after");
    expect(e2e).toContain("--clear-supersedes");
    expect(e2e).toContain("--clear-source-ref");
    expect(e2e).toContain("--clear-related");
    expect(e2e).toContain("--related");
    expect(e2e).toContain("related_not_found");
    expect(e2e).toContain("SEC-INJECT-OVERRIDE");
    expect(e2e).toContain("--allow-secrets");
    expect(e2e).toContain("tag:ops AND title:alpha");
    expect(e2e).toContain("engram dedupe --scope project");
    expect(e2e).toContain("head -c 1");
  });

  it("pins audit coverage for the related, call-form, and hook install surfaces", () => {
    const e2e = readRepoFile("scripts/e2e-cli.sh");

    expect(e2e).toContain("engram search 'exportStatic(outDir)'");
    expect(e2e).toContain("CLAUDE_CONFIG_DIR");
    expect(e2e).toContain("CODEX_HOME");
    expect(e2e).toContain("engram install claude-code --dry-run");
    expect(e2e).toContain("engram install claude-code --yes");
    expect(e2e).toContain("engram install claude-code --yes --uninstall");
    expect(e2e).toContain("engram install codex --yes");
    expect(e2e).toContain("engram install codex --yes --uninstall");
    expect(e2e).toContain("engram hook claude-code startup");
    expect(e2e).toContain("Dry run: no changes were written.");
    expect(e2e).toContain("Nothing to do: hooks");
  });

  it("exposes executable entry points through the workspace package", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["test:e2e:docker"]).toBe("bash scripts/run-e2e-container.sh");
    expect(statSync(resolve(repoRoot, "scripts/run-e2e-container.sh")).mode & 0o111).not.toBe(0);
    expect(statSync(resolve(repoRoot, "scripts/e2e-cli.sh")).mode & 0o111).not.toBe(0);
  });

  it("runs as a bounded CI job after the fast checks", () => {
    const workflow = readRepoFile(".github/workflows/ci.yml");
    const agentGuide = readRepoFile("AGENTS.md");

    expect(workflow).toContain("docker-e2e:");
    expect(workflow).toContain("needs: check");
    expect(workflow).toContain("timeout-minutes: 15");
    expect(workflow).toContain("run: bash scripts/run-e2e-container.sh");
    expect(agentGuide).toContain("pnpm test:e2e:docker");
    expect(agentGuide).toContain("clean committed snapshot");
  });
});
