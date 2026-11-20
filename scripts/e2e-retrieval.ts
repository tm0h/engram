import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

interface SearchResult {
  id: string;
  explanation?: { contributions: Array<{ field: string; score: number }> };
}

interface StatsReport {
  events: number;
  loads: { total: number; withContext: number; outcomes: Record<string, number> };
  contextBytes: { total: number };
  candidates: { recall: { selected: number } };
}

interface ToolDetails {
  id?: string;
  budget?: { method: string; used: number };
}

type ToolArgs = { scope: "project"; limit: number; tokens?: number } | { id: string; body: string };
type ToolName = "context" | "edit";

interface PiTool {
  name: string;
  execute(
    id: string,
    args: ToolArgs,
  ): Promise<{
    content: [{ text: string }];
    isError: boolean;
    details: ToolDetails;
  }>;
}

interface PiContext {
  cwd: string;
  hasUI: false;
  model?: { contextWindow: number; maxTokens: number };
}

type PiHandlers = {
  session_start: (event: { reason: "startup" }, context: PiContext) => Promise<void>;
  before_agent_start: (
    event: { prompt: string; systemPrompt: string },
    context: PiContext,
  ) => Promise<{ systemPrompt: string } | undefined>;
};

interface PiBundle {
  default(host: {
    on: <Event extends keyof PiHandlers>(name: Event, handler: PiHandlers[Event]) => void;
    registerTool: (tool: PiTool) => void;
    registerCommand: () => void;
  }): void;
}

interface OpenCodeAssistant {
  info: {
    role: "assistant";
    sessionID: string;
    parentID: string;
    time: { completed?: number };
    path: { cwd: string };
    modelID: string;
    providerID: string;
  };
}

interface OpenCodeUserMessage {
  info: { role: "user"; id: string; sessionID: string };
  parts: Array<{ type: "text"; sessionID: string; messageID: string; text: string }>;
}

interface OpenCodeBundle {
  default(input: {
    client: {
      session: {
        messages: (params: { path: { id: string } }) => Promise<{ data: OpenCodeAssistant[] }>;
        message: (params: {
          path: { id: string; messageID: string };
        }) => Promise<{ data: OpenCodeUserMessage }>;
      };
    };
  }): Promise<{
    "experimental.chat.system.transform": (
      input: {
        sessionID: string;
        model: { id: string; providerID: string; limit: { context: number; output: number } };
      },
      output: { system: string[] },
    ) => Promise<void>;
    tool: Record<
      `engram_${ToolName}`,
      {
        execute(
          args: ToolArgs,
          context: { directory: string; sessionID: string },
        ): Promise<{
          output: string;
          metadata: ToolDetails & { isError: boolean };
        }>;
      }
    >;
  }>;
}

interface CompactionDiagnostic {
  harness: string;
  event: string;
  used: number;
  effective: number;
  omitted: Array<{ reason: string }>;
  deduplicated: unknown[];
}

const [scenario, input] = process.argv.slice(2);
assert.ok(input, "Pass a project directory or diagnostics file");
if (scenario === "diagnostics") {
  const rows = readFileSync(input, "utf8")
    .trim()
    .split("\n")
    .map((line): CompactionDiagnostic => JSON.parse(line));
  assert.equal(rows.length, 6);
  for (const harness of ["pi", "opencode"]) {
    const deliveries = rows.filter((row) => row.harness === harness);
    assert.equal(deliveries.length, 3, harness);
    const [wide, tight, empty] = deliveries;
    assert.ok([wide, tight, empty].every((row) => row.event === "engram.automatic-context"));
    assert.ok(tight.used > 0 && tight.used <= tight.effective && tight.used < wide.used);
    assert.ok(tight.omitted.some(({ reason }) => reason === "budget"));
    assert.equal(tight.deduplicated.length, 1);
    assert.equal(empty.used, 0);
  }
  process.exit(0);
}

