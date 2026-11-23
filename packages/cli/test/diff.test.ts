import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
});
