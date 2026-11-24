import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { stringifyFrontmatter } from "@engram/core";
import { compareProjectMemory } from "../src/memory-diff.js";

let repo: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const put = (name: string, id: string, fields: Record<string, unknown> = {}) =>
  writeFileSync(
    join(repo, ".engram/engrams", name),
    stringifyFrontmatter("Synthetic claim.", {
      id,
      title: "Synthetic title",
      type: "note",
      scope: "project",
      tags: [],
      created: "2025-01-01T00:00:00Z",
      updated: "2025-01-01T00:00:00Z",
      ...fields,
    }),
  );

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "engram-diff-"));
  git("init", "--quiet");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Diff Fixture");
  git("commit", "--quiet", "--allow-empty", "-m", "Before memory");
  mkdirSync(join(repo, ".engram/engrams"), { recursive: true });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function commit() {
  git("add", ".");
  git("commit", "--quiet", "-m", "Snapshot");
  return git("rev-parse", "HEAD");
}

describe("project memory diff", () => {
  it("compares parsed fields and stored lifecycle by ID across a rename", async () => {
    put("0001-original.md", "0001", { custom: { a: 1, b: 2 } });
    const from = commit();
    rmSync(join(repo, ".engram/engrams/0001-original.md"));
    put("unusual\nname.md", "0001", {
      status: "archived",
      reviewAfter: "2025-02-01T00:00:00Z",
      custom: { b: 2, a: 1 },
    });
    const report = await compareProjectMemory(repo, undefined, 100);
    expect(report.from).toEqual({ kind: "commit", sha: from });
    expect(report.totals).toMatchObject({
      changed: 1,
      added: 0,
      removed: 0,
      renamed: 1,
      edited: 0,
    });
    expect(report.changes[0]).toMatchObject({
      id: "0001",
      kind: "modified",
      renamed: true,
      lifecycle: { status: { before: null, after: "archived" } },
    });
  });

  it("does not guess through duplicate claims or a malformed file with an unknown ID", async () => {
    put("one.md", "0001");
    put("two.md", "0002");
    put("three.md", "0003");
    commit();
    put("duplicate.md", "0001", { type: "no-such-type" });
    writeFileSync(join(repo, ".engram/engrams/two.md"), "broken");
    put("three.md", "0003", { pinned: true });
    const report = await compareProjectMemory(repo, undefined, 100);
    expect(report.complete).toBe(false);
    expect(report.totals).toMatchObject({ removed: 0, changed: 1, indeterminate: 2 });
    expect(report.changes.map(({ id }) => id)).toEqual(["0003"]);
    expect(report.diagnostics.map(({ code }) => code)).toContain("duplicate_id");
  });

  it("compares absent historical stores as empty and keeps counts when details are capped", async () => {
    const from = git("rev-parse", "HEAD");
    put("0002-second.md", "0002");
    put("0001-first.md", "0001");
    const to = commit();
    const report = await compareProjectMemory(repo, `${from}..${to}`, 1);
    expect(report.complete).toBe(true);
    expect(report.totals).toMatchObject({ changed: 2, added: 2 });
    expect(report.omitted).toEqual({ changes: 1, diagnostics: 0 });
    expect(report.changes.map(({ id }) => id)).toEqual(["0001"]);
  });

  it("scopes nested projects and refuses symlink candidates from Git and disk", async () => {
    const nested = join(repo, "nested[project]");
    const memory = join(nested, ".engram/engrams");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(nested, ".engram/config.json"), "{}");
    put("0001-root.md", "0001");
    symlinkSync(join(repo, ".engram/engrams/0001-root.md"), join(memory, "0001-link.md"));
    const from = commit();
    const report = await compareProjectMemory(nested, undefined, 100);
    expect(report.project).toBe("nested[project]");
    expect(report.totals).toMatchObject({ changed: 0, indeterminate: 1 });
    expect(report.diagnostics).toEqual([
      {
        side: "from",
        path: "nested[project]/.engram/engrams/0001-link.md",
        code: "file_unreadable",
        severity: "error",
      },
      {
        side: "to",
        path: "nested[project]/.engram/engrams/0001-link.md",
        code: "file_unreadable",
        severity: "error",
      },
    ]);
    rmSync(memory, { recursive: true });
    symlinkSync(join(repo, ".engram/engrams"), memory, "dir");
    const linked = await compareProjectMemory(nested, from, 100);
    expect(linked.diagnostics).toContainEqual({
      side: "to",
      path: "nested[project]/.engram/engrams",
      code: "snapshot_unreadable",
      severity: "error",
    });
    expect(linked.changes).toEqual([]);
  });

  it("rejects missing endpoints, ambiguous names, and noncommit refs", async () => {
    git("tag", "ambiguous");
    git("branch", "ambiguous");
    const tree = git("rev-parse", "HEAD^{tree}");
    await expect(compareProjectMemory(repo, "ambiguous", 100)).rejects.toThrow("unique commit");
    await expect(compareProjectMemory(repo, tree, 100)).rejects.toThrow("unique commit");
    await expect(compareProjectMemory(repo, "HEAD..", 100)).rejects.toThrow("both range endpoints");
  });

  it("batches and deduplicates committed blob reads while preserving oversized diagnostics", async () => {
    for (let index = 1; index <= 120; index++) {
      const id = String(index).padStart(4, "0");
      put(`${id}-entry.md`, id);
    }
    writeFileSync(join(repo, ".engram/engrams/0121-oversized.md"), "x".repeat(1024 * 1024 + 1));
    put("0122-readable.md", "0122");
    const from = commit();
    put("0122-readable.md", "0122", { pinned: true });
    const to = commit();

    const toolDir = mkdtempSync(join(tmpdir(), "engram-diff-git-"));
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const log = join(toolDir, "requests");
    const wrapper = join(toolDir, "git");
    writeFileSync(
      wrapper,
      `#!/bin/sh
if [ "$1" = "cat-file" ] && [ "$2" = "--batch-command" ]; then
  printf 'batch\n' >> "${log}"
  tee -a "${log}" | "${realGit}" "$@"
else
  exec "${realGit}" "$@"
fi
`,
    );
    chmodSync(wrapper, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = toolDir + ":" + oldPath;
    try {
      const report = await compareProjectMemory(repo, `${from}..${to}`, 100);
      expect(report.complete).toBe(false);
      expect(report.changes).toMatchObject([{ id: "0122", edited: true }]);
      expect(report.diagnostics).toEqual([
        {
          side: "from",
          path: ".engram/engrams/0121-oversized.md",
          code: "file_unreadable",
          severity: "error",
        },
        {
          side: "to",
          path: ".engram/engrams/0121-oversized.md",
          code: "file_unreadable",
          severity: "error",
        },
      ]);
      const requests = readFileSync(log, "utf8").trim().split("\n");
      expect(requests.filter((line) => line === "batch")).toHaveLength(1);
      const infos = requests.filter((line) => line.startsWith("info "));
      expect(infos).toHaveLength(123);
      expect(new Set(infos).size).toBe(infos.length);
      expect(requests.filter((line) => line.startsWith("contents "))).toHaveLength(122);
    } finally {
      process.env.PATH = oldPath;
      rmSync(toolDir, { recursive: true, force: true });
    }
  });

  it("continues comparing readable blobs when an object is missing", async () => {
    put("0001-missing.md", "0001");
    put("0002-readable.md", "0002");
    const from = commit();
    put("0002-readable.md", "0002", { pinned: true });
    const to = commit();
    const blob = git("rev-parse", `${from}:.engram/engrams/0001-missing.md`);
    rmSync(join(repo, ".git/objects", blob.slice(0, 2), blob.slice(2)));

    const report = await compareProjectMemory(repo, `${from}..${to}`, 100);
    expect(report.complete).toBe(false);
    expect(report.totals).toMatchObject({ changed: 1, indeterminate: 1 });
    expect(report.changes).toMatchObject([{ id: "0002", edited: true }]);
    expect(report.diagnostics.map(({ code }) => code)).toEqual([
      "file_unreadable",
      "file_unreadable",
    ]);
  });

  it("falls back to bounded blob reads when batch-command is unavailable", async () => {
    put("0001-entry.md", "0001");
    const from = commit();
    put("0001-entry.md", "0001", { pinned: true });
    const to = commit();

    const toolDir = mkdtempSync(join(tmpdir(), "engram-diff-legacy-git-"));
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const wrapper = join(toolDir, "git");
    writeFileSync(
      wrapper,
      `#!/bin/sh
if [ "$1" = "cat-file" ] && [ "$2" = "--batch-command" ]; then
  exit 129
fi
exec "${realGit}" "$@"
`,
    );
    chmodSync(wrapper, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = toolDir + ":" + oldPath;
    try {
      const report = await compareProjectMemory(repo, `${from}..${to}`, 100);
      expect(report.complete).toBe(true);
      expect(report.changes).toMatchObject([{ id: "0001", edited: true }]);
    } finally {
      process.env.PATH = oldPath;
      rmSync(toolDir, { recursive: true, force: true });
    }
  });
});
