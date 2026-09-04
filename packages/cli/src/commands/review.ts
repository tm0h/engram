/** `engram review`: surface entries needing human attention — superseded,
 * archived, time-expired (expires <= now), review-due (reviewAfter <= now),
 * and broken lineage (supersedes pointing at an id that does not resolve in
 * the same scope). Read-only: the report is the product.
 *
 * Report contract (ENG-17 R10-R12, pinned by review.test.ts):
 *
 * - JSON: one self-contained document on stdout:
 *     {
 *       "report": "review",
 *       "version": 1,
 *       "ok": boolean,          // no findings AND no error-severity scan
 *                               // diagnostics
 *       "scopes": [             // in scan order
 *         { "scope": "project", "entries": n, "findings": n,
 *           "diagnostics": n }
 *       ],
 *       "findings": [           // one finding PER ENTRY, sorted by scope
 *         {                     // (scan order) then id
 *           "id": "0002",
 *           "scope": "project",
 *           "file": "<absolute path>",
 *           "title": "Superseded note",
 *           "reasons": ["superseded"]   // stable codes, canonical order
 *         }
 *       ],
 *       "diagnostics": [ ...StoreDiagnostic... ]  // candidate-level scan
 *     }                                           // defects, passthrough
 *
 * - Reason codes and their canonical order (an entry with several conditions
 *   yields ONE finding whose reasons follow this order):
 *     superseded, archived, expired, review_due, broken_supersedes
 *   `expired`/`review_due` use the inclusive `timestamp <= now` boundary,
 *   matching `effectiveStatus` and `lifecycleDiagnostics`; one `now` is
 *   captured per invocation (the `now` option is a test seam; production
 *   callers omit it).
 *   `broken_supersedes` means `supersedes` does not resolve to a valid
 *   readable entry in the same scope. An existing target is never "broken"
 *   merely for being expired or inactive — those targets are reviewed on
 *   their own merits.
 * - Human mode renders the same data: a per-scope summary line, then one
 *   block per finding in the same deterministic order, then one bounded
 *   line for skipped (malformed/unreadable) candidates.
 * - Empty report: `ok: true` with empty arrays, and the human line
 *   "(nothing to review: 0 findings)". Both modes exit 0.
 * - Exit contract (R11): candidate-level scan diagnostics (malformed or
 *   unreadable entries) are report data in BOTH modes with exit 0 — they
 *   never vanish. Discovery/operation failures are errors with a non-zero
 *   exit: an uninitialized explicit `--scope project`, or a store directory
 *   that cannot be listed. On those paths nothing is printed to stdout, so
 *   JSON output is parseable on every path that prints it.
 * - Scope resolution follows the other read commands: default is project
 *   when initialized, else personal; `--scope all` outside a project
 *   degrades to personal (documented degradation, not an error).
 */
import { Effect, Option } from "effect";
import chalk from "chalk";
import {
  EngramStore,
  ProjectNotInitializedError,
  ValidationError,
  compareDiagnostics,
  parseTimestamp,
} from "@engram/core";
import type { Engram, Scope, StoreDiagnostic, StoreScan } from "@engram/core";
import { out } from "../io.js";

export interface ReviewOptions {
  readonly scope?: string;
  readonly json?: boolean;
  /** Test seam (ENG-17 R12): the single captured instant for expiry and
   * review-due boundaries. Production callers omit it; the command then
   * captures `Date.now()` exactly once. */
  readonly now?: number;
}

const REVIEW_SCOPES: ReadonlyArray<string> = ["personal", "project", "all"];

/** Stable reason codes, in their canonical order (R10): an entry matching
 * several conditions yields ONE finding whose reasons follow this order. */
const REASON_ORDER = [
  "superseded",
  "archived",
  "expired",
  "review_due",
  "broken_supersedes",
] as const;
type Reason = (typeof REASON_ORDER)[number];

interface Finding {
  readonly id: string;
  readonly scope: Scope;
  readonly file: string;
  readonly title: string;
  readonly reasons: ReadonlyArray<Reason>;
}

const reasonsFor = (m: Engram, knownIds: ReadonlySet<string>, nowMs: number): Reason[] => {
  const reasons: Reason[] = [];
  if (m.status === "superseded") reasons.push("superseded");
  if (m.status === "archived") reasons.push("archived");
  const expiresMs = m.expires === undefined ? undefined : parseTimestamp(m.expires);
  if (expiresMs !== undefined && expiresMs <= nowMs) reasons.push("expired");
  const reviewMs = m.reviewAfter === undefined ? undefined : parseTimestamp(m.reviewAfter);
  if (reviewMs !== undefined && reviewMs <= nowMs) reasons.push("review_due");
  // Broken lineage: the claimed predecessor does not resolve to a valid
  // readable entry in the SAME scope. An existing target — even an expired
  // or inactive one — is not broken; it is reviewed on its own merits.
  if (m.supersedes !== undefined && !knownIds.has(m.supersedes)) reasons.push("broken_supersedes");
  return reasons.sort((a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b));
};

