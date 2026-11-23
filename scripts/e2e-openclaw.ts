import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [root, bin] = process.argv.slice(2);
assert.ok(root && bin);

const workspace = join(root, "work workspace");
const otherWorkspace = join(root, "personal workspace");
const checkout = join(root, "project checkout");
const host = join(root, "openclaw-state");
const config = join(host, "openclaw.json");
const skill = join(workspace, "skills", "engram-project-memory", "SKILL.md");
const otherSkill = join(otherWorkspace, "skills", "engram-project-memory", "SKILL.md");
const personalMemory = join(otherWorkspace, "MEMORY.md");
const hostMemory = join(workspace, "MEMORY.md");
const read = (file: string) => readFileSync(file, "utf8");

for (const directory of [workspace, checkout, otherWorkspace, host]) {
  mkdirSync(directory, { recursive: true });
}
writeFileSync(personalMemory, "# Private notes\nPersonal-only reminder.\n");
writeFileSync(hostMemory, "# Work agent's native memory\nA personal preference.\n");
const settings = `{
  // Keep JSON5 comments and owner choices.
  agents: {
    ownership: "explicit",
    defaults: { workspace: ${JSON.stringify(otherWorkspace)} },
    entries: {
      personal: {},
      work: { workspace: ${JSON.stringify(workspace)}, skills: ["engram-project-memory"] },
    },
  },
  memory: { search: { provider: "openai", extraPaths: ["memory/reference.md"] } },
  plugins: { slots: { memory: "memory-core" } },
}\n`;
writeFileSync(config, settings);

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, OPENCLAW_STATE_DIR: host, OPENCLAW_CONFIG_PATH: config },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + "\n" + result.stdout);
  return result.stdout;
}
const install = (...args: string[]) =>
  run(bin, ["install", "openclaw", "--root", workspace, ...args], checkout);
const git = (...args: string[]) => run("git", args, checkout);
const engram = (...args: string[]) => run(bin, args, checkout);

assert.match(install("--dry-run"), /write skills\/engram-project-memory\/SKILL\.md/);
assert.deepEqual(readdirSync(workspace), ["MEMORY.md"]);
assert.equal(read(config), settings);

assert.match(install("--yes"), /Installed 1 change\(s\) for openclaw/);
const installed = read(skill);
assert.match(installed, /^---\nname: engram-project-memory\n/);
assert.match(installed, /engram context --scope project/);
assert.match(installed, /engram search --scope project/);
assert.equal(read(config), settings);
assert.equal(existsSync(otherSkill), false);
assert.equal(existsSync(join(checkout, "skills")), false);

git("init", "-q");
engram("init", "--tracked");
assert.match(
  engram(
    "add",
    "--scope",
    "project",
    "--title",
    "Project retry policy",
    "--",
    "Retry only idempotent jobs.",
  ),
  /Project retry policy/,
);
const canonical = join(checkout, ".engram", "engrams");
const entries = readdirSync(canonical);
assert.equal(entries.length, 1);
const memory = join(canonical, entries[0]);
const recorded = read(memory);
assert.match(recorded, /Retry only idempotent jobs/);
git("add", ".engram");
assert.match(git("ls-files", ".engram/engrams"), /project-retry-policy\.md/);
engram(
  "add",
  "--scope",
  "personal",
  "--title",
  "Personal retry note",
  "--",
  "Private idempotent job.",
);
const projectContext = engram("context", "--scope", "project", "--limit", "5");
assert.match(projectContext, /Project retry policy/);
assert.doesNotMatch(projectContext, /Personal retry note/);
const projectSearch = engram("search", "--scope", "project", "--limit", "5", "--", "idempotent");
assert.match(projectSearch, /Project retry policy/);
assert.doesNotMatch(projectSearch, /Personal retry note/);
const id = /^id:\s*(\S+)/m.exec(recorded)?.[1];
assert.ok(id);
assert.match(engram("show", "--scope", "project", id), /Retry only idempotent jobs/);

const editedSettings = settings.replace(
  '"memory/reference.md"',
  '"memory/reference.md", "memory/user-added.md"',
);
writeFileSync(config, editedSettings);
const noteInSkillDirectory = join(workspace, "skills", "engram-project-memory", "notes.txt");
writeFileSync(noteInSkillDirectory, "User-owned sibling.\n");
assert.match(install("--yes"), /already up to date/);
assert.equal(read(skill), installed);
assert.match(
  install("--dry-run", "--uninstall"),
  /remove skills\/engram-project-memory\/SKILL\.md/,
);
assert.equal(read(skill), installed);
assert.match(install("--yes", "--uninstall"), /Uninstalled 1 change\(s\) for openclaw/);
assert.equal(existsSync(skill), false);
assert.equal(read(noteInSkillDirectory), "User-owned sibling.\n");
assert.equal(read(config), editedSettings);
assert.equal(read(personalMemory), "# Private notes\nPersonal-only reminder.\n");
assert.equal(read(hostMemory), "# Work agent's native memory\nA personal preference.\n");
assert.equal(read(memory), recorded);
