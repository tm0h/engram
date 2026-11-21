import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [root, fixture] = process.argv.slice(2);
const bin = process.env.ENGRAM_E2E_BIN!;
const sessionID = "ses_violet";
const name = "engram-capture";
const remember = "Remember that Violet signs fixture bundles.";
const decision = "We decided to use whole snapshots so the mirror can recover offline.";
const yesterday = "Yesterday the Violet fixture failed to load again.";
const today = "The same issue happened today. We fixed both by warming the mirror.";
const noNew = "Engram found no new eligible candidates.";
const unavailable = "Engram capture could not complete for this session.";
const excluded = "Remember that Violet ignores unsigned fixtures.";
const source = (...ids: string[]) => ({
  harness: "opencode",
  sessionKind: "root",
  sessionId: sessionID,
  event: "command.execute.before",
  evidence: ids.map((id) => ({ messageId: "msg_" + id, partId: "prt_" + id, origin: "user" })),
});

function cli(cwd: string, args: string[]) {
  const run = spawnSync(bin, args, { cwd, encoding: "utf8" });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return run.stdout;
}

if (fixture) {
  const installed = createRequire(join(dirname(realpathSync(bin)), "index.js"));
  const shipped = await import(pathToFileURL(installed.resolve("engram-cli/server")).href);
  function message(id: string, text: string, role = "user") {
    const messageID = "msg_" + id;
    return {
      info: { id: messageID, sessionID, role },
      parts: [{ type: "text", id: "prt_" + id, messageID, sessionID, text }],
    };
  }
  const history: ReturnType<typeof message>[] = [];
  let messageReads = 0;
  const hooks = await shipped.default({
    directory: root,
    project: { id: "violet" },
    client: {
      session: {
        get: async (input: { path: { id: string }; query: { directory: string } }) => {
          assert.deepEqual(input.path, { id: sessionID });
          assert.equal(input.query.directory, root);
          if (fixture === "timeout") return new Promise(() => {});
          return {
            data: {
              id: sessionID,
              projectID: "violet",
              directory: fixture === "ambiguous" ? dirname(root) : root,
              ...(fixture === "subagent" && { parentID: "ses_parent" }),
            },
          };
        },
        messages: async (input: { query: { limit: number; directory: string } }) => {
          assert.deepEqual(input.query, { directory: root, limit: 64 });
          messageReads++;
          return { data: history };
        },
      },
      tui: {
        showToast: async ({ body }: { body: { message: string; variant: string } }) =>
          console.log(body.variant + " " + body.message),
      },
    },
  });
  const config: { command?: Record<string, { template: string }> } = {};
  await hooks.config(config);
  const before = (command: string, parts: unknown[], args = "") =>
    hooks["command.execute.before"]({ command, sessionID, arguments: args }, { parts });
  const capture = (args = "") =>
    before(name, [{ type: "text", text: config.command![name].template }], args);
  const observe = (row: ReturnType<typeof message>) =>
    hooks["chat.message"]({ sessionID }, { message: row.info, parts: row.parts });
  const append = async (row: ReturnType<typeof message>) => {
    await observe(row);
    history.push(row);
  };

  if (fixture === "eligible") {
    await append(message("remember", remember));
    await append(message("decision", decision));
    await append(message("yesterday", yesterday));
    await append(message("today", today));
    await append(message("repeat", remember));
    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });
    assert.equal(existsSync(join(root, ".engram/pending")), false);
    await capture();
    await capture();
    const rows = JSON.parse(cli(root, ["pending", "list", "--json"])).results;
    assert.equal(rows.length, 3);
    assert.ok(rows.every(({ status }: { status: string }) => status === "pending"));
    const row = rows.find(({ title }: { title: string }) =>
      title.startsWith("Violet signs fixture bundles"),
    );
    assert.ok(row);
    const stored = JSON.parse(
      readFileSync(join(root, ".engram/pending", row.id + ".json"), "utf8"),
    );
    assert.deepEqual(
      JSON.parse(cli(root, ["pending", "show", row.id, "--json"])).results[0].candidate,
      stored,
    );
    assert.equal(stored.sourceExcerpt, remember);
    assert.equal(stored.proposed.body, "Violet signs fixture bundles.");
    assert.deepEqual(stored.captureSource, source("remember"));
    cli(root, ["pending", "reject", row.id]);
    await capture();
    assert.equal(JSON.parse(cli(root, ["pending", "list", "--json"])).results.length, 2);
    console.log(JSON.stringify(rows.map(({ id }: { id: string }) => id)));
  } else if (fixture === "excluded") {
    history.push(message("unobserved", excluded));
    history.push(message("recall", excluded, "assistant"));
    const synthetic = message("synthetic", excluded);
    Object.assign(synthetic.parts[0], { synthetic: true });
    await append(synthetic);
    const ignored = message("ignored", excluded);
    Object.assign(ignored.parts[0], { ignored: true });
    await append(ignored);
    const mixed = message("mixed", excluded);
    mixed.parts.push({ ...mixed.parts[0], id: "prt_tool", type: "tool" });
    await append(mixed);
    const metadata = message("metadata", excluded);
    Object.assign(metadata.parts[0], { metadata: { generated: true } });
    await append(metadata);
    const built = message("command", excluded);
    await before("fixture-template", built.parts);
    // OpenCode copies the expanded command draft into chat.message, then
    // serializes it. Exercise the same boundary using the plugin's hooks.
    await observe({ ...built, parts: built.parts.map((part) => ({ ...part })) });
    history.push(JSON.parse(JSON.stringify(built)));
    const changed = message("changed", "Please inspect the Violet fixture.");
    await observe(changed);
    history.push({ ...changed, parts: [{ ...changed.parts[0], text: excluded }] });
    await append(message("yesterday", yesterday));
    history.push(message("assistant", "A separate assistant turn.", "assistant"));
    await append(message("today", today));
    await append(message("transient", "Remember that Violet is still running."));
    await capture("Remember that Violet uses fake fixture evidence.");
    await capture();
  } else {
    await append(message("blocked", excluded));
    await capture();
    assert.equal(messageReads, 0);
  }
} else {
  mkdirSync(root);
  for (const fixture of ["eligible", "excluded", "subagent", "ambiguous", "timeout"]) {
    const cwd = join(root, fixture);
    mkdirSync(cwd);
    cli(cwd, ["init", "--untracked"]);
    const pending = join(cwd, ".engram/pending");
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), cwd, fixture], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.equal(child.stderr, "");
    const output = child.stdout.trimEnd().split("\n");
    const rows = JSON.parse(cli(cwd, ["pending", "list", "--json"])).results;
    if (fixture === "eligible") {
      const [stage, repeat, afterReject, stagedIds] = output;
      assert.equal(
        stage,
        "info Engram staged 3 candidates for review. Run engram pending list --scope all.",
      );
      assert.equal(repeat, "info " + noNew);
      assert.equal(afterReject, repeat);
      const ids: string[] = JSON.parse(stagedIds);
      assert.equal(ids.length, 3);
      assert.equal(new Set(ids).size, 3);
      assert.equal(rows.length, 2);
      const reviewed = rows.map(({ id, status }: { id: string; status: string }) => {
        assert.equal(status, "pending");
        assert.ok(ids.includes(id));
        const stored = JSON.parse(readFileSync(join(pending, id + ".json"), "utf8"));
        assert.deepEqual(
          JSON.parse(cli(cwd, ["pending", "show", id, "--json"])).results[0].candidate,
          stored,
        );
        assert.equal(stored.schemaVersion, 1);
        assert.equal(stored.scope, "project");
        assert.equal(stored.provenanceClass, "conversation");
        return [
          stored.proposed.body,
          { source: stored.captureSource, excerpt: stored.sourceExcerpt },
        ];
      });
      assert.deepEqual(Object.fromEntries(reviewed), {
        [decision]: { source: source("decision"), excerpt: decision },
        [yesterday + "\n\n" + today]: {
          source: source("yesterday", "today"),
          excerpt: yesterday + "\n\n" + today,
        },
      });
      assert.deepEqual(
        new Set(readdirSync(pending)),
        new Set([".gitignore", ...rows.map(({ id }: { id: string }) => id + ".json")]),
      );
    } else {
      assert.deepEqual(
        output,
        fixture === "excluded"
          ? ["warning Use /engram-capture without arguments.", "info " + noNew]
          : ["warning " + unavailable],
      );
      assert.deepEqual(rows, []);
      assert.equal(existsSync(pending), false);
    }
    assert.deepEqual(readdirSync(join(cwd, ".engram/engrams")), []);
  }
  console.log(
    "OpenCode command fixtures: 5 sessions, 3 TP, 0 FP, 0 FN, 0 duplicates, 0 unsupported assertions",
  );
}
