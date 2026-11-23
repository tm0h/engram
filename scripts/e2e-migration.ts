import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const [root, bin] = process.argv.slice(2);
assert.ok(root && bin);
mkdirSync(root);
function cli(args: string[], status = 0) {
  const result = spawnSync(bin, args, { cwd: root, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, status, result.stderr + "\n" + result.stdout);
  return result;
}
const json = (args: string[], status = 0) => JSON.parse(cli([...args, "--json"], status).stdout);
const write = (file: string, text: string) => writeFileSync(join(root, file), text);
const read = (file: string) => readFileSync(join(root, file), "utf8");
const begin = "<!-- BEGIN: engram-memory-digest -->";
const end = "<!-- END: engram-memory-digest -->";
const fakeSecret = "password=synthetic-fixture-value";
const sources = {
  "AGENTS.md":
    "# Workspace\r\n\r\n## Package manager\r\nUse Yarn for builds.\r\n## Checkouts\r\nUse linked worktrees for independent tasks.\r\n",
  "CLAUDE.md":
    "# Local helpers\n\n## Formatting\nUse two spaces in scripts.\n## Private fixture\n" +
    fakeSecret +
    "\n",
  ".cursor/rules/fixtures.mdc":
    "---\ndescription: Fixture rules\nglobs: tests/**\n---\nUse fixture builders for tests.\n",
  "README.md":
    "# Sample\n\nGeneric marketing information.\n\n## Conventions\n\nUse small commits.\n\n### Tests\nUse synthetic fixtures.\n\n## Installation\n\nThis section is outside scope.\n",
  "hermes/MEMORY.md": "A section sign § inside an entry.\n§\nThe dev database is named Quartz.\n",
  "openclaw/MEMORY.md": "# Memory\n\n## Release notes\nKeep a rollback log.\n",
  "openclaw/memory/2026-10-05-release.md": "# Release log\n\nConfirmed rollback in staging.\n",
};
mkdirSync(join(root, ".cursor", "rules"), { recursive: true });
mkdirSync(join(root, "hermes"));
mkdirSync(join(root, "openclaw", "memory"), { recursive: true });
for (const [file, contents] of Object.entries(sources)) write(file, contents);

cli(["init", "--untracked"]);
cli([
  "add",
  "--title",
  "Package manager",
  "--type",
  "decision",
  "--pinned",
  "Use pnpm for builds.",
]);
cli(["add", "--title", "Formatting", "--type", "decision", "Use two spaces in scripts."]);
cli(["add", "--scope", "personal", "--title", "Personal fixture", "Only for personal memory."]);
cli([
  "add",
  "--title",
  "Scoped fixture",
  "--applies-to",
  "fixtures/**",
  "Keep scoped guidance local.",
]);
cli(["add", "--title", "Archived fixture", "--status", "archived", "Keep history out of startup."]);
cli(["add", "--title", "Long fixture", "reference ".repeat(400)]);
const canonical = ".engram/engrams";
const snapshot = () =>
  readdirSync(join(root, canonical))
    .sort()
    .map((file) => [file, read(join(canonical, file))]);
const before = snapshot();
const queue = join(root, ".engram", "pending");
const projectFiles = Object.keys(sources).slice(0, 4);

const preview = json(["import", ...projectFiles], 1);
assert.equal(preview.phase, "preview");
assert.deepEqual(
  preview.results.map((row: { status: string }) => row.status),
  ["skipped", "eligible", "skipped", "rejected", "eligible", "eligible", "eligible"],
);
assert.deepEqual(
  preview.results
    .filter((row: { reason?: string }) => row.reason)
    .map((row: { reason: string }) => row.reason),
  ["possible_conflict", "exact_duplicate", "sensitive_content"],
);
assert.ok(!JSON.stringify(preview).includes(fakeSecret));
assert.ok(!JSON.stringify(preview).includes("outside scope"));
assert.ok(!existsSync(queue));
assert.deepEqual(snapshot(), before);

const apply = cli(["import", ...projectFiles, "missing/AGENTS.md", "--apply", "--json"], 1);
assert.match(apply.stderr, /eligible.*Checkouts/);
assert.ok(!(apply.stdout + apply.stderr).includes(fakeSecret));
const applied = JSON.parse(apply.stdout);
assert.deepEqual(
  applied.results.map((row: { status: string }) => row.status),
  ["skipped", "staged", "skipped", "rejected", "staged", "staged", "staged", "failed"],
);
assert.equal(
  json(["import", ...projectFiles, "--apply"], 1).results.filter(
    (row: { status: string }) => row.status === "staged",
  ).length,
  0,
);

const hermes = json([
  "import",
  "hermes/MEMORY.md",
  "--format",
  "hermes",
  "--scope",
  "personal",
  "--apply",
]);
assert.equal(hermes.results.length, 2);
const openclaw = json([
  "import",
  "openclaw/MEMORY.md",
  "openclaw/memory/2026-10-05-release.md",
  "--format",
  "openclaw",
  "--scope",
  "project",
  "--apply",
]);
assert.equal(openclaw.results.length, 2);
const pending = readdirSync(queue)
  .filter((file) => file.endsWith(".json"))
  .map((file) => JSON.parse(read(join(".engram", "pending", file))));
assert.equal(pending.length, 6);
const cursor = pending.find((row) => row.importSource.format === "cursor");
assert.match(cursor.proposed.body, /globs: tests\/\*\*/);
assert.match(cursor.proposed.body, /Use fixture builders for tests/);
const checkout = pending.find((row) => row.proposed.title === "Checkouts");
assert.deepEqual(checkout.importSource, { format: "agents", path: "AGENTS.md", line: 5 });
assert.equal(checkout.proposed.body, "Use linked worktrees for independent tasks.");
assert.equal(checkout.provenanceClass, "file");
const personal = hermes.results.map((row: { id: string }) =>
  JSON.parse(readFileSync(join(process.env.HOME!, ".engram", "pending", row.id + ".json"), "utf8")),
);
assert.equal(personal[0].proposed.body, "A section sign § inside an entry.");
assert.equal(personal[1].importSource.line, 3);

for (const [file, contents] of Object.entries(sources)) assert.equal(read(file), contents, file);
assert.deepEqual(snapshot(), before);

write(
  "handwritten.md",
  "# Manual 🌱\r\nTrailing spaces  \r\n" + begin + "\r\nOld digest\r\n" + end + "\r\n\r\nAfter\r\n",
);
chmodSync(join(root, "handwritten.md"), 0o640);
write("no-newline.md", "# Original without newline");
write("malformed.md", "# Keep this\n" + begin + "\nUser instructions\n");
const fenced = "```md\n" + begin + "\nExample block\n" + end + "\n```\n";
write("fenced.md", fenced);
writeFileSync(join(root, "invalid-utf8.md"), Buffer.from([0xff, 0x0a]));
symlinkSync(join(root, "CLAUDE.md"), join(root, "link.md"));
const exported = json(
  [
    "export",
    "handwritten.md",
    "malformed.md",
    "invalid-utf8.md",
    "link.md",
    "fenced.md",
    "new.md",
    "no-newline.md",
  ],
  1,
);
assert.deepEqual(
  exported.results.map((row: { status: string }) => row.status),
  ["written", "failed", "failed", "failed", "failed", "written", "written"],
);
const digest = read("new.md");
assert.ok(digest.startsWith(begin + "\n# Engram context (project)\n"));
assert.ok(digest.endsWith(end + "\n"));
assert.ok(digest.includes("Use pnpm for builds."));
assert.ok(!digest.includes("Personal fixture"));
assert.ok(!digest.includes("linked worktrees"));
assert.ok(!digest.includes("Scoped fixture"));
assert.ok(!digest.includes("Archived fixture"));
assert.ok(digest.includes("[truncated]"));
assert.ok(Buffer.byteLength(digest) <= 2_048 + begin.length + end.length + 3);
assert.equal(read("no-newline.md"), "# Original without newline\n" + digest.slice(0, -1));
assert.equal(statSync(join(root, "handwritten.md")).mode & 0o777, 0o640);
assert.equal(
  read("handwritten.md"),
  "# Manual 🌱\r\nTrailing spaces  \r\n" + digest.slice(0, -1) + "\r\n\r\nAfter\r\n",
);
const updated = read("handwritten.md");
assert.equal(read("fenced.md"), fenced);
assert.equal(read("malformed.md"), "# Keep this\n" + begin + "\nUser instructions\n");
assert.deepEqual(readFileSync(join(root, "invalid-utf8.md")), Buffer.from([0xff, 0x0a]));
assert.deepEqual(
  json(["export", "handwritten.md", "new.md", "no-newline.md"]).results.map(
    (row: { status: string }) => row.status,
  ),
  ["unchanged", "unchanged", "unchanged"],
);
assert.equal(read("handwritten.md"), updated);
assert.equal(read("new.md"), digest);
assert.equal(read("no-newline.md"), "# Original without newline\n" + digest.slice(0, -1));
for (const [file, contents] of Object.entries(sources)) assert.equal(read(file), contents, file);
assert.deepEqual(snapshot(), before);

cli([
  "pending",
  "edit",
  checkout.id,
  "--scope",
  "project",
  "--patch",
  '{"body":"Keep unrelated changes in linked worktrees."}',
]);
assert.equal(json(["import", "AGENTS.md", "--apply"]).results[1].reason, "exact_duplicate");
cli(["pending", "approve", checkout.id, "--scope", "project", "--yes"]);
assert.equal(snapshot().length, before.length + 1);
assert.ok(snapshot().some(([, text]) => text.includes("sourceRef: AGENTS.md#L5")));
assert.equal(json(["import", "AGENTS.md", "--apply"]).results[1].reason, "already_imported");
