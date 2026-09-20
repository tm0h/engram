/**
 * `engram install <target>` — manage user-level lifecycle hooks for the
 * claude-code and codex hosts (ENG-58), as data-driven specs over the
 * ENG-34 installer core (@engram/harnesses/shared installer).
 *
 * Leader rulings (handoffs/turn-1-eng58.md):
 * - A4: interactive confirmation by default; non-TTY without --yes refuses
 *   with a clear error; status and dry-run never write; idempotent re-runs
 *   still confirm unless --yes.
 * - A8: no backup files; dry-run plus confirmation only.
 * - A3: removal touches only entries carrying engram ownership markers.
 * - A5: installed hook entries invoke `engram` bare; PATH resolves at hook
 *   runtime, never an install-time absolute path.
 */
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import chalk from "chalk";
import os from "node:os";
import process from "node:process";
import readline from "node:readline/promises";
import {
  applyPlan,
  planInstall,
  planUninstall,
  scanAssets,
  type InstallPlan,
  type InstallSpec,
  type ScanResult,
} from "@engram/harnesses/shared";
import {
  CLAUDE_CODE_TARGET,
  CODEX_TARGET,
  claudeCodeRoot,
  claudeCodeSpec,
  codexHooksFlagState,
  codexRoot,
  codexSpec,
} from "@engram/harnesses/installer";
import { out } from "../io.js";

export interface InstallOptions {
  readonly target: string;
  readonly uninstall?: boolean;
  readonly status?: boolean;
  readonly dryRun?: boolean;
  readonly yes?: boolean;
  /** Home override (tests and unusual setups); defaults to the OS home. */
  readonly home?: string;
}

interface TargetModule {
  readonly spec: InstallSpec;
  readonly root: (home: string) => string;
}

const targetFor = (target: string): TargetModule | null => {
  if (target === CLAUDE_CODE_TARGET) return { spec: claudeCodeSpec(), root: claudeCodeRoot };
  if (target === CODEX_TARGET) return { spec: codexSpec(), root: codexRoot };
  return null;
};

/**
 * CLI output never advertises a force flag the install command does not
 * expose; the ENG-34 core reasons stay force-aware for direct core users.
 */
const renderReason = (reason: string): string =>
  reason.replace(/\s*\(use force to (?:overwrite|remove)\)$/, "");

const describePlan = (plan: InstallPlan): ReadonlyArray<string> => {
  const lines: string[] = [];
  for (const action of plan.actions) {
    if (action.op === "mkdir") {
      lines.push(`  create directory ${action.path}`);
      continue;
    }
    if (action.op === "remove") {
      lines.push(`  remove ${action.path} (${action.before.length} bytes)`);
      continue;
    }
    lines.push(
      `  write ${action.path} (${
        action.before === null ? "new file" : `${action.before.length} bytes`
      } -> ${action.after.length} bytes)`,
    );
  }
  for (const blocked of plan.blocked) {
    lines.push(
      `  BLOCKED ${blocked.id} (${blocked.status}): ${blocked.reasons
        .map(renderReason)
        .join("; ")}`,
    );
  }
  return lines;
};

const ownedIdentities = (scan: ScanResult): ReadonlyArray<string> => {
  const ids: string[] = [];
  for (const state of scan.states) {
    if (state.spec.kind === "jsonEntries") {
      for (const entry of state.spec.entries) {
        ids.push(...entry.groups.map((g) => g.identity));
      }
    }
  }
  return ids;
};

export const installCommand = (opts: InstallOptions) =>
  Effect.gen(function* () {
    chalk.level = 0;
    const t = targetFor(opts.target);
    if (t === null) {
      return yield* Effect.fail(
        new Error(
          `unknown install target "${opts.target}" (expected: ${CLAUDE_CODE_TARGET} | ${CODEX_TARGET})`,
        ),
      );
    }
    const fs = yield* FileSystem;
    const path = yield* Path;
    const home = opts.home ?? os.homedir();
    const root = t.root(home);
    const scan = yield* scanAssets(root, t.spec);
    const verb = opts.uninstall ? "Uninstall" : "Install";

    // status is a strictly read-only view
    if (opts.status) {
      const extra: string[] = [];
      const identities = ownedIdentities(scan);
      if (identities.length > 0) extra.push(`engram-owned entries: ${identities.join(", ")}`);
      if (opts.target === CODEX_TARGET) {
        const configPath = path.join(root, "config.toml");
        const text = (yield* fs.exists(configPath)) ? yield* fs.readFileString(configPath) : null;
        const flag = codexHooksFlagState(text);
        extra.push(
          flag === "disabled"
            ? "codex hooks feature: explicitly disabled in config.toml (left untouched; hooks will not run)"
            : `codex hooks feature: ${flag} (stable; enabled by default on codex >= 0.155.1)`,
        );
      }
      yield* out(`target: ${opts.target}`);
      yield* out(`root: ${root}`);
      for (const state of scan.states) {
        yield* out(
          `${state.spec.path}: ${state.status}${
            state.reasons.length > 0 ? ` (${state.reasons.map(renderReason).join("; ")})` : ""
          }`,
        );
      }
      if (scan.states.some((s) => s.status === "blocked" || s.status === "drift")) {
        yield* out(
          'tip: repair with "engram install <target> --yes", then remove with "engram install <target> --yes --uninstall"',
        );
      }
      for (const line of extra) yield* out(line);
      if (scan.leftovers.length > 0) {
        yield* out(`leftover staging files: ${scan.leftovers.join(", ")}`);
      }
      return;
    }

    const plan = opts.uninstall ? planUninstall(scan) : planInstall(scan);
    const actionLines = describePlan(plan);

    // dry-run is a strictly read-only view of the exact plan
    if (opts.dryRun) {
      yield* out(`${verb} plan for ${opts.target} in ${root}:`);
      if (actionLines.length === 0) yield* out("  (no changes needed)");
      for (const line of actionLines) yield* out(line);
      yield* out("Dry run: no changes were written.");
      return;
    }

    // A4: explicit confirmation before modifying user config, including
    // idempotent re-runs with no pending changes.
    yield* out(`${verb} hooks for ${opts.target} in ${root}:`);
    if (actionLines.length === 0) yield* out("  (no changes needed)");
    for (const line of actionLines) yield* out(line);
    if (!opts.yes) {
      if (!process.stdin.isTTY) {
        return yield* Effect.fail(
          new Error(
            `refusing to modify ${root} without confirmation (non-interactive session). Re-run with --yes to proceed.`,
          ),
        );
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = yield* Effect.tryPromise(() => rl.question("Proceed? [y/N] ")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      rl.close();
      if (!/^y(?:es)?$/i.test(answer.trim())) {
        yield* out("Aborted. No changes were made.");
        return;
      }
    }

    if (plan.actions.length === 0) {
      yield* out(
        `Nothing to do: hooks for ${opts.target} are already ${opts.uninstall ? "absent" : "up to date"}.`,
      );
      return;
    }
    // A fresh host home may not contain the target directory yet; the core
    // stages writes inside the target directory, so it must exist first.
    yield* fs.makeDirectory(root, { recursive: true });
    yield* applyPlan(root, plan);
    const changed = plan.actions.filter((a) => a.op !== "mkdir").length;
    yield* out(
      `${verb === "Uninstall" ? "Uninstalled" : "Installed"} ${changed} change(s) for ${opts.target} in ${root}.`,
    );
  });
