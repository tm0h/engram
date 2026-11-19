import { expect, it, vi } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Hooks } from "@opencode-ai/plugin";
import { projectConfigPath, projectEngramsDir } from "@engram/core";
import { createContextTransform } from "../src/opencode/context-transform.js";
import { registerAutoContext } from "../src/pi/context-hook.js";
import type { AutomaticContextDiagnostics } from "../src/shared/automatic-compaction.js";
import { countContextTokens } from "../src/shared/context-budget.js";
import { contextualRecallOp } from "../src/shared/contextual-recall.js";
import { autoContextOp } from "../src/shared/ops.js";
import { runOpAtDirectory } from "../src/shared/run.js";

const entries = [
  { id: "0001", title: "Orchid TTL", fact: "Set orchid_ttl=604800.", metadata: "pinned: true" },
  { id: "0002", title: "Cedar retries", fact: "Set cedar_retries=3.", metadata: "importance: 4" },
  { id: "0003", title: "Orchid zone", fact: "Set orchid_zone=éurope.", metadata: "" },
  {
    id: "0004",
    title: "Cedar retries obsolete",
    fact: "Set cedar_retries=999.",
    metadata: "pinned: true\nstatus: archived",
  },
];
const tasks = [
  {
    name: "small window",
    prompt: "Orchid TTL zone",
    system: "Project instructions.\nSet cedar_retries=3.",
    window: 780,
    ids: ["0001", "0003"],
    expected: { orchid_ttl: "604800", orchid_zone: "éurope" },
  },
  {
    name: "changed topic",
    prompt: "Configure cedar retries",
    system: "Project instructions.\nSet orchid_ttl=604800.",
    window: 128_000,
    ids: ["0002"],
    expected: { cedar_retries: "3" },
  },
  {
    name: "evidence already supplied",
    prompt: "Configure orchid TTL",
    system: "Project instructions.\nSet orchid_ttl=604800.\nSet cedar_retries=3.",
    window: 128_000,
    ids: ["0001"],
    expected: { orchid_ttl: "604800" },
  },
  {
    name: "abstention",
    prompt: "Configure spruce quorum",
    system: "Project instructions.",
    window: 128_000,
    ids: [],
    expected: {},
  },
] as const;

const seed = (cwd: string) => {
  mkdirSync(projectEngramsDir(cwd), { recursive: true });
  writeFileSync(projectConfigPath(cwd), JSON.stringify({ version: 1, tracked: true }));
  for (const entry of entries) {
    writeFileSync(
      join(projectEngramsDir(cwd), `${entry.id}-memory.md`),
      [
        "---",
        `id: "${entry.id}"`,
        `title: ${entry.title}`,
        "type: decision",
        "tags: []",
        "scope: project",
        "created: 2026-08-16T10:00:00.000Z",
        "updated: 2026-08-16T10:00:00.000Z",
        entry.metadata,
        "---",
        entry.fact,
        "",
      ].join("\n"),
    );
  }
};

/** Deterministic downstream consumer. It proposes changes only for settings
 * requested by the user and copies values from the assembled prompt. */
function proposeConfig(system: string, prompt: string) {
  return Object.fromEntries(
    [...system.matchAll(/\b([a-z]+)_([a-z]+)=([\p{L}\p{N}]+)/gu)]
      .filter(([, service, key]) => {
        const request = prompt.toLowerCase();
        return request.includes(service!) && request.includes(key!);
      })
      .map(([, service, key, value]) => [`${service}_${key}`, value]),
  );
}

