/**
 * `engram install <target>` — manage engram integration assets for a host
 * or project, as data-driven specs over the ENG-34 installer core
 * (@engram/harnesses/shared installer).
 *
 * Leader rulings (handoffs/turn-1-eng58.md, SPEC eng37-impl):
 * - A4: interactive confirmation by default; non-TTY without --yes refuses
 *   with a clear error; status and dry-run never write; idempotent re-runs
 *   still confirm unless --yes.
 * - A8: no backup files; dry-run plus confirmation only.
 * - A3: removal touches only entries carrying engram ownership markers.
 * - A5: installed hook entries invoke `engram` bare; PATH resolves at hook
 *   runtime, never an install-time absolute path.
 * - ENG-37 roots: user-level targets (claude-code, codex) root under the
 *   OS home (or --home). Project-local targets use the project directory
 *   and OpenClaw uses the agent workspace. Both use --root (default cwd)
 *   and reject --home. Hermes requires --root for an existing profile.
 *   Config-dir overrides apply only to user-level targets.
 */
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import chalk from "chalk";
import { lstat } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
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
  TEMP_SUFFIX,
} from "@engram/harnesses/shared";
import {
  CLAUDE_CODE_TARGET,
  CLAUDE_TARGET,
  CODEX_TARGET,
  CURSOR_TARGET,
  GENERIC_TARGET,
  HERMES_SKILL_PATH,
  HERMES_TARGET,
  OPENCLAW_TARGET,
  claudeCodeRoot,
  claudeCodeSpec,
  claudeRoot,
  claudeSpec,
  codexHooksFlagState,
  codexRoot,
  codexSpec,
  cursorRoot,
  cursorSpec,
  genericRoot,
  genericSpec,
  hermesSpec,
  openclawRoot,
  openclawSpec,
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
   * Home override for user-level targets (tests and unusual setups).
   * Precedence: --home wins over the target's config-dir env override
   * (CODEX_HOME / CLAUDE_CONFIG_DIR), which wins over the OS home default.
   * Project targets reject it (hard error naming --root).
   */
  readonly home?: string;
  /**
   * Project directory, OpenClaw agent workspace, or Hermes profile directory.
   * Hermes requires an explicit directory. Other --root targets default to cwd.
   */
  readonly root?: string;
}

/** Project-local targets install inside a project directory (ENG-37). */
const PROJECT_TARGETS = [GENERIC_TARGET, "cursor", "claude"] as const;

export const INSTALL_TARGETS = [
  ...PROJECT_TARGETS,
  CLAUDE_CODE_TARGET,
  CODEX_TARGET,
  OPENCLAW_TARGET,
  HERMES_TARGET,
];
const TARGET_MENU = INSTALL_TARGETS.join(" | ");

type TargetModule =
  | {
      readonly kind: "home";
      readonly spec: InstallSpec;
      readonly root: (home: string) => string;
    }
  | {
      readonly kind: "project" | "profile";
      readonly spec: InstallSpec;
      readonly root: (projectRoot: string) => string;
    };

export const targetFor = (target: string): TargetModule | null => {
  if (target === GENERIC_TARGET) {
    return { kind: "project", spec: genericSpec(), root: genericRoot };
  }
  if (target === CURSOR_TARGET) {
    return { kind: "project", spec: cursorSpec(), root: cursorRoot };
  }
  if (target === CLAUDE_TARGET) {
    return { kind: "project", spec: claudeSpec(), root: claudeRoot };
  }
  if (target === OPENCLAW_TARGET) {
    return { kind: "project", spec: openclawSpec(), root: openclawRoot };
  }
  if (target === HERMES_TARGET) {
    return { kind: "profile", spec: hermesSpec(), root: resolve };
  }
  if (target === CLAUDE_CODE_TARGET) {
    return { kind: "home", spec: claudeCodeSpec(), root: claudeCodeRoot };
  }
  if (target === CODEX_TARGET) return { kind: "home", spec: codexSpec(), root: codexRoot };
  return null;
};

export const userInstallRoot = (
  target: string,
  derive: (home: string) => string,
  home?: string,
) => {
  const envDir =
    target === CODEX_TARGET
      ? process.env.CODEX_HOME
      : target === CLAUDE_CODE_TARGET
        ? process.env.CLAUDE_CONFIG_DIR
        : undefined;
  return home !== undefined ? derive(home) : envDir || derive(os.homedir());
};

export const readCodexHooksFlag = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    const config = path.join(root, "config.toml");
    return codexHooksFlagState(
      (yield* fs.exists(config)) ? yield* fs.readFileString(config) : null,
    );
  });

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

