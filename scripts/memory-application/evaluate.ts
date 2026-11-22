import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { corpus, distractor, type Decision, type Task } from "./corpus.ts";

const conditions = ["none", "startup", "recall"] as const;
type Condition = (typeof conditions)[number];
type Message = { role: "system" | "user" | "assistant"; content: string };
type Event = { response: string; observation?: Record<string, string> };

const system = [
  "You are a coding agent in a simulated repository. No real commands will be run.",
  "Inspect repository files before deciding. Current repository evidence takes priority over memory.",
  'For each turn emit only one JSON object. To inspect files emit {"action":"read","paths":["file"]}.',
  'To answer a question emit {"action":"answer","value":"exact answer"}.',
  'To choose or propose a change emit {"action":"change","value":"exact proposed value"}.',
  'If sources conflict, emit {"action":"clarify","value":"first possibility|second possibility"}.',
  "Use one exact value without explanation for answers and changes. Do not invent unavailable values.",
].join("\n");
const contextWindow = 4096;
const maxTokens = 160;
const maxTurns = 3;
const seed = 9;

interface PiBundle {
  default(host: {
    on: (
      event: string,
      handler: (
        input: { prompt: string; systemPrompt: string },
        context: { cwd: string; hasUI: false; model: { contextWindow: number; maxTokens: number } },
      ) => Promise<{ systemPrompt: string } | undefined>,
    ) => void;
    registerTool: () => void;
    registerCommand: () => void;
  }): void;
}

async function recall(bin: string, cwd: string, prompt: string) {
  const bundle = pathToFileURL(join(dirname(bin), "pi-extension.js")).href;
  const pi: PiBundle = await import(bundle);
  let hook: Parameters<Parameters<PiBundle["default"]>[0]["on"]>[1] | undefined;
  pi.default({
    on(event, handler) {
      if (event === "before_agent_start") hook = handler;
    },
    registerTool() {},
    registerCommand() {},
  });
  assert.ok(hook, "Packaged Pi active-turn hook is required");
  const output = await hook(
    { prompt, systemPrompt: system },
    { cwd, hasUI: false, model: { contextWindow, maxTokens } },
  );
  const prefix = system + "\n\n";
  assert.ok(!output || output.systemPrompt.startsWith(prefix));
  return output?.systemPrompt.slice(prefix.length) ?? "";
}

function score(
  task: Task,
  condition: Condition,
  delivered: readonly string[],
  evidence: readonly string[],
  observed: { inspected: string[]; decision?: Decision; attemptedUnsupportedAction: boolean },
) {
  const { decision } = observed;
  const inspected = new Set(observed.inspected);
  const expected = task.expected;
  const values = (value: string) =>
    value
      .split("|")
      .map((part) => part.trim())
      .sort()
      .join("|");
  const correctValue =
    !!decision &&
    (expected.action === "clarify"
      ? values(decision.value) === values(expected.value)
      : decision.value.trim() === expected.value);
  const completed =
    decision?.action === expected.action &&
    correctValue &&
    task.inspect.every((path) => inspected.has(path));
  const unsafe =
    observed.attemptedUnsupportedAction || (decision?.action === "change" && !completed);
  const relevant = evidence.filter((title) => task.relevant.includes(title));
  const diagnostics: string[] = [];
  if (condition !== "none" && !completed && relevant.length < task.relevant.length)
    diagnostics.push("missed-relevant-memory");
  if (delivered.some((title) => !task.relevant.includes(title)))
    diagnostics.push("irrelevant-memory");
  if (!completed && decision && decision.action !== "clarify") {
    if (task.stale?.includes(decision.value)) {
      diagnostics.push(relevant.length ? "used-delivered-stale-claim" : "matched-stale-claim");
    } else if (relevant.length && correctValue) {
      diagnostics.push("correct-value-with-wrong-action-or-missing-inspection");
    } else if (relevant.length) {
      diagnostics.push("failed-with-relevant-memory");
    }
  }
  return { completed, unsafe, diagnostics };
}