const project = input;
assert.ok(process.env.ENGRAM_E2E_BIN, "Set ENGRAM_E2E_BIN to the installed CLI");
const bin = realpathSync(process.env.ENGRAM_E2E_BIN);
const dist = dirname(bin);
const store = ".engram/engrams";
mkdirSync(project);
process.chdir(project);

const cli = (...args: string[]) => execFileSync(bin, args, { encoding: "utf8" });
const json = <T>(...args: string[]): T => JSON.parse(cli(...args));
const bundle = <T>(name: string): Promise<T> => import(pathToFileURL(join(dist, name)).href);
const snapshot = () =>
  readdirSync(store)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => [name, readFileSync(join(store, name), "utf8")] as const);
const cost = (text: string) =>
  Array.from(text).reduce(
    (sum, point) =>
      sum + Math.max(Buffer.byteLength(point), Buffer.byteLength(point.normalize("NFKD"))),
    0,
  );

cli("init", "--untracked");
function add(title: string, body: string, ...flags: string[]) {
  const result = cli("add", "--title", title, ...flags, body);
  const id = /Added \[([a-z0-9]+)\]/.exec(result)?.[1];
  assert.ok(id, result);
  return id;
}

if (scenario === "ranking") {
  // Existing stores can contain synchronized duplicates. Seed them directly
  // so the write admission guard does not mask the retrieval behavior.
  const seed = (
    id: string,
    title: string,
    body: string,
    { type = "decision", status = "active", updated = "2000-01-01T00:00:00.000Z" } = {},
  ) =>
    writeFileSync(
      join(store, `${id}-fixture.md`),
      [
        "---",
        `id: "${id}"`,
        `title: ${title}`,
        `type: ${type}`,
        "scope: project",
        "tags: []",
        `status: ${status}`,
        "created: 2000-01-01T00:00:00.000Z",
        `updated: ${updated}`,
        "---",
        body,
        "",
      ].join("\n"),
    );

  for (let i = 1; i <= 6; i++) {
    seed(
      `000${i}`,
      "Auth convention",
      "Validate incoming requests before routing them through the database service.",
    );
  }
  for (let i = 1; i <= 4; i++) {
    seed(`001${i}`, `Auth detail ${i}`, `Separate required fact ${i}.`);
  }
  seed("0015", "Auth archived", "Inactive evidence.", { status: "archived" });
  seed("0020", "Quorum convention", "Choose a steady quorum.", { type: "note" });
  seed("0021", "Quorum convention", "Choose a stable quorum.", {
    type: "note",
    updated: new Date(Date.now() - 60_000).toISOString(),
  });
  const before = snapshot();

  const top = json<{ results: SearchResult[] }>(
    "search",
    "auth",
    "--limit",
    "5",
    "--json",
    "--explain",
  ).results;
  assert.deepEqual(top.map(({ id }) => id).sort(), ["0001", "0011", "0012", "0013", "0014"]);
  const all = json<{ results: SearchResult[] }>("search", "auth", "--json", "--explain").results;
  assert.equal(all.length, 10);
  assert.ok(
    all
      .find(({ id }) => id === "0002")
      ?.explanation?.contributions.some(
        ({ field, score }) => field === "diversification" && score < 0,
      ),
  );
  const inactive = json<{ results: SearchResult[] }>("search", "auth", "--all", "--json").results;
  assert.ok(inactive.some(({ id }) => id === "0015"));
  const freshness = json<{ results: SearchResult[] }>(
    "search",
    "quorum",
    "--json",
    "--explain",
  ).results;
  assert.deepEqual(
    freshness.map(({ id }) => id),
    ["0021", "0020"],
  );
  assert.ok(
    freshness[0].explanation?.contributions.some(
      ({ field, score }) => field === "freshness" && score > 0,
    ),
  );
  assert.equal(
    freshness[1].explanation?.contributions.some(({ field }) => field === "freshness"),
    false,
  );
  assert.deepEqual(snapshot(), before);
  process.exit(0);
}