// Score distinct required facts in the first five delivered evidence rows.
// A fact already supplied on a host line counts in both arms.
function recallAtFive(system: string, injected: string, ids: readonly string[]) {
  const top = injected
    .split("\n")
    .filter((line) => /^(project\/|\{"id":)/.test(line))
    .slice(0, 5);
  return ids.filter((id) => {
    const evidence = entries.find((entry) => entry.id === id)!.fact;
    return (
      system.split("\n").includes(evidence) ||
      top.some(
        (line) =>
          (line.includes(`"${id}"`) || line.startsWith(`project/${id} `)) &&
          line.includes(evidence),
      )
    );
  }).length;
}

it.each(["pi", "opencode"] as const)(
  "%s lowers injected cost at matched Recall@5 and task success",
  async (harness) => {
    const cwd = mkdtempSync(join(tmpdir(), "engram-compaction-eval-"));
    const home = join(cwd, "home");
    vi.stubEnv("HOME", home);
    vi.stubEnv("ENGRAM_STATS", "off");
    try {
      mkdirSync(join(home, ".engram"), { recursive: true });
      seed(cwd);
      let diagnostics: AutomaticContextDiagnostics | undefined;
      const onDiagnostics = (value: AutomaticContextDiagnostics) => {
        diagnostics = value;
      };

      type PiStart = (
        event: { prompt: string; systemPrompt: string },
        ctx: ExtensionContext,
      ) => Promise<{ systemPrompt: string } | undefined>;
      let beforePiStart: PiStart | undefined;
      registerAutoContext(
        {
          on: (event: string, handler: PiStart) => {
            if (event === "before_agent_start") beforePiStart = handler;
          },
        } as unknown as ExtensionAPI,
        { onDiagnostics },
      );

      let task: (typeof tasks)[number];
      const { transform } = createContextTransform(
        async () => ({
          directory: cwd,
          prompt: task.prompt,
          messageID: task.name,
        }),
        { onDiagnostics },
      );
      type SystemInput = Parameters<NonNullable<Hooks["experimental.chat.system.transform"]>>[0];

      const results = [];
      for (task of tasks) {
        const { system, window, prompt, ids, expected } = task;
        const output = 256;
        const envelope = harness === "opencode" ? 16 : 0;
        const cost = (injected: string) =>
          injected ? countContextTokens(injected) + 2 + envelope : 0;
        const budget = Math.min(
          4800,
          window - output - countContextTokens(system) - countContextTokens(prompt) - 16 - envelope,
        );
        const raw = await runOpAtDirectory(cwd, contextualRecallOp({ intent: "task", prompt }));
        const baseline =
          raw.text ||
          (harness === "opencode" && raw.details.reason === "weak"
            ? (await runOpAtDirectory(cwd, autoContextOp())).text
            : "");
        // The fixture admits the prior bounded output under the same effective
        // cap. Dropping over-budget baselines would bias the comparison.
        expect(cost(baseline)).toBeLessThanOrEqual(budget);

        diagnostics = undefined;
        let compacted: string;
        if (harness === "pi") {
          const result = await beforePiStart!({ prompt, systemPrompt: system }, {
            cwd,
            model: { contextWindow: window, maxTokens: output },
          } as ExtensionContext);
          compacted = result?.systemPrompt.slice(system.length + 2) ?? "";
        } else {
          const out = { system: [system] };
          await transform(
            {
              sessionID: "config-session",
              model: { id: "fixture", providerID: "fixture", limit: { context: window, output } },
            } as SystemInput,
            out,
          );
          expect(out.system[0]).toBe(system);
          compacted = out.system[1] ?? "";
        }

        const baselineRecall = recallAtFive(system, baseline, ids);
        const compactedRecall = recallAtFive(system, compacted, ids);
        expect(baselineRecall).toBe(ids.length);
        expect(compactedRecall).toBe(baselineRecall);
        expect(proposeConfig(`${system}\n\n${baseline}`, prompt)).toEqual(expected);
        expect(proposeConfig(`${system}\n\n${compacted}`, prompt)).toEqual(expected);
        expect(compacted).not.toContain("999");
        expect(compacted).not.toContain("candidateOverflow");
        expect(diagnostics).toMatchObject({ effective: budget, used: cost(compacted) });
        results.push({ case: task.name, baseline: cost(baseline), compacted: cost(compacted) });
      }
      expect(results.reduce((sum, row) => sum + row.compacted, 0)).toBeLessThan(
        results.reduce((sum, row) => sum + row.baseline, 0),
      );
      if (process.env.ENGRAM_PRINT_COMPACTION_EVAL)
        process.stdout.write(JSON.stringify({ harness, results }) + "\n");
    } finally {
      vi.unstubAllEnvs();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);