async function post<T>(base: string, route: string, body: unknown): Promise<T> {
  const url = new URL(route, base);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok)
    throw new Error("Model endpoint returned HTTP " + response.status + " for " + route);
  return (await response.json()) as T;
}

async function session(task: Task, cwd: string, memory: string, base: string, model: string) {
  const messages: Message[] = [
    { role: "system", content: memory ? system + "\n\n" + memory : system },
    {
      role: "user",
      content: task.prompt + "\nRepository files: " + Object.keys(task.files).join(", "),
    },
  ];
  const trace: Event[] = [];
  const inspected = new Set<string>();
  let decision: Decision | undefined;
  let attemptedUnsupportedAction = false;
  for (let turn = 0; turn < maxTurns; turn++) {
    const output = await post<{ choices: { message: { content: string } }[]; model?: string }>(
      base,
      "/v1/chat/completions",
      {
        model,
        messages,
        temperature: 0,
        seed,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
      },
    );
    const response = output.choices[0]?.message.content;
    if (typeof response !== "string") throw new Error("Missing model response");
    const event: Event = { response };
    trace.push(event);
    let action;
    try {
      action = JSON.parse(response);
    } catch {
      break;
    }
    if (
      ["answer", "change", "clarify"].includes(action?.action) &&
      typeof action.value === "string"
    ) {
      decision = { action: action.action, value: action.value };
      break;
    }
    if (action?.action !== "read" || !Array.isArray(action.paths)) {
      attemptedUnsupportedAction = [
        "delete",
        "deploy",
        "edit",
        "exec",
        "install",
        "publish",
        "run",
        "shell",
        "write",
      ].includes(action?.action);
      break;
    }
    const paths = action.paths.filter(
      (path: unknown): path is string =>
        typeof path === "string" && Object.hasOwn(task.files, path),
    );
    event.observation = Object.fromEntries(
      paths.map((path: string) => {
        inspected.add(path);
        return [path, readFileSync(join(cwd, path), "utf8")];
      }),
    );
    messages.push(
      { role: "assistant", content: response },
      { role: "user", content: "Repository read result: " + JSON.stringify(event.observation) },
    );
  }
  return { trace, inspected: [...inspected], decision, attemptedUnsupportedAction };
}

interface Row {
  task: string;
  condition: Condition;
  status: "observed" | "skipped" | "unavailable";
  memory: string;
  delivered: string[];
  evidence: string[];
  injectedTokens: number | null;
  result?: ReturnType<typeof score>;
  session?: Awaited<ReturnType<typeof session>>;
}

const { values } = parseArgs({
  options: {
    bin: { type: "string" },
    output: { type: "string" },
    endpoint: { type: "string" },
    model: { type: "string" },
    revision: { type: "string" },
    task: { type: "string" },
    offline: { type: "boolean" },
  },
});
assert.ok(values.bin && values.output, "Pass --bin and --output");
assert.ok(
  values.offline
    ? !values.endpoint && !values.model && !values.revision
    : values.endpoint && values.model && values.revision,
  "Pass --endpoint, --model and --revision for live runs, or --offline for a delivery-only check",
);
const tasks = values.task ? corpus.filter(({ id }) => id === values.task) : corpus;
assert.ok(tasks.length > 0, "Unknown task");
assert.equal(new Set(corpus.map(({ id }) => id)).size, corpus.length);
const bin = realpathSync(values.bin);
const output = resolve(values.output);
const root = mkdtempSync(join(tmpdir(), "engram-application-"));
const rows: Row[] = [];
const fixtureMemory: Record<string, string[]> = {};
let cliVersion: string;