// A Hermes skill tree can be shared through symlinks. Check the paths the
// installer reads, creates, replaces, or stages before touching the profile.
const checkHermesProfilePaths = async (root: string) => {
  const skill = join(root, HERMES_SKILL_PATH);
  const directories = [root, join(root, "skills"), dirname(skill)];
  for (const file of [...directories, skill, skill + TEMP_SUFFIX]) {
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        if (file !== root) return null;
        throw new Error(`Hermes profile directory does not exist: ${root}`);
      }
      throw error;
    });
    if (info === null) continue;
    if (info.isSymbolicLink())
      throw new Error(`refusing Hermes profile path through symbolic link: ${file}`);
    if (directories.includes(file) ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) {
      throw new Error(`refusing unexpected Hermes profile path: ${file}`);
    }
  }
};

const validateHermesProfile = (root: string) =>
  Effect.tryPromise({
    try: () => checkHermesProfilePaths(root),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });

export const installCommand = (opts: InstallOptions) =>
  Effect.gen(function* () {
    chalk.level = 0;
    const t = targetFor(opts.target);
    if (t === null) {
      return yield* Effect.fail(
        new Error(`unknown install target "${opts.target}" (expected: ${TARGET_MENU})`),
      );
    }
    const fs = yield* FileSystem;
    // ENG-37 roots (SPEC decision 1): user-level targets keep the --home /
    // env-override / OS-home precedence; project targets root at the project
    // directory (--root, default cwd) and never consult --home or env dirs.
    let root: string;
    if (t.kind === "profile") {
      if (opts.home !== undefined || opts.root === undefined || opts.root.trim() === "") {
        return yield* Effect.fail(
          new Error(
            "Use --root <dir> to select the existing Hermes profile directory. --home does not apply.",
          ),
        );
      }
      root = t.root(opts.root);
      yield* validateHermesProfile(root);
    } else if (t.kind === "project") {
      if (opts.home !== undefined) {
        return yield* Effect.fail(
          new Error(
            `--home does not apply to project targets (${[...PROJECT_TARGETS, OPENCLAW_TARGET].join(" | ")}): ` +
              `Use --root <dir> to select the project or OpenClaw workspace.`,
          ),
        );
      }
      root = opts.root !== undefined ? t.root(opts.root) : process.cwd();
      // never create a project root out of a typo'd --root
      if (!(yield* fs.exists(root))) {
        return yield* Effect.fail(new Error(`project root does not exist: ${root}`));
      }
    } else {
      root = userInstallRoot(opts.target, t.root, opts.home);
    }
    const scanned = yield* scanAssets(root, t.spec);
    const scan: ScanResult =
      t.kind === "profile"
        ? {
            ...scanned,
            states: scanned.states.map((state) =>
              state.status === "drift"
                ? { ...state, status: "blocked", reasons: ["managed skill has local edits"] }
                : state,
            ),
          }
        : scanned;
    const verb = opts.uninstall ? "Uninstall" : "Install";
    const noun = t.kind === "home" ? "hooks" : "files";

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
        const flag = yield* readCodexHooksFlag(root);
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
          `refusing to ${verb.toLowerCase()} ${noun} for ${opts.target}: blocked asset(s): ` +
            plan.blocked
              .map((b) => `${b.id} (${b.status}): ${b.reasons.map(renderReason).join("; ")}`)
              .join("; "),
        ),
      );
    }

    // A4: explicit confirmation before modifying user config, including
    // idempotent re-runs with no pending changes.
    yield* out(`${verb} ${noun} for ${opts.target} in ${root}:`);
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
        `Nothing to do: ${noun} for ${opts.target} are already ${opts.uninstall ? "absent" : "up to date"}.`,
      );
      return;
    }
    // A fresh host home may not contain the target directory yet; the core
    // stages writes inside the target directory, so it must exist first.
    // Project and profile roots must already exist.
    if (t.kind === "profile") {
      yield* validateHermesProfile(root);
      const latest = yield* scanAssets(root, t.spec);
      if (latest.states[0]?.current !== scan.states[0]?.current) {
        return yield* Effect.fail(
          new Error("Hermes skill changed during confirmation. Re-run the installer."),
        );
      }
    } else if (t.kind === "home") {
      yield* fs.makeDirectory(root, { recursive: true });
    }
    yield* applyPlan(root, plan);
    const changed = plan.actions.filter((a) => a.op !== "mkdir").length;
    yield* out(
      `${verb === "Uninstall" ? "Uninstalled" : "Installed"} ${changed} change(s) for ${opts.target} in ${root}.`,
    );
  });
