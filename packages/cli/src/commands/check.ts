/** `engram check`: report store integrity. Read-only: no repair happens
 * here, the report is the product. */
import { Effect, Option, Result } from "effect";
import chalk from "chalk";
import {
  ConfigRepo,
  EngramStore,
  IntegrityCheckFailedError,
  ValidationError,
  compareDiagnostics,
  type Scope,
  type StoreDiagnostic,
  type StoreScan,
} from "@engram/core";
import { out } from "../io.js";

export interface CheckOptions {
  readonly scope?: string;
  readonly json?: boolean;
}

const CHECK_SCOPES: ReadonlyArray<string> = ["personal", "project", "all"];

interface ScopeCheck {
  readonly scope: Scope;
  readonly scan: StoreScan;
  readonly config: ReadonlyArray<StoreDiagnostic>;
}

/** A requested scope that could not be checked at all (store not
 * initialized, directory unlistable, config unreadable). Structured so the
 * JSON report is self-contained: a consumer can see WHY `ok` is false
 * without reading stderr. */
interface UncheckableScope {
  readonly scope: Scope;
  readonly message: string;
  readonly hint: string;
}

export const checkCommand = (opts: CheckOptions) =>
  Effect.gen(function* () {
    const store = yield* EngramStore;
    const config = yield* ConfigRepo;

    // Option validation happens before any scanning. Usage errors are not
    // scope states; they stay plain validation errors.
    if (opts.scope !== undefined && !CHECK_SCOPES.includes(opts.scope)) {
      return yield* Effect.fail(
        new ValidationError({
          message: `invalid scope "${opts.scope}". Valid: ${CHECK_SCOPES.join(", ")}.`,
        }),
      );
    }

    const root = yield* store.projectRoot();
    const rootValue = Option.isSome(root) ? root.value : undefined;

    // Scope resolution: the default follows the rest of the CLI (project
    // when initialized, otherwise personal). `all` never silently drops a
    // scope, and no scope state is reported only on stderr: every
    // uncheckable scope is structured report data.
    const toCheck: Array<Scope> = [];
    const uncheckable: Array<UncheckableScope> = [];
    if (opts.scope === "project") {
      if (rootValue === undefined) {
        uncheckable.push({
          scope: "project",
          message: `no .engram/ project found in "${process.cwd()}"`,
          hint: "Run `engram init` here, or use `--scope personal` for global memory.",
        });
      } else {
        toCheck.push("project");
      }
    } else if (opts.scope === "personal") {
      toCheck.push("personal");
    } else if (opts.scope === "all") {
      if (rootValue !== undefined) {
        toCheck.push("project");
      } else {
        uncheckable.push({
          scope: "project",
          message: `no .engram/ project found in "${process.cwd()}"`,
          hint: "Run `engram init` here, or use `--scope personal` for global memory.",
        });
      }
      toCheck.push("personal");
    } else {
      // No explicit scope: project when initialized, else personal.
      toCheck.push(rootValue !== undefined ? "project" : "personal");
    }

    const checks: Array<ScopeCheck> = [];
    for (const scope of toCheck) {
      // Operational failures (unlistable store directory, config file that
      // cannot be stat'ed) mean the scope cannot be checked completely.
      // They are report data, not silent skippable defects.
      const scanResult = yield* Effect.result(store.scan(scope));
      if (Result.isFailure(scanResult)) {
        uncheckable.push({
          scope,
          message: `could not scan the ${scope} store: ${(scanResult.failure as Error).message}`,
          hint: "Check the store directory's permissions, then re-run.",
        });
        continue;
      }
      const configResult = yield* Effect.result(
        scope === "personal"
          ? config.validateGlobal()
          : config.validateProject(rootValue as string),
      );
      if (Result.isFailure(configResult)) {
        uncheckable.push({
          scope,
          message: `could not validate the ${scope} config: ${(configResult.failure as Error).message}`,
          hint: "Check the file's permissions, then re-run.",
        });
        continue;
      }
      checks.push({
        scope,
        scan: scanResult.success,
        config: configResult.success,
      });
    }

    const diagnostics = checks
      .flatMap((c) => [...c.scan.diagnostics, ...c.config])
      .sort(compareDiagnostics);
    const filesChecked = checks.reduce((n, c) => n + c.scan.filesChecked, 0);
    const validEntries = checks.reduce((n, c) => n + c.scan.entries.length, 0);
    const omittedFiles = checks.reduce((n, c) => n + c.scan.omittedFiles, 0);
    const ok = diagnostics.length === 0 && uncheckable.length === 0;

    if (opts.json) {
      // Exactly one self-contained JSON document on stdout; any summary goes
      // to stderr.
      yield* out(
        JSON.stringify(
          {
            ok,
            scopes: checks.map((c) => c.scope),
            filesChecked,
            validEntries,
            omittedFiles,
            diagnostics,
            uncheckableScopes: uncheckable,
          },
          null,
          2,
        ),
      );
    } else {
      for (const c of checks) {
        const scopeDiags = [...c.scan.diagnostics, ...c.config];
        if (scopeDiags.length === 0) {
          yield* out(
            `${chalk.green("✓")} ${c.scope}: ${c.scan.filesChecked} files checked, no problems found`,
          );
        } else {
          yield* out(
            `${chalk.red("✗")} ${c.scope}: ${c.scan.filesChecked} files checked, ${
              scopeDiags.length
            } problem${scopeDiags.length === 1 ? "" : "s"} found`,
          );
          for (const d of scopeDiags) {
            yield* out(`${chalk.red("error")} [${d.code}] ${d.file}`);
            yield* out(`  ${d.message}`);
            yield* out(chalk.gray(`  ${d.hint}`));
          }
        }
      }
      for (const u of uncheckable) {
        yield* out(`${chalk.red("✗")} ${u.scope}: could not be checked`);
        yield* out(`  ${u.message}`);
        yield* out(chalk.gray(`  ${u.hint}`));
      }
    }

    if (!ok) {
      const bits: string[] = [];
      if (diagnostics.length > 0) {
        bits.push(`${diagnostics.length} problem${diagnostics.length === 1 ? "" : "s"} found`);
      }
      for (const u of uncheckable) bits.push(`${u.scope} scope could not be checked`);
      return yield* Effect.fail(new IntegrityCheckFailedError({ message: bits.join("; ") }));
    }
  });