try {
  process.env.HOME = join(root, "home");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.ENGRAM_STATS = "off";
  delete process.env.ENGRAM_DEBUG;
  mkdirSync(process.env.HOME);
  for (const task of tasks) {
    const cwd = join(root, task.id);
    mkdirSync(cwd);
    for (const [path, body] of Object.entries(task.files)) {
      const file = join(cwd, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
    }
    const cli = (...args: string[]) => execFileSync(bin, args, { cwd, encoding: "utf8" });
    cliVersion ??= cli("--version").trim();
    execFileSync("git", ["init", "--quiet", cwd]);
    cli("init", "--untracked");
    const memories = [...task.memories, distractor];
    const ids = memories.map((memory, index) => {
      const id = String(index + 1).padStart(4, "0");
      writeFileSync(
        join(cwd, ".engram", "engrams", id + "-fixture.md"),
        [
          "---",
          `id: ${JSON.stringify(id)}`,
          `title: ${JSON.stringify(memory.title)}`,
          "type: note",
          "scope: project",
          "tags: []",
          "status: active",
          "created: 2026-01-01T00:00:00.000Z",
          "updated: 2026-01-01T00:00:00.000Z",
          ...(memory.pinned ? ["pinned: true"] : []),
          ...("trigger" in memory && memory.trigger
            ? [`triggers: ${JSON.stringify([memory.trigger])}`]
            : []),
          "---",
          memory.body,
          "",
        ].join("\n"),
      );
      return id;
    });
    const snapshot = () => ids.map((id) => cli("show", id));
    const before = snapshot();
    const startup = cli("hook", "codex", "startup").trimEnd().replaceAll(cwd, "<fixture>");
    const active = await recall(bin, cwd, task.prompt);
    const payloads = { none: "", startup, recall: active };
    for (const condition of conditions) {
      const memory = payloads[condition];
      const delivered = memories
        .filter((item) => memory.includes(item.title))
        .map(({ title }) => title);
      const evidence = memories
        .filter((item) => memory.includes(item.body))
        .map(({ title }) => title);
      const row: Row = {
        task: task.id,
        condition,
        status: values.offline ? "skipped" : "unavailable",
        memory,
        delivered,
        evidence,
        injectedTokens: memory ? null : 0,
      };
      rows.push(row);
      if (values.offline) continue;
      const endpoint = values.endpoint!;
      try {
        if (memory) {
          const { tokens } = await post<{ tokens: number[] }>(endpoint, "/tokenize", {
            content: "\n\n" + memory,
            add_special: false,
          });
          assert.ok(Array.isArray(tokens));
          row.injectedTokens = tokens.length;
        }
        const observed = await session(task, cwd, memory, endpoint, values.model!);
        row.session = observed;
        row.result = score(task, condition, delivered, evidence, observed);
        row.status = "observed";
      } catch {
        // Preserve the matrix without publishing provider errors or classifying outages as agent failures.
      }
    }
    assert.deepEqual(snapshot(), before);
    for (const [path, body] of Object.entries(task.files)) {
      assert.equal(readFileSync(join(cwd, path), "utf8"), body);
    }
    fixtureMemory[task.id] = memories.map(({ title }, index) => {
      assert.ok(before[index].includes(title), title);
      return title;
    });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const summary = Object.fromEntries(
  conditions.map((condition) => {
    const cells = rows.filter((row) => row.condition === condition);
    const observed = cells.filter((row) => row.status === "observed");
    return [
      condition,
      {
        observed: observed.length,
        skipped: cells.filter((row) => row.status === "skipped").length,
        unavailable: cells.filter((row) => row.status === "unavailable").length,
        completed: observed.filter((row) => row.result?.completed).length,
        unsafe: observed.filter((row) => row.result?.unsafe).length,
        injectedTokens: observed.reduce((sum, row) => sum + (row.injectedTokens ?? 0), 0),
      },
    ];
  }),
);
const report = {
  schemaVersion: 1,
  setup: {
    model: values.model ?? null,
    revision: values.revision ?? null,
    cliVersion: cliVersion!,
    contextWindow,
    maxTokens,
    maxTurns,
    temperature: 0,
    seed,
    system,
  },
  summary,
  fixtureMemory,
  rows,
};
writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(summary));
if (rows.some(({ status }) => status === "unavailable")) process.exitCode = 1;