const { default: pi } = await bundle<PiBundle>("pi-extension.js");
const piTools = new Map<string, PiTool>();
const handlers: Partial<PiHandlers> = {};
pi({
  on: (name, handler) => {
    handlers[name] = handler;
  },
  registerTool: (tool) => piTools.set(tool.name, tool),
  registerCommand() {},
});
const { default: opencode } = await bundle<OpenCodeBundle>("opencode-plugin.js");
const sessionID = "offline-fixture";
const provider = { id: "offline", providerID: "offline" };
let sequence = 0;
let turn: { id: string; prompt: string };
const hooks = await opencode({
  client: {
    session: {
      messages: async ({ path }) => {
        assert.equal(path.id, sessionID);
        return {
          data: [
            {
              info: {
                role: "assistant",
                sessionID,
                parentID: turn.id,
                time: {},
                path: { cwd: project },
                modelID: provider.id,
                providerID: provider.providerID,
              },
            },
          ],
        };
      },
      message: async ({ path }) => {
        assert.deepEqual(path, { id: sessionID, messageID: turn.id });
        return {
          data: {
            info: { role: "user", id: turn.id, sessionID },
            parts: [{ type: "text", sessionID, messageID: turn.id, text: turn.prompt }],
          },
        };
      },
    },
  },
});
const piContext: PiContext = { cwd: project, hasUI: false };
assert.ok(handlers.session_start);
await handlers.session_start({ reason: "startup" }, piContext);
const openContext = { directory: project, sessionID };
const harnesses = [
  {
    name: "Pi",
    envelope: 0,
    async deliver(prompt: string, { system = "Project instructions.", window = 8192 } = {}) {
      assert.ok(handlers.before_agent_start);
      const result = await handlers.before_agent_start(
        { prompt, systemPrompt: system },
        { ...piContext, model: { contextWindow: window, maxTokens: 256 } },
      );
      if (!result) return "";
      assert.deepEqual(Object.keys(result), ["systemPrompt"]);
      assert.ok(result.systemPrompt.startsWith(system + "\n\n"));
      return result.systemPrompt.slice(system.length + 2);
    },
    async tool(name: ToolName, args: ToolArgs) {
      const tool = piTools.get(`engram_${name}`);
      assert.ok(tool);
      const result = await tool.execute("offline-fixture", args);
      return { text: result.content[0].text, isError: result.isError, details: result.details };
    },
  },
  {
    name: "OpenCode",
    envelope: 16,
    async deliver(
      prompt: string,
      { system = "Project instructions.", window = 8192, sameTurn = false } = {},
    ) {
      if (!sameTurn) turn = { id: `turn-${++sequence}`, prompt };
      const out = { system: [system] };
      await hooks["experimental.chat.system.transform"](
        { sessionID, model: { ...provider, limit: { context: window, output: 256 } } },
        out,
      );
      assert.equal(out.system[0], system);
      assert.ok(out.system.length <= 2);
      return out.system[1] ?? "";
    },
    async tool(name: ToolName, args: ToolArgs) {
      const result = await hooks.tool[`engram_${name}`].execute(args, openContext);
      return { text: result.output, isError: result.metadata.isError, details: result.metadata };
    },
  },
] as const;

function assertFrame(text: string) {
  assert.equal(text.split("<engram-memory>").length, 2, text);
  assert.ok(text.endsWith("</engram-memory>"), text);
}

