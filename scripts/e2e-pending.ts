import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [scenario, root, fixture] = process.argv.slice(2);
const bin = process.env.ENGRAM_E2E_BIN;
assert.ok(scenario && root && fixture && bin);
mkdirSync(root);
process.chdir(root);

function cli(args: string[], status = 0, input = "") {
  const run = spawnSync(bin!, args, { encoding: "utf8", input });
  assert.ifError(run.error);
  assert.equal(run.status, status, `${args.join(" ")}\n${run.stderr}\n${run.stdout}`);
  return run;
}

function approvalAttempt(id: string, onPreview = () => {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(bin!, ["pending", "approve", id, "--yes", "--json"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let previewed = false;
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
        if (!previewed && stderr.includes("Approval preview for")) {
          previewed = true;
          try {
            onPreview();
          } catch (error) {
            child.kill();
            reject(error);
          }
        }
      });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    },
  );
}

interface ReviewResult {
  id: string;
  scope: string;
  status: string;
  code?: string;
  message?: string;
  canonicalId?: string;
  markdown?: string;
  revision?: string;
  candidate?: Seed;
  findings?: Array<{ rule: string }>;
}
interface Seed {
  id: string;
  created: string;
  scope: "project" | "personal";
  sourceExcerpt: string;
  provenanceClass: string;
  proposed: { title: string; type: string; body: string; tags: string[] };
}

function rows(stdout: string): ReviewResult[] {
  const report = JSON.parse(stdout);
  assert.equal(report.schemaVersion, 1);
  assert.ok(Array.isArray(report.results));
  return report.results;
}

function review(args: string[], status = 0, input = "") {
  return rows(cli(["pending", ...args, "--json"], status, input).stdout);
}