const scopeIndex = (scopes: ReadonlyArray<Scope>) => {
  const order = new Map<Scope, number>(scopes.map((s, i) => [s, i] as const));
  return (a: Scope, b: Scope): number => (order.get(a) ?? 0) - (order.get(b) ?? 0);
};

export const reviewCommand = (opts: ReviewOptions) =>
  Effect.gen(function* () {
    const store = yield* EngramStore;
    const nowMs = opts.now ?? Date.now();

    // Option validation before any scanning (usage errors are not scope
    // states), mirroring `engram check`.
    if (opts.scope !== undefined && !REVIEW_SCOPES.includes(opts.scope)) {
      return yield* Effect.fail(
        new ValidationError({
          message: `invalid scope "${opts.scope}". Valid: ${REVIEW_SCOPES.join(", ")}.`,
        }),
      );
    }

    // Scope resolution (documented in the header comment): default follows
    // the other read commands; explicit project outside a project is an
    // operation error; `all` outside a project degrades to personal.
    const root = yield* store.projectRoot();
    const initialized = Option.isSome(root);
    let scopes: Scope[];
    if (opts.scope === "personal") scopes = ["personal"];
    else if (opts.scope === "project") {
      if (!initialized) {
        // R11: an uninitialized explicit project scope is an operation error
        // (non-zero exit), not an empty report — same convention as the
        // store boundary for writing.
        return yield* Effect.fail(new ProjectNotInitializedError({ cwd: process.cwd() }));
      }
      scopes = ["project"];
    } else if (opts.scope === "all") scopes = initialized ? ["project", "personal"] : ["personal"];
    else scopes = [initialized ? "project" : "personal"];

    // One scan per scope; a scan failure (store directory cannot be listed)
    // is an operation error with a non-zero exit (R11).
    const scans: Array<StoreScan> = [];
    for (const scope of scopes) {
      scans.push(yield* store.scan(scope));
    }

    // Findings: one per entry at most, reasons in canonical order, sorted by
    // scope (scan order) then id.
    const byIdOrder = scopeIndex(scopes);
    const findings: Finding[] = scans
      .flatMap((scan) => {
        const knownIds = new Set(scan.entries.map((m) => m.id));
        return scan.entries
          .map((m) => ({ m, reasons: reasonsFor(m, knownIds, nowMs) }))
          .filter(({ reasons }) => reasons.length > 0)
          .map(({ m, reasons }) => ({
            id: m.id,
            scope: m.scope,
            file: m.path,
            title: m.title,
            reasons,
          }));
      })
      .sort(
        (a, b) =>
          byIdOrder(a.scope, b.scope) || a.id.localeCompare(b.id) || a.file.localeCompare(b.file),
      );

    const diagnostics: ReadonlyArray<StoreDiagnostic> = scans
      .flatMap((s) => s.diagnostics)
      .sort(compareDiagnostics);

    const scopeCounts = scans.map((s) => {
      const scopeFindings = findings.filter((f) => f.scope === s.scope).length;
      return {
        scope: s.scope,
        entries: s.entries.length,
        findings: scopeFindings,
        diagnostics: s.diagnostics.length,
      };
    });
    const ok = findings.length === 0 && diagnostics.every((d) => d.severity !== "error");

    if (opts.json) {
      // Exactly one self-contained JSON document on stdout (parseable on
      // every path that prints it); any summary stays off stdout.
      yield* out(
        JSON.stringify(
          {
            report: "review",
            version: 1,
            ok,
            scopes: scopeCounts,
            findings,
            diagnostics,
          },
          null,
          2,
        ),
      );
      return;
    }

    // Human mode: the same data, deterministic order.
    yield* out("# Engram review");
    if (findings.length === 0 && diagnostics.length === 0) {
      yield* out(chalk.gray(`  (nothing to review: 0 findings across ${scopes.length} scope(s))`));
      return;
    }
    for (const c of scopeCounts) {
      yield* out(
        `  ${c.scope}: ${c.entries} ${c.entries === 1 ? "entry" : "entries"}, ${c.findings} finding${c.findings === 1 ? "" : "s"}`,
      );
    }
    for (const f of findings) {
      yield* out(`  [${f.scope}] ${f.id} ${f.reasons.join(",")} — ${f.title}`);
      yield* out(`    file: ${f.file}`);
      yield* out(chalk.gray(`    reasons: ${f.reasons.join(", ")}`));
    }
    // R11: candidate-level defects are report data in BOTH modes — they
    // never vanish behind the bounded skipped-file summary.
    for (const d of diagnostics) {
      const label = d.severity === "warning" ? chalk.yellow("warning") : chalk.red("error");
      yield* out(`  ${label} [${d.code}] ${d.file}`);
      yield* out(`    ${d.message}`);
      yield* out(chalk.gray(`    ${d.hint}`));
    }
    const omitted = scans.reduce((n, s) => n + s.omittedFiles, 0);
    if (omitted > 0) {
      yield* out(
        chalk.yellow(
          `  ⚠ ${omitted} unreadable or invalid ${omitted === 1 ? "file" : "files"} skipped: run \`engram check\``,
        ),
      );
    }
  });