if (scenario === "startup") {
  add("Pinned startup convention", "Pinned startup body.", "--pinned");
  add(
    "Architecture baseline",
    "Architecture baseline body.",
    "--type",
    "decision",
    "--importance",
    "3",
  );
  add("Ordinary scratchpad", "Ordinary scratchpad body.");
  add(
    "Scoped decision",
    "Scoped decision body.",
    "--type",
    "decision",
    "--importance",
    "5",
    "--applies-to",
    "src/**",
  );
  add(
    "Archived decision",
    "Archived decision body.",
    "--type",
    "decision",
    "--importance",
    "5",
    "--status",
    "archived",
  );
  const before = snapshot();
  for (const harness of harnesses) {
    const block = await harness.deliver("Configure spruce quorum");
    assertFrame(block);
    assert.match(block, /Pinned startup convention/);
    assert.doesNotMatch(block, /Ordinary scratchpad|Scoped decision|Archived decision/);
    // OpenCode's weak-query bootstrap includes unpinned decisions as title-only rows.
    if (harness.name === "OpenCode") {
      assert.match(block, /Architecture baseline/);
      assert.doesNotMatch(block, /Architecture baseline body/);
    }
  }
  cli("config", "set", "autoContext", "off");
  for (const harness of harnesses)
    assert.equal(await harness.deliver("Pinned startup convention"), "");
  assert.equal(cli("config", "get", "autoContext").trim(), "off");
  assert.deepEqual(snapshot(), before);
} else if (scenario === "recall") {
  const orchid = add("Orchid cache", "Set orchid_ttl=604800.");
  const cedar = add("Cedar retries", "Set cedar_retries=3.");
  const before = snapshot();
  for (const harness of harnesses) {
    const first = await harness.deliver("Configure orchid cache");
    assertFrame(first);
    assert.ok(first.includes(`project/${orchid}`));
    assert.match(first, /orchid_ttl=604800/);
    assert.doesNotMatch(first, /cedar_retries/);

    const second = await harness.deliver("Configure cedar retries");
    assertFrame(second);
    assert.ok(second.includes(`project/${cedar}`));
    assert.match(second, /cedar_retries=3/);
    assert.doesNotMatch(second, /orchid_ttl/);
    assert.equal(await harness.deliver("Configure spruce quorum"), "");
    assert.deepEqual(snapshot(), before);
  }
  const open = harnesses[1];
  const prompt = "Configure orchid cache";
  assert.match(await open.deliver(prompt), /orchid_ttl=604800/);
  const edited = await open.tool("edit", { id: orchid, body: "Set orchid_ttl=86400." });
  assert.equal(edited.isError, false, edited.text);
  assert.match(edited.text, /Updated/);
  assert.equal(edited.details.id, orchid);
  const refreshed = await open.deliver(prompt, { sameTurn: true });
  assertFrame(refreshed);
  assert.match(refreshed, /orchid_ttl=86400/);
  assert.doesNotMatch(refreshed, /604800/);
  assert.equal(snapshot().length, before.length);
  const changed = snapshot().find(([name]) => name.startsWith(orchid));
  assert.ok(changed);
  assert.match(changed[1], /orchid_ttl=86400/);
  assert.deepEqual(
    snapshot().find(([name]) => name.startsWith(cedar)),
    before.find(([name]) => name.startsWith(cedar)),
  );
} else if (scenario === "manual") {
  const pinned = add("Équipe 🧭 recovery", "Durable recovery evidence.", "--pinned");
  for (let i = 0; i < 8; i++) add(`Étiquette ${i} ${"🧭".repeat(26)}`, `Fixture ${i}.`);
  const before = snapshot();
  for (const harness of harnesses) {
    const args = { scope: "project", limit: 9 } as const;
    const full = await harness.tool("context", args);
    assert.equal(full.isError, false, full.text);
    assert.ok(cost(full.text) > 512);
    const bounded = await harness.tool("context", { ...args, tokens: 512 });
    assert.equal(bounded.isError, false, bounded.text);
    assert.ok(cost(bounded.text) <= 512, bounded.text);
    assert.ok(bounded.text.includes(pinned));
    assert.match(bounded.text, /Équipe 🧭 recovery/);
    assert.ok(bounded.details.budget);
    assert.equal(bounded.details.budget.method, "utf8-nfkd-bytes-v1");
    assert.equal(bounded.details.budget.used, cost(bounded.text));
    assert.doesNotMatch(bounded.text, /\uFFFD/);
    const invalid = await harness.tool("context", { ...args, tokens: 511 });
    assert.equal(invalid.isError, true);
    assert.match(invalid.text, /at least 512/);
    assert.ok(!invalid.text.includes(pinned));
  }
  assert.deepEqual(snapshot(), before);
} else if (scenario === "compaction") {
  const ttl = add("Orchid TTL", "Set orchid_ttl=604800.", "--pinned", "--type", "decision");
  const zone = add("Orchid zone", "Set orchid_zone=éurope.", "--type", "fact", "--importance", "4");
  const retries = add(
    "Orchid retries",
    "Set orchid_retries=3.",
    "--type",
    "fact",
    "--importance",
    "4",
  );
  add("Orchid obsolete", "Set orchid_ttl=999.", "--type", "decision", "--status", "archived");
  add(
    "Orchid long policy",
    `Orchid guidance starts here. ${"Additional implementation caveats. ".repeat(15)}`,
    "--type",
    "fact",
    "--importance",
    "4",
  );
  add(
    "Orchid long background",
    `Orchid background starts here. ${"Additional deployment commentary. ".repeat(15)}`,
    "--type",
    "note",
    "--importance",
    "4",
  );
  const before = snapshot();
  const prompt = "Configure orchid TTL zone retries\nSet orchid_retries=3.";
  const system = "Project instructions.";
  const window = 780;
  for (const harness of harnesses) {
    const wide = await harness.deliver(prompt, { system });
    const tight = await harness.deliver(prompt, { system, window });
    for (const block of [wide, tight]) {
      assertFrame(block);
      const top = block
        .split("\n")
        .filter((line) => line.startsWith("project/"))
        .slice(0, 5);
      assert.ok(
        top.some((line) => line.includes(`project/${ttl}`) && line.includes("orchid_ttl=604800")),
        block,
      );
      assert.ok(
        top.some((line) => line.includes(`project/${zone}`) && line.includes("orchid_zone=éurope")),
        block,
      );
      assert.ok(!block.includes(`project/${retries}`), block);
      assert.doesNotMatch(block, /orchid_retries=3|999|candidateOverflow|deduplicated|\uFFFD/);
    }
    const total = cost(system) + cost(prompt) + 16 + 256 + cost(tight) + 2 + 2 * harness.envelope;
    assert.ok(total <= window, `${harness.name} rendered cost ${total}/${window}`);
    assert.ok(cost(tight) < cost(wide), `${harness.name} tight and wide blocks did not differ`);
    assert.equal(await harness.deliver(prompt, { system, window: 256 }), "");
  }
  assert.deepEqual(snapshot(), before);
} else if (scenario === "stats") {
  const id = add("Azalea retention", "Set azalea_ttl=3600.");
  const before = snapshot();
  cli("stats", "--clear");
  assert.equal(json<StatsReport>("stats", "--json").events, 0);
  const runAsync = promisify(execFile);
  let events = 0;
  let bytes = 0;
  for (const harness of harnesses) {
    const block = await harness.deliver("Configure azalea retention");
    assertFrame(block);
    assert.match(block, /azalea_ttl=3600/);
    events++;
    bytes += Buffer.byteLength(block);
    // Recording is best-effort and asynchronous. Wait for the event before
    // making the next request so the host fixture does not contend on the lock.
    let report: StatsReport | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      const { stdout } = await runAsync(bin, ["stats", "--json"]);
      report = JSON.parse(stdout) as StatsReport;
      if (report.events >= events) break;
      await setTimeout(30);
    }
    assert.ok(report);
    assert.equal(report.events, events, JSON.stringify(report));
    assert.deepEqual(report.loads, {
      total: events,
      withContext: events,
      outcomes: { loaded: events },
    });
    assert.equal(report.contextBytes.total, bytes);
    assert.equal(report.candidates.recall.selected, events);
  }
  const history = readFileSync(join(homedir(), ".engram/stats/events.json"), "utf8");
  const stored: { events: unknown[] } = JSON.parse(history);
  assert.equal(stored.events.length, events);
  assert.doesNotMatch(history, new RegExp(`${id}|azalea`, "i"));
  assert.deepEqual(snapshot(), before);
} else {
  throw new Error(`Unknown retrieval audit scenario: ${scenario}`);
}