function seed(title: string, scope: Seed["scope"] = "project"): Seed {
  const result = spawnSync(process.execPath, [fixture, "write", scope, title], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function pendingPath(candidate: Seed) {
  const base = candidate.scope === "project" ? root : homedir();
  return join(base, ".engram", "pending", candidate.id + ".json");
}

const storeDir = join(root, ".engram", "engrams");
const publishedFiles = () => readdirSync(storeDir).filter((file) => file.endsWith(".md"));
function save(candidate: Seed) {
  // Emulate locally edited or malformed queue files that bypass intake.
  writeFileSync(pendingPath(candidate), JSON.stringify(candidate));
}

cli(["init", "--untracked"]);
assert.deepEqual(publishedFiles(), []);

switch (scenario) {
  case "approval": {
    const proposal = seed("Cinnabar");
    const personal = seed("Cerulean", "personal");
    const before = readFileSync(pendingPath(proposal), "utf8");
    const listed = review(["list", "--scope", "all"]);
    assert.deepEqual(
      listed.map(({ scope, id, status }) => [scope, id, status]),
      [
        ["project", proposal.id, "pending"],
        ["personal", personal.id, "pending"],
      ],
    );
    assert.deepEqual(review(["show", proposal.id])[0].candidate, proposal);
    assert.equal(
      review(["show", personal.id, "--scope", "personal"])[0].candidate?.id,
      personal.id,
    );
    assert.match(cli(["pending", "list"]).stdout, /quartzpending Cinnabar/);
    assert.match(cli(["pending", "show", proposal.id]).stdout, /A violet adapter was discussed/);
    assert.equal(JSON.parse(cli(["search", "Cinnabar", "--json"]).stdout).total, 0);
    const noConsent = cli(["pending", "approve", proposal.id, "--json"], 1);
    assert.match(JSON.parse(noConsent.stdout).error.message, /--yes/);
    const [preview] = review(["approve", proposal.id, "--dry-run"]);
    assert.equal(preview.status, "preview");
    assert.ok(preview.markdown?.includes("sourceType: conversation"));
    assert.ok(preview.markdown?.includes(proposal.created));
    assert.ok(preview.markdown?.includes(`sourceRef: ${proposal.id}`));
    assert.ok(!preview.markdown?.includes(proposal.sourceExcerpt));
    assert.equal(readFileSync(pendingPath(proposal), "utf8"), before);
    assert.deepEqual(publishedFiles(), []);
    assert.ok(preview.revision);
    const actual = cli([
      "pending",
      "approve",
      proposal.id,
      "--yes",
      "--expect",
      preview.revision,
      "--json",
    ]);
    const [approved] = rows(actual.stdout);
    assert.equal(approved.status, "approved");
    assert.equal(approved.canonicalId, preview.canonicalId);
    assert.ok(actual.stderr.includes(preview.markdown!));
    assert.equal(existsSync(pendingPath(proposal)), false);
    assert.equal(existsSync(pendingPath(personal)), true);
    assert.equal(publishedFiles().length, 1);
    assert.equal(readFileSync(join(storeDir, publishedFiles()[0]), "utf8"), preview.markdown);
    assert.equal(JSON.parse(cli(["search", "Cinnabar", "--json"]).stdout).total, 1);
    assert.equal(JSON.parse(cli(["review", "--json"]).stdout).version, 1);

    const [personalPreview] = review(["approve", personal.id, "--scope", "personal", "--dry-run"]);
    assert.equal(
      review(["approve", personal.id, "--scope", "personal", "--yes"])[0].status,
      "approved",
    );
    const personalDir = join(homedir(), ".engram", "engrams");
    const personalFiles = readdirSync(personalDir);
    assert.equal(personalFiles.length, 1);
    assert.equal(
      readFileSync(join(personalDir, personalFiles[0]), "utf8"),
      personalPreview.markdown,
    );
    assert.equal(existsSync(pendingPath(personal)), false);
    break;
  }

  case "batch": {
    const first = seed("Bismuth");
    const second = seed("Zircon");
    const absent = "pending-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const [oldPreview] = review(["approve", first.id, "--dry-run"]);
    assert.ok(oldPreview.revision);
    const edited = review(
      ["edit", first.id, absent, second.id, first.id, "--stdin"],
      1,
      JSON.stringify({ body: "Choose the polished mineral.", tags: [], type: "note" }),
    );
    assert.deepEqual(
      edited.map(({ id, status, code }) => [id, status, code]),
      [
        [first.id, "edited", undefined],
        [absent, "failed", "not_found"],
        [second.id, "edited", undefined],
      ],
    );
    for (const candidate of [first, second]) {
      assert.deepEqual(JSON.parse(readFileSync(pendingPath(candidate), "utf8")), {
        ...candidate,
        proposed: {
          ...candidate.proposed,
          body: "Choose the polished mineral.",
          tags: [],
          type: "note",
        },
      });
    }
    const stale = review(["approve", first.id, "--yes", "--expect", oldPreview.revision], 1);
    assert.equal(stale[0].code, "invalid");
    assert.deepEqual(publishedFiles(), []);
    assert.deepEqual(
      review(["show", first.id, second.id]).map((row) => row.status),
      ["pending", "pending"],
    );
    assert.deepEqual(
      review(["reject", second.id, absent], 1).map((row) => row.status),
      ["rejected", "failed"],
    );
    assert.equal(existsSync(pendingPath(second)), false);
    assert.deepEqual(publishedFiles(), []);
    const third = seed("Garnet");
    assert.deepEqual(
      review(["approve", absent, first.id, third.id, "--yes"], 1).map((row) => row.status),
      ["failed", "approved", "approved"],
    );
    assert.equal(existsSync(pendingPath(first)), false);
    assert.equal(existsSync(pendingPath(third)), false);
    assert.deepEqual(review(["list"]), []);
    assert.equal(publishedFiles().length, 2);
    assert.ok(
      publishedFiles().some((file) =>
        readFileSync(join(storeDir, file), "utf8").includes("Choose the polished mineral."),
      ),
    );
    break;
  }

  case "validation": {
    const duplicate = seed("Kyanite");
    const conflict = seed("Tourmaline");
    const sensitive = seed("Jasper");
    const malformed = seed("Opal");
    const lifecycle = seed("Sodalite");
    // Stage before the canonical entries exist. Admission must see new writes
    // and ignore the fixture's old duplicate and conflict references.
    cli([
      "add",
      "--title",
      duplicate.proposed.title,
      "--type",
      "decision",
      duplicate.proposed.body,
    ]);
    cli([
      "add",
      "--title",
      conflict.proposed.title,
      "--type",
      "decision",
      "Use the amber adapter.",
    ]);
    sensitive.proposed.body = "password = synthetic-private-review-value";
    save(sensitive);
    writeFileSync(pendingPath(malformed), JSON.stringify({ ...malformed, schemaVersion: 2 }));
    lifecycle.created = "invalid-lifecycle-timestamp";
    save(lifecycle);
    const cases = [duplicate, conflict, sensitive, malformed, lifecycle];
    const before = cases.map((candidate) => readFileSync(pendingPath(candidate), "utf8"));
    const canonicalBefore = publishedFiles().map((file) =>
      readFileSync(join(storeDir, file), "utf8"),
    );
    const actual = cli(["pending", "approve", ...cases.map(({ id }) => id), "--yes", "--json"], 1);
    const errors = rows(actual.stdout);
    assert.deepEqual(
      errors.map((row) => [row.status, row.code]),
      [
        ["failed", "exact_duplicate"],
        ["failed", "possible_conflict"],
        ["failed", "sensitive_content"],
        ["failed", "invalid"],
        ["failed", "invalid"],
      ],
    );
    assert.ok(errors[2].findings?.some((finding) => finding.rule === "SEC-CRED-ASSIGNMENT"));
    assert.doesNotMatch(
      actual.stderr + actual.stdout,
      /synthetic-private-review-value|invalid-lifecycle-timestamp/,
    );
    const invalidPatch = cli(
      ["pending", "edit", duplicate.id, "--patch", '{"type":"invalid"}', "--json"],
      1,
    );
    assert.equal(JSON.parse(invalidPatch.stdout).error.code, "invalid");
    assert.deepEqual(
      cases.map((candidate) => readFileSync(pendingPath(candidate), "utf8")),
      before,
    );
    assert.deepEqual(
      publishedFiles().map((file) => readFileSync(join(storeDir, file), "utf8")),
      canonicalBefore,
    );
    assert.equal(
      review(["approve", duplicate.id, "--yes", "--confirm-write"], 1)[0].code,
      "exact_duplicate",
    );
    assert.equal(
      review(["approve", conflict.id, "--yes", "--confirm-write"])[0].status,
      "approved",
    );
    assert.equal(existsSync(pendingPath(duplicate)), true);
    assert.equal(existsSync(pendingPath(conflict)), false);
    assert.equal(publishedFiles().length, 3);
    assert.equal(
      review(["edit", sensitive.id, "--patch", '{"body":"Jasper is durable."}'])[0].status,
      "edited",
    );
    assert.equal(review(["approve", sensitive.id, "--yes"])[0].status, "approved");
    assert.equal(existsSync(pendingPath(sensitive)), false);
    assert.equal(publishedFiles().length, 4);
    const late = seed("Malachite");
    const lock = pendingPath(late) + ".lock";
    mkdirSync(lock);
    const lateResult = await approvalAttempt(late.id, () => {
      cli(["add", "--title", late.proposed.title, "--type", "decision", late.proposed.body]);
      rmdirSync(lock);
    });
    assert.match(lateResult.stderr, /Approval preview for/);
    assert.equal(lateResult.status, 1);
    assert.equal(rows(lateResult.stdout)[0].code, "exact_duplicate");
    assert.equal(existsSync(pendingPath(late)), true);
    assert.equal(publishedFiles().length, 5);

    break;
  }

  case "concurrency": {
    const proposal = seed("Obsidian");
    const file = pendingPath(proposal);
    const before = readFileSync(file, "utf8");
    const attempts = await Promise.all([
      approvalAttempt(proposal.id),
      approvalAttempt(proposal.id),
    ]);
    assert.deepEqual(attempts.map(({ status }) => status).sort(), [0, 1]);
    assert.deepEqual(attempts.map(({ stdout }) => rows(stdout)[0].status).sort(), [
      "approved",
      "failed",
    ]);
    assert.equal(existsSync(file), false);
    assert.equal(publishedFiles().length, 1);

    const canonical = join(storeDir, publishedFiles()[0]);
    const bytes = readFileSync(canonical, "utf8");
    // Restore the queue side of the interruption window after publication.
    writeFileSync(file, before);
    const [edit] = review(
      ["edit", proposal.id, "--patch", '{"body":"Choose the glossy mineral."}'],
      1,
    );
    assert.equal(edit.status, "failed");
    assert.match(edit.message ?? "", /already published.*retry approval.*engram edit/i);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(readFileSync(canonical, "utf8"), bytes);
    assert.equal(review(["approve", proposal.id, "--yes"])[0].status, "already_approved");
    assert.equal(existsSync(file), false);
    assert.equal(publishedFiles().length, 1);
    assert.equal(readFileSync(canonical, "utf8"), bytes);
    break;
  }

  default:
    assert.fail(`Unknown pending audit scenario ${scenario}`);
}
