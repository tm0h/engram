/** ENG-15: scan-policy resolution and outcome rendering shared by the
 * mutating CLI commands (`add`, `edit`). Policy comes from configuration
 * (project: `secretScan`, personal: `personalSecretScan`) with the core
 * defaults; `--allow-secrets` is the explicit per-write override. */
import { Effect, Option } from "effect";
import chalk from "chalk";
import { ConfigRepo, resolveSecretPolicy } from "@engram/core";
import type { ConfigErrorUnion, ConfigRepoShape } from "@engram/core";
import type { Scope, ScanEvaluation, ScanOptions } from "@engram/core";
import { out } from "./io.js";

/** Resolve the effective scan options for one write. */
export const resolveScanOptions = (
  cfg: ConfigRepoShape,
  scope: Scope,
  projectRoot: Option.Option<string>,
  allowSecrets: boolean,
): Effect.Effect<ScanOptions, ConfigErrorUnion> =>
  Effect.gen(function* () {
    const project = Option.isSome(projectRoot)
      ? (yield* cfg.loadProject(projectRoot.value)).secretScan
      : undefined;
    const personal = (yield* cfg.loadGlobal()).personalSecretScan;
    return { policy: resolveSecretPolicy(scope, { project, personal }), allowSecrets };
  });

/** Render a successful write's scan outcome: a yellow warning per policy
 * `warn`, or an explicit bypass notice when the override was used.
 * Findings are printed as locations only; matched text never appears. */
export const reportScanOutcome = (scan: ScanEvaluation): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (scan.findings.length === 0) return;
    const count = `${scan.findings.length} finding${scan.findings.length === 1 ? "" : "s"}`;
    if (scan.overrideUsed) {
      yield* out(
        chalk.yellow(`⚠ Secret scan bypassed (--allow-secrets): ${count} written anyway.`),
      );
    } else {
      yield* out(chalk.yellow(`⚠ Secret scan warning: ${count}.`));
    }
    for (const f of scan.findings) {
      yield* out(chalk.yellow(`  line ${f.line}, column ${f.column}: ${f.rule} (${f.category})`));
    }
    yield* out(
      chalk.gray(
        "  Keep real secrets in a dedicated secret manager; matched text is never displayed.",
      ),
    );
  });
