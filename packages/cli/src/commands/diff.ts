import { Effect } from "effect";
import { ValidationError } from "@engram/core";
import { out } from "../io.js";
import { compareProjectMemory, maxDiffDetails, type MemoryDiff } from "../memory-diff.js";

function quoted(text: string | null) {
  return text === null
    ? "(unavailable)"
    : JSON.stringify(text).replace(/[\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/gu, (character) => {
        return "\\u{" + character.codePointAt(0)?.toString(16) + "}";
      });
}

function human(report: MemoryDiff) {
  const to = report.to.kind === "commit" ? report.to.sha : "working tree";
  const { totals, omitted } = report;
  const lines = [
    `Project memory ${quoted(report.project)} (${report.mode}): ${report.from.sha} → ${to}`,
    `${totals.changed} changed (${totals.added} added, ${totals.removed} removed, ${totals.modified} modified), ${totals.edited} edited, ${totals.renamed} renamed`,
    `${totals.lifecycleChanged} lifecycle changes (${totals.statusChanged} status, ${totals.supersessionChanged} supersession), ${totals.indeterminate} indeterminate, ${totals.diagnostics} diagnostics`,
  ];
  for (const change of report.changes) {
    const labels = [
      change.kind,
      ...(change.renamed ? ["renamed"] : []),
      ...(change.edited ? ["edited"] : []),
    ];
    const locations = change.renamed
      ? `${quoted(change.beforePath)} → ${quoted(change.afterPath)}`
      : quoted(change.kind === "removed" ? change.beforePath : change.afterPath);
    lines.push(`${change.id} ${labels.join(", ")} ${locations}`);
    for (const [key, value] of Object.entries(change.lifecycle)) {
      lines.push(`  ${key}: ${value.before ?? "(unset)"} → ${value.after ?? "(unset)"}`);
    }
  }
  for (const diagnostic of report.diagnostics) {
    lines.push(
      `${diagnostic.side} ${diagnostic.severity} [${diagnostic.code}] ${quoted(diagnostic.path)}`,
    );
  }
  if (omitted.changes || omitted.diagnostics) {
    lines.push(
      `Omitted ${omitted.changes} changes and ${omitted.diagnostics} diagnostics from detail.`,
    );
  }
  if (!report.complete) lines.push("Comparison incomplete. Check the reported snapshots.");
  return lines.join("\n");
}

export const diffCommand = (
  revision: string | undefined,
  opts: { json?: boolean; limit?: string },
) =>
  Effect.gen(function* () {
    const limit = opts.limit === undefined ? maxDiffDetails : Number(opts.limit);
    if (opts.limit !== undefined && (!/^\d+$/.test(opts.limit) || limit > maxDiffDetails)) {
      return yield* Effect.fail(
        new ValidationError({
          message: "Use an integer from 0 to 100 for --limit.",
        }),
      );
    }
    const report = yield* compareProjectMemory(process.cwd(), revision, limit).pipe(
      Effect.mapError((error) =>
        error instanceof ValidationError
          ? error
          : new ValidationError({
              message: "Cannot locate or compare project memory in this working tree.",
            }),
      ),
    );
    yield* out(opts.json ? JSON.stringify(report, null, 2) : human(report));
    if (!report.complete) process.exitCode = 2;
  });
