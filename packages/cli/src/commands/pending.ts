import { createHash } from "node:crypto";
import { Effect, Result } from "effect";
import {
  EngramStore,
  ValidationError,
  formatWriteAdvisory,
  inspectPendingCandidate,
  isPendingCandidateId,
  isValidScopeArg,
  listPendingIds,
  parsePendingPatch,
  patchPendingCandidate,
  readPendingCandidate,
  removePendingCandidate,
  scopesToQuery,
  withPendingCandidateLock,
} from "@engram/core";
import type { Scope, SecretScanBlockedError, WriteAdvisoryError } from "@engram/core";
import { isInteractive, promptConfirm } from "../interactive.js";
import { err, out, readStdin } from "../io.js";

type Action = "list" | "show" | "edit" | "approve" | "reject";

interface PendingOptions {
  readonly scope?: string;
  readonly json?: boolean;
  readonly dryRun?: boolean;
  readonly yes?: boolean;
  readonly confirmWrite?: boolean;
  readonly expect?: string;
  readonly patch?: string;
  readonly stdin?: boolean;
}

const reviewError = (error: unknown) => {
  const tag = typeof error === "object" && error !== null && "_tag" in error ? error._tag : "";
  switch (tag) {
    case "WriteAdvisoryError": {
      const advisory = error as WriteAdvisoryError;
      const guidance =
        advisory.candidates[0].kind === "exact_duplicate"
          ? "\nEdit the candidate to record distinct information, or reject it."
          : "";
      return {
        code: advisory.candidates[0].kind,
        message: formatWriteAdvisory(advisory, "--confirm-write") + guidance,
        candidates: advisory.candidates,
      };
    }
    case "SecretScanBlockedError": {
      const { findings } = error as SecretScanBlockedError;
      return {
        code: "sensitive_content",
        message:
          "Sensitive or unsafe content. Remove flagged text with pending edit, or reject the candidate.",
        findings,
      };
    }
    case "FrontmatterParseError":
      return {
        code: "invalid_memory",
        message:
          "Canonical memory validation failed. Check the proposed title, type, and tags, or reject the candidate if its provenance or timestamp is invalid.",
      };
    case "ValidationError": {
      const { message } = error as ValidationError;
      return {
        code: "invalid",
        message:
          message === "Invalid pending candidate."
            ? message +
              " Check the queue schema, provenance and timestamp, or reject the candidate."
            : message,
      };
    }
    case "ProjectNotInitializedError":
      return {
        code: "project_missing",
        message: "Initialize project memory with engram init or use --scope personal.",
      };
    case "PlatformError":
      if (
        "reason" in (error as object) &&
        (error as { reason: { _tag: string } }).reason._tag === "NotFound"
      ) {
        return {
          code: "not_found",
          message:
            "Candidate is no longer pending or is missing in this scope. Run engram pending list.",
        };
      }
      break;
  }
  return {
    code: "io_error",
    message: "Could not access the queue or memory store. Check permissions and retry.",
  };
};

// Escape control bytes in prose. For Markdown with control bytes use its
// JSON string encoding, which retains the exact file bytes in the preview.
// eslint-disable-next-line no-control-regex
const terminalControl = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const safeTerminal = (text: string): string =>
  terminalControl.test(text) ? JSON.stringify(text) : text;
const previewMarkdown = (markdown: string): string =>
  terminalControl.test(markdown) ? "Markdown (JSON string)\n" + JSON.stringify(markdown) : markdown;

