import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [root, bin, pendingFixture] = process.argv.slice(2);
assert.ok(root && bin && pendingFixture);

const home = join(root, "hermes");
const profile = join(home, "profiles", "work");
const checkout = join(root, "project checkout");
const config = join(profile, "config.yaml");
const skill = join(profile, "skills", "engram-project-memory", "SKILL.md");
const user = join(profile, "memories", "USER.md");
const native = join(profile, "memories", "MEMORY.md");
const personal = join(home, "memories", "MEMORY.md");
const settings =
  "memory:\n  provider: test-selected\nterminal:\n  backend: ssh\nmodel:\n  provider: custom\n  base_url: https://example.invalid/v1\n";
const read = (file: string) => readFileSync(file, "utf8");

for (const dir of [checkout, join(profile, "memories"), join(home, "memories")]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(config, settings);
writeFileSync(user, "Work profile user preferences.\n");
writeFileSync(native, "Work profile personal memory.\n");
writeFileSync(personal, "Default profile personal memory.\n");

function run(command: string, args: string[], status = 0) {
  const result = spawnSync(command, args, {
    cwd: checkout,
    encoding: "utf8",
    env: { ...process.env, HERMES_HOME: home },
  });
  assert.ifError(result.error);
  assert.equal(result.status, status, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return result;
}
const install = (...args: string[]) => run(bin, ["install", "hermes", "--root", profile, ...args]);
const engram = (...args: string[]) => run(bin, args).stdout;
const expectPreserved = (configContents: string) => {
  assert.equal(read(config), configContents);
  assert.equal(read(user), "Work profile user preferences.\n");
  assert.equal(read(native), "Work profile personal memory.\n");
  assert.equal(read(personal), "Default profile personal memory.\n");
  assert.equal(existsSync(join(home, "skills")), false);
  assert.equal(existsSync(join(checkout, "skills")), false);
};

assert.match(run(bin, ["install", "hermes", "--yes"], 1).stderr, /--root/);
assert.match(install("--dry-run").stdout, /write skills\/engram-project-memory\/SKILL\.md/);
assert.equal(existsSync(join(profile, "skills")), false);
expectPreserved(settings);

assert.match(install("--yes").stdout, /Installed 1 change\(s\) for hermes/);
const installed = read(skill);
assert.match(installed, /^---\nname: engram-project-memory\ndescription: [^\n]+\n---\n/);
assert.match(install("--status").stdout, /SKILL\.md: current/);
assert.match(installed, /local shell outside Hermes/);
assert.match(installed, /Never execute these commands through Hermes tools/);
assert.match(installed, /Never read project memory files into Hermes/);
assert.doesNotMatch(installed, /EXTERNALLY-NOT-VISIBLE/);
expectPreserved(settings);

// The skill is static guidance. Run its commands as the user in a separate shell.
run("git", ["init", "-q"]);
engram("init", "--tracked");
assert.match(
  engram(
    "add",
    "--scope",
    "project",
    "--title",
    "Idempotent retry policy",
    "--",
    "EXTERNALLY-NOT-VISIBLE retry detail.",
  ),
  /Idempotent retry policy/,
);
engram(
  "add",
  "--scope",
  "personal",
  "--title",
  "Personal retry note",
  "--",
  "Personal retry detail.",
);
const canonical = join(checkout, ".engram", "engrams");
const entries = readdirSync(canonical);
assert.equal(entries.length, 1);
const memory = join(canonical, entries[0]);
const recorded = read(memory);
const id = /^id:\s*(\S+)/m.exec(recorded)?.[1];
assert.ok(id);
run("git", ["add", ".engram"]);
assert.match(run("git", ["ls-files", ".engram/engrams"]).stdout, /idempotent-retry-policy\.md/);
const results = engram("search", "--scope", "project", "--limit", "5", "--", "retry");
assert.match(results, /Idempotent retry policy/);
assert.doesNotMatch(results, /Personal retry note/);
assert.match(engram("show", "--scope", "project", id), /EXTERNALLY-NOT-VISIBLE retry detail/);
assert.equal(read(skill), installed);

const candidate = JSON.parse(
  run(process.execPath, [pendingFixture, "write", "project", "Hermes fixture"]).stdout,
);
const queued = join(checkout, ".engram", "pending", candidate.id + ".json");
const pending = read(queued);
assert.match(engram("pending", "list", "--scope", "project"), /Hermes fixture/);
assert.match(engram("pending", "show", "--scope", "project", candidate.id), /Hermes fixture/);
const preview = JSON.parse(
  engram("pending", "approve", "--scope", "project", "--dry-run", candidate.id, "--json"),
);
assert.equal(preview.results[0].status, "preview");
assert.match(preview.results[0].markdown, /Hermes fixture/);
assert.deepEqual(readdirSync(canonical), entries);
assert.equal(read(queued), pending);

const editedConfig = settings + "# User edit after installation.\n";
writeFileSync(config, editedConfig);
const sibling = join(profile, "skills", "engram-project-memory", "notes.txt");
writeFileSync(sibling, "Keep this unrelated file.\n");
assert.match(install("--yes").stdout, /already up to date/);
const editedSkill = installed + "\nUser edit.\n";
writeFileSync(skill, editedSkill);
for (const args of [[], ["--uninstall"]]) {
  const refused = run(bin, ["install", "hermes", "--root", profile, "--yes", ...args], 1);
  assert.match(refused.stderr, /blocked asset.*local edits/);
  assert.equal(read(skill), editedSkill);
}
writeFileSync(skill, installed);
assert.match(
  install("--uninstall", "--dry-run").stdout,
  /remove skills\/engram-project-memory\/SKILL\.md/,
);
assert.equal(read(skill), installed);
assert.match(install("--uninstall", "--yes").stdout, /Uninstalled 1 change\(s\) for hermes/);
assert.equal(existsSync(skill), false);
assert.equal(read(sibling), "Keep this unrelated file.\n");
expectPreserved(editedConfig);
assert.equal(read(memory), recorded);
assert.equal(read(queued), pending);
