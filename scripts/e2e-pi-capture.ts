import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [root, fixture] = process.argv.slice(2);
const bin = process.env.ENGRAM_E2E_BIN!;
const text = "Remember that Violet uses signed fixture bundles.";
const decision = "We decided to use whole snapshots so the mirror can recover offline.";
const notice = "Engram staged 1 candidate for review. Run engram pending list --scope all.";

if (fixture) {
  const dist = dirname(realpathSync(bin));
  const shipped = await import(pathToFileURL(join(dist, "pi-extension.js")).href);
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  shipped.default({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
      handlers.set(name, handler),
    registerTool() {},
    registerCommand() {},
  });
  const ctx = {
    cwd: root,
    mode: fixture === "subagent" ? "json" : "tui",
    hasUI: fixture !== "subagent",
    sessionManager: { getSessionId: () => "synthetic-violet-session" },
    ui: { notify: (message: string, level: string) => console.log(level + " " + message) },
  };
  const emit = (type: string, data = {}) => handlers.get(type)!({ type, ...data }, ctx);
  const message = (role: string, value: string) =>
    emit("message_end", {
      message: { role, content: [{ type: "text", text: value }], timestamp: 1700000000000 },
    });
  const input = async (value: string, source = "interactive", delivered = value) => {
    await emit("input", { source, text: value });
    await message("user", delivered);
  };
  const compact = () => emit("session_before_compact", { signal: new AbortController().signal });
  const shutdown = () => emit("session_shutdown", { reason: "quit" });

  await emit("session_start", { reason: "startup" });
  if (fixture === "eligible") {
    await input(text);
    await compact();
    await compact();
    await message("user", text);
    await input(decision);
    await emit("agent_settled");
    await shutdown();
    await shutdown();
  } else if (fixture === "subagent") {
    await input(text);
    await compact();
    await shutdown();
  } else {
    await input("Please review the fixture.");
    await message("custom", text);
    await message("toolResult", text);
    await message("assistant", decision);
    await message("user", text);
    await input(text, "extension");
    await input("/template", "interactive", text);
    await compact();
    await shutdown();
  }
} else {
  function cli(cwd: string, args: string[]) {
    const run = spawnSync(bin, args, { cwd, encoding: "utf8" });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    return run.stdout;
  }

  mkdirSync(root);
  for (const name of ["eligible", "excluded", "subagent"]) {
    const cwd = join(root, name);
    mkdirSync(cwd);
    cli(cwd, ["init", "--untracked"]);
    const canonical = join(cwd, ".engram/engrams");
    const queue = join(cwd, ".engram/pending");
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), cwd, name], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, "");
    const visible = JSON.parse(cli(cwd, ["pending", "list", "--json"])).results;
    if (name === "eligible") {
      assert.equal(child.stdout, `info ${notice}\ninfo ${notice}\n`);
      assert.equal(visible.length, 2);
      for (const row of visible) assert.equal(row.status, "pending");
      assert.deepEqual(
        new Set(readdirSync(queue)),
        new Set([".gitignore", ...visible.map(({ id }: { id: string }) => id + ".json")]),
      );
      const reviewed = visible.map(({ id }: { id: string }) => {
        assert.match(id, /^pending-[0-9a-f-]{36}$/);
        const stored = JSON.parse(readFileSync(join(queue, id + ".json"), "utf8"));
        assert.deepEqual(
          JSON.parse(cli(cwd, ["pending", "show", id, "--json"])).results[0].candidate,
          stored,
        );
        assert.equal(stored.schemaVersion, 1);
        assert.equal(stored.scope, "project");
        assert.equal(stored.provenanceClass, "conversation");
        return {
          body: stored.proposed.body,
          excerpt: stored.sourceExcerpt,
          source: stored.captureSource,
        };
      });
      assert.deepEqual(
        reviewed.toSorted((a: { body: string }, b: { body: string }) =>
          a.body.localeCompare(b.body),
        ),
        [text, decision].map((excerpt, index) => ({
          body: index === 0 ? "Violet uses signed fixture bundles." : decision,
          excerpt,
          source: {
            harness: "pi",
            sessionKind: "tui",
            sessionId: "synthetic-violet-session",
            event: index === 0 ? "session_before_compact" : "agent_settled",
            evidence: [
              { messageId: `message-1700000000000-${index === 0 ? 1 : 2}`, origin: "user" },
            ],
          },
        })),
      );
    } else {
      assert.equal(child.stdout, "");
      assert.equal(existsSync(queue), false);
      assert.deepEqual(visible, []);
    }
    assert.deepEqual(readdirSync(canonical), []);
  }
  console.log(
    "Pi lifecycle fixtures: 3 sessions, 2 TP, 0 FP, 0 FN, 0 duplicates, 0 unsupported assertions",
  );
}