export const pendingCommand = (action: Action, ids: string[], opts: PendingOptions) =>
  Effect.gen(function* () {
    const execute = Effect.gen(function* () {
      if (
        opts.scope !== undefined &&
        !isValidScopeArg(opts.scope) &&
        !(opts.scope === "all" && action === "list")
      ) {
        return yield* Effect.fail(
          new ValidationError({
            message:
              action === "list"
                ? "Use --scope project, personal, or all."
                : "Use --scope project or personal.",
          }),
        );
      }
      const store = yield* EngramStore;
      const scopes = scopesToQuery(opts.scope, yield* store.projectRoot());
      const patch =
        action === "edit"
          ? yield* parsePendingPatch(opts.stdin ? yield* readStdin() : (opts.patch ?? ""))
          : undefined;
      if (
        action === "approve" &&
        !opts.dryRun &&
        !opts.yes &&
        (opts.json || !(yield* isInteractive()))
      ) {
        return yield* Effect.fail(
          new ValidationError({
            message: "Pass --dry-run to preview, or --yes to approve non-interactively.",
          }),
        );
      }

      if (
        opts.expect !== undefined &&
        (!opts.yes || ids.length !== 1 || !/^[a-f0-9]{64}$/.test(opts.expect))
      ) {
        return yield* Effect.fail(
          new ValidationError({
            message: "Use --expect with --yes, one candidate ID, and its preview revision.",
          }),
        );
      }

      const review = Effect.fnUntraced(function* (scope: Scope, id: string) {
        if (action === "list" || action === "show") {
          const candidate = yield* inspectPendingCandidate(scope, id);
          if (action === "show") return { status: "pending", candidate } as const;
          const { title, type } = candidate.proposed;
          return { status: "pending", title, type, created: candidate.created } as const;
        }
        if (action === "reject") {
          yield* withPendingCandidateLock(scope, id, removePendingCandidate(scope, id));
          return { status: "rejected" } as const;
        }
        if (patch !== undefined) {
          yield* withPendingCandidateLock(
            scope,
            id,
            readPendingCandidate(scope, id).pipe(
              Effect.flatMap((candidate) => patchPendingCandidate(candidate, patch)),
            ),
          );
          return { status: "edited" } as const;
        }

        const candidate = yield* inspectPendingCandidate(scope, id);
        const plan = yield* store.approvePending(candidate, { confirmWrite: opts.confirmWrite });
        const revision = createHash("sha256")
          .update(JSON.stringify([candidate, plan.markdown]))
          .digest("hex");
        if (opts.expect !== undefined && opts.expect !== revision) {
          return yield* Effect.fail(
            new ValidationError({
              message: "The candidate no longer matches the expected preview. Run --dry-run again.",
            }),
          );
        }
        if (opts.dryRun) {
          return plan.status === "ready"
            ? ({
                status: "preview",
                canonicalId: plan.id,
                markdown: plan.markdown,
                revision,
              } as const)
            : ({ status: "already_published", canonicalId: plan.id } as const);
        }
        if (plan.status === "ready") {
          // Keep stdout machine-readable in JSON mode. The preview is
          // delivered before the write in both human and scripted flows.
          const preview = `Approval preview for ${scope}:${id} (revision ${revision})\n${previewMarkdown(plan.markdown)}`;
          yield* opts.json ? err(preview) : out(preview);
          if (!opts.yes && !(yield* promptConfirm("Approve this memory?"))) {
            return { status: "declined" } as const;
          }
        }

        return yield* withPendingCandidateLock(
          scope,
          id,
          Effect.gen(function* () {
            const current = yield* inspectPendingCandidate(scope, id);
            if (JSON.stringify(current) !== JSON.stringify(candidate)) {
              return yield* Effect.fail(
                new ValidationError({
                  message: "Candidate changed during review. Preview it again before approving.",
                }),
              );
            }
            const approved = yield* store.approvePending(current, {
              confirmWrite: opts.confirmWrite,
              expectedMarkdown: plan.status === "ready" ? plan.markdown : undefined,
            });
            if (approved.status === "ready") {
              return yield* Effect.fail(
                new ValidationError({
                  message:
                    "The prior canonical approval disappeared. Preview the candidate again before approving.",
                }),
              );
            }
            const cleanup = yield* Effect.result(removePendingCandidate(scope, id));
            return Result.isSuccess(cleanup)
              ? ({
                  status: approved.status === "published" ? "approved" : "already_approved",
                  canonicalId: approved.id,
                } as const)
              : ({
                  status: "cleanup_required",
                  canonicalId: approved.id,
                  message:
                    "Memory is published. Check queue permissions and retry approval to finish cleanup.",
                } as const);
          }),
        );
      });

      const rows = [];
      for (const scope of scopes) {
        const targets = action === "list" ? yield* listPendingIds(scope) : [...new Set(ids)];
        for (const id of targets) {
          const result = yield* Effect.result(review(scope, id));
          const outcome = Result.isSuccess(result)
            ? result.success
            : { status: "failed" as const, ...reviewError(result.failure) };
          rows.push({ scope, id: isPendingCandidateId(id) ? id : null, ...outcome });
        }
      }
      return rows;
    });

    const result = yield* Effect.result(execute);
    if (Result.isFailure(result)) {
      const error = reviewError(result.failure);
      if (opts.json) yield* out(JSON.stringify({ schemaVersion: 1, action, error, results: [] }));
      else yield* err(error.message);
      process.exitCode = 1;
      return;
    }
    const results = result.success;
    if (opts.json) {
      yield* out(JSON.stringify({ schemaVersion: 1, action, results }));
    } else if (results.length === 0) {
      yield* out("No pending candidates.");
    } else {
      for (const row of results) {
        const label = row.id === null ? "Invalid candidate ID" : `${row.scope}:${row.id}`;
        switch (row.status) {
          case "failed":
          case "cleanup_required":
            yield* err(`${label}  ${row.message}`);
            if ("findings" in row && row.findings) {
              for (const finding of row.findings) {
                yield* err(
                  `  line ${finding.line}, column ${finding.column}: ${finding.rule} (${finding.category})`,
                );
              }
            }
            break;
          case "preview":
            yield* out(
              `${label}  preview (revision ${row.revision})\n${previewMarkdown(row.markdown)}`,
            );
            break;
          case "pending":
            yield* out(
              "candidate" in row
                ? safeTerminal(JSON.stringify(row.candidate, null, 2))
                : `${label}  ${row.type}  ${safeTerminal(row.title)}`,
            );
            break;
          default:
            yield* out(
              `${label}  ${row.status}${"canonicalId" in row ? ` [${row.canonicalId}]` : ""}`,
            );
        }
      }
    }
    if (results.some((row) => row.status === "failed" || row.status === "cleanup_required")) {
      process.exitCode = 1;
    }
  });
