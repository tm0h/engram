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
  canonical,
  planInstall,
  planUninstall,
  scanAssets,
  type InstallPlan,
  type InstallSpec,
  type JsonValue,
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
  parseSidecarLedger,
  SIDECAR_FILENAME,
} from "@engram/harnesses/installer";
import { out } from "../io.js";

export interface InstallOptions {
  readonly target: string;
  readonly uninstall?: boolean;
  readonly status?: boolean;
  readonly dryRun?: boolean;
  readonly yes?: boolean;
  /**
   * Home override (tests and unusual setups). Precedence: --home wins over
   * the target's config-dir env override (CODEX_HOME / CLAUDE_CONFIG_DIR),
   * which wins over the OS home default.
   */
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

/**
 * Ownership report from scanned state (reviews P2a + turn-5 P2): the
 * sidecar is the ownership record, so identities count as owned only when
 * the sidecar is present and exactly the managed block AND the entry is
 * present in the host config. Entries that merely match the spec content
 * without a ledger claim are reported separately, never as owned.
 */
const ownershipReport = (
  scan: ScanResult,
): { owned: ReadonlyArray<string>; unownedMatches: ReadonlyArray<string> } => {
  const owned = new Set<string>();
  const unowned = new Set<string>();
  const sidecarState = scan.states.find(
    (s) => s.spec.kind === "file" && s.spec.path === SIDECAR_FILENAME,
  );
  const ledger =
    sidecarState !== undefined && sidecarState.status === "current" && sidecarState.current !== null
      ? parseSidecarLedger(sidecarState.current)
      : null;
  const ledgerIds = new Set((ledger?.entries ?? []).map((e: { identity: string }) => e.identity));

  for (const state of scan.states) {
    const spec = state.spec;
    if (spec.kind !== "jsonEntries" || state.current === null) continue;
    let doc: JsonValue;
    try {
      doc = JSON.parse(state.current) as JsonValue;
    } catch {
      continue;
    }
    let node: JsonValue = doc;
    for (const key of spec.mapPath) {
      if (typeof node !== "object" || node === null || Array.isArray(node)) {
        return { owned: [...owned], unownedMatches: [...unowned] };
      }
      const next: JsonValue | undefined = (node as Record<string, JsonValue>)[key];
      if (next === undefined) return { owned: [...owned], unownedMatches: [...unowned] };
      node = next;
    }
    if (typeof node !== "object" || node === null || Array.isArray(node)) continue;
    for (const entry of spec.entries) {
      const arr = (node as Record<string, JsonValue>)[entry.key];
      if (!Array.isArray(arr)) continue;
      for (const g of arr) {
        if (typeof g !== "object" || g === null || Array.isArray(g)) continue;
        for (const group of entry.groups) {
          if (canonical(group.group) !== canonical(g as JsonValue)) continue;
          if (
            (spec.entryMarker !== undefined &&
              (g as Record<string, JsonValue>)[spec.entryMarker] === group.identity) ||
            ledgerIds.has(group.identity)
          ) {
            owned.add(group.identity);
          } else {
            unowned.add(group.identity);
          }
        }
      }
    }
  }
  return { owned: [...owned], unownedMatches: [...unowned] };
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
    // Review P1d: respect the hosts' documented config-dir overrides.
    // --home wins (explicit test/power-user override); otherwise CODEX_HOME
    // and CLAUDE_CONFIG_DIR point at the config directory itself; otherwise
    // the OS home default applies.
    const envDir =
      opts.target === CODEX_TARGET
        ? process.env.CODEX_HOME
        : opts.target === CLAUDE_CODE_TARGET
          ? process.env.CLAUDE_CONFIG_DIR
          : undefined;
    // CODEX_HOME and CLAUDE_CONFIG_DIR point at the config directory itself,
    // so they replace the derived root instead of nesting under it.
    const root =
      opts.home !== undefined
        ? t.root(opts.home)
        : envDir !== undefined && envDir !== ""
          ? envDir
          : t.root(os.homedir());
    const scan = yield* scanAssets(root, t.spec);
    const verb = opts.uninstall ? "Uninstall" : "Install";

    // status is a strictly read-only view
    if (opts.status) {
      const extra: string[] = [];
      const report = ownershipReport(scan);
      if (report.owned.length > 0) {
        extra.push(
          `engram-owned entries: ${[...report.owned].sort((a, b) => a.localeCompare(b)).join(", ")}`,
        );
      }
      if (report.unownedMatches.length > 0) {
        extra.push(
          `matches engram spec but not owned: ${[...report.unownedMatches]
            .sort((a, b) => a.localeCompare(b))
            .join(", ")}`,
        );
      }
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
      const blockedStates = scan.states.filter((s) => s.status === "blocked");
      const driftStates = scan.states.filter((s) => s.status === "drift");
      if (blockedStates.length > 0) {
        // Review F6/leader follow-up: a blocked file is not recognizable as
        // engram's, so --yes cannot repair it (P1a refuses); the ledger file
        // must go first.
        yield* out(
          'tip: blocked files are not recognizable as engram\'s — remove or rename them manually, then "engram install <target> --yes" reinstalls (rebuilding the ledger) or "engram install <target> --yes --uninstall" removes engram\'s entries',
        );
      } else if (driftStates.length > 0) {
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

    // Review P1a: never apply a plan with blocked assets — for installs this
    // would write hooks without their ownership ledger. Dry-run above is the
    // read-only preview; a real run refuses until the block is resolved.
    if (plan.blocked.length > 0) {
      return yield* Effect.fail(
        new Error(
          `refusing to ${verb.toLowerCase()} hooks for ${opts.target}: blocked asset(s): ` +
            plan.blocked
              .map((b) => `${b.id} (${b.status}): ${b.reasons.map(renderReason).join("; ")}`)
              .join("; "),
        ),
      );
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
