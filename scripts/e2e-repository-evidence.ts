import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const [root, bin] = process.argv.slice(2);
assert.ok(root && bin);
mkdirSync(root);
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
function cli(args: string[], status = 0) {
  const run = spawnSync(bin, args, { cwd: root, encoding: "utf8" });
  assert.equal(run.status, status, run.stderr + "\n" + run.stdout);
  return run.stdout;
}
const json = (args: string[], status = 0) => JSON.parse(cli([...args, "--json"], status));
const commit = () => {
  git("add", "release.txt");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    "Release workflow",
  );
  return git("rev-parse", "HEAD");
};
const source = join(root, "release.txt");
git("init", "--quiet");
cli(["init", "--untracked"]);
writeFileSync(source, "pnpm release:quartz\n");
const reviewed = commit();
const add = (title: string, ref: string, body: string) => {
  const output = cli([
    "add",
    "--title",
    title,
    "--pinned",
    "--source-type",
    "file",
    "--source-ref",
    ref,
    body,
  ]);
  const id = /Added \[([0-9a-z]+)\]/.exec(output)?.[1];
  assert.ok(id, output);
  return id;
};
const original = add(
  "Quartz release command",
  `git:${reviewed}:release.txt`,
  "Run pnpm release:quartz.",
);
const legacy = add("Existing file reference", "release.txt", "Read the migration report.");
const canonical = join(root, ".engram", "engrams");
const originalPath = join(
  canonical,
  readdirSync(canonical).find((name) => name.startsWith(original))!,
);
const before = readFileSync(originalPath, "utf8");
assert.equal(json(["evidence", original]).status, "unchanged");
assert.equal(json(["evidence", legacy]).reason, "missing_or_invalid_reviewed_revision");

writeFileSync(source, "pnpm publish:quartz\n");
const uncommitted = json(["evidence", original]);
assert.equal(uncommitted.status, "changed");
assert.equal(uncommitted.checkoutRevision, null);
assert.equal(uncommitted.change.reviewed.text, "pnpm release:quartz");
assert.equal(uncommitted.change.checkout.text, "pnpm publish:quartz");
assert.equal(cli(["evidence", original, "--propose", "Run pnpm publish:quartz."], 1), "");

unlinkSync(source);
symlinkSync(originalPath, source);
assert.equal(json(["evidence", original]).reason, "checkout_file_unavailable");
unlinkSync(source);
writeFileSync(source, "pnpm publish:quartz\n");
const head = commit();

const stage = () => {
  const report = json(["evidence", original, "--propose", "Run pnpm publish:quartz."]);
  assert.equal(report.checkoutRevision, head);
  assert.equal(report.status, "changed");
  assert.match(report.pendingId, /^pending-/);
  return report.pendingId as string;
};
const queuePath = (id: string) => join(root, ".engram", "pending", id + ".json");
const rejected = stage();
assert.equal(
  json(["pending", "reject", rejected, "--scope", "project"]).results[0].status,
  "rejected",
);
assert.equal(existsSync(queuePath(rejected)), false);
assert.equal(readFileSync(originalPath, "utf8"), before);

const pending = stage();
const competing = stage();
const saved = JSON.parse(readFileSync(queuePath(pending), "utf8"));
assert.equal(saved.correction.originalId, original);
assert.equal(saved.correction.sourceRef, `git:${head}:release.txt`);
assert.equal(readFileSync(originalPath, "utf8"), before);
assert.equal(readdirSync(canonical).length, 2);
const restarted = json(["pending", "show", pending, "--scope", "project"]);
assert.equal(restarted.results[0].candidate.proposed.body, "Run pnpm publish:quartz.");
const preview = json(["pending", "approve", pending, "--scope", "project", "--dry-run"]).results[0];
assert.equal(preview.status, "preview");
assert.match(preview.markdown, new RegExp("supersedes: " + original));
assert.match(preview.markdown, /pinned: true/);
assert.equal(readFileSync(originalPath, "utf8"), before);
const approved = json([
  "pending",
  "approve",
  pending,
  "--scope",
  "project",
  "--yes",
  "--expect",
  preview.revision,
]).results[0];
assert.equal(approved.status, "approved");
assert.equal(existsSync(queuePath(pending)), false);
assert.equal(readdirSync(canonical).length, 3);
assert.match(readFileSync(originalPath, "utf8"), /status: superseded/);
const replacementPath = join(
  canonical,
  readdirSync(canonical).find((name) => name.startsWith(approved.canonicalId))!,
);
assert.equal(readFileSync(replacementPath, "utf8"), preview.markdown);
assert.equal(json(["evidence", approved.canonicalId]).status, "unchanged");
const blocked = json(["pending", "approve", competing, "--scope", "project", "--yes"], 1);
assert.equal(blocked.results[0].status, "failed");
assert.match(blocked.results[0].message, /The original changed after staging/);
assert.equal(existsSync(queuePath(competing)), true);
assert.equal(readdirSync(canonical).length, 3);
console.log("Repository evidence correction persisted through explicit approval");
