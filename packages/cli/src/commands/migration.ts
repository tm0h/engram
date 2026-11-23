import { createHash } from "node:crypto";
import { Effect, Result } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import {
  EngramStore,
  findProjectRoot,
  reviewImport,
  scanContent,
  searchEngrams,
  writeAtomicFile,
  type ImportProposal,
} from "@engram/core";
import {
  prioritizeContext,
  renderBudgetedContext,
  replaceManagedText,
} from "@engram/harnesses/shared";
import { out } from "../io.js";
import {
  DIGEST_BEGIN,
  DIGEST_END,
  DIGEST_ID,
  hasUnsafeDigestSection,
  parseImportMarkdown,
  supportedImportFormat,
} from "../migration-markdown.js";

interface Outcome {
  readonly path: string;
  readonly status: string;
  readonly line?: number;
  readonly reason?: string;
  readonly id?: string;
  readonly rules?: readonly string[];
  readonly candidate?: Pick<ImportProposal, "title" | "body" | "type">;
}

const MAX_MIGRATION_BYTES = 256 * 1024;
const MAX_BATCH = 50;
const MAX_PROPOSALS = 250;
const MAX_PROPOSAL_BYTES = 8 * 1024;
const DIGEST_BUDGET = 2_048;

const safePath = (file: string) => !/[\p{Cc}\p{Cf}]/u.test(file) && !scanContent(file).length;
const failed = (path: string, reason: string, line?: number): Outcome => ({
  path,
  status: "failed",
  reason,
  ...(line === undefined ? {} : { line }),
});
const describe = (row: Outcome) =>
  [
    row.status,
    JSON.stringify(row.path) + (row.line === undefined ? "" : ":" + row.line),
    row.reason,
    row.id,
    row.rules?.join(", "),
    row.candidate && JSON.stringify(row.candidate),
  ]
    .filter(Boolean)
    .join(" ");

const report = (phase: string, results: readonly Outcome[], json: boolean | undefined) =>
  out(
    json
      ? JSON.stringify({ schemaVersion: 1, phase, results })
      : [phase, ...results.map(describe)].join("\n"),
  ).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        if (results.some(({ status }) => status === "failed" || status === "rejected")) {
          process.exitCode = 1;
        }
      }),
    ),
  );

class MigrationFileError extends Error {}

const readText = (absolute: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const info = yield* fs.stat(absolute);
    if (info.type !== "File") return yield* Effect.fail(new MigrationFileError("not_regular_file"));
    if (info.size > MAX_MIGRATION_BYTES)
      return yield* Effect.fail(new MigrationFileError("file_too_large"));
    const bytes = Buffer.from(yield* fs.readFile(absolute));
    if (bytes.length > MAX_MIGRATION_BYTES)
      return yield* Effect.fail(new MigrationFileError("file_too_large"));
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes) || text.includes("\0")) {
      return yield* Effect.fail(new MigrationFileError("invalid_utf8"));
    }
    return { text, mode: info.mode & 0o777 };
  });

export const importCommand = (
  files: string[],
  opts: { format?: string; scope?: string; apply?: boolean; json?: boolean },
) =>
  Effect.gen(function* () {
    if (files.length > MAX_BATCH)
      return yield* Effect.fail(new Error("Pass up to 50 import files."));
    const scope = opts.scope ?? "project";
    if (scope !== "project" && scope !== "personal")
      return yield* Effect.fail(new Error("Use project or personal scope."));
    const path = yield* Path;
    const fs = yield* FileSystem;
    const cwd = process.cwd();
    const root = scope === "project" ? yield* findProjectRoot(fs, path, cwd) : null;
    if (scope === "project" && root === null)
      return yield* Effect.fail(new Error("Run engram init before importing into project memory."));
    const proposals: ImportProposal[] = [];
    const rows: Array<Outcome | number> = [];
    for (const file of files) {
      const absolute = path.resolve(cwd, file);
      const label = path.relative(root ?? cwd, absolute).replaceAll(path.sep, "/");
      if (!safePath(file) || !safePath(label)) {
        rows.push(failed("[redacted path]", "unsafe_path"));
        continue;
      }
      const format = supportedImportFormat(opts.format, label);
      if (!format) {
        rows.push(failed(label, "unsupported_format"));
        continue;
      }
      // Workspace and profile memory may contain personal information.
      if ((format === "hermes" || format === "openclaw") && opts.scope === undefined) {
        rows.push(failed(label, "explicit_scope_required"));
        continue;
      }
      const source = yield* Effect.result(
        Effect.gen(function* () {
          // Personal memory is shared across projects. Use the resolved file
          // path for identity and retain the relative path for review.
          const resolved = scope === "personal" ? yield* fs.realPath(absolute) : absolute;
          const { text } = yield* readText(resolved);
          const fileIdentity =
            scope === "personal" ? createHash("sha256").update(resolved).digest("hex") : undefined;
          return { text, fileIdentity };
        }),
      );
      if (Result.isFailure(source)) {
        rows.push(
          failed(
            label,
            source.failure instanceof MigrationFileError
              ? source.failure.message
              : "source_unavailable",
          ),
        );
        continue;
      }
      const { text, fileIdentity } = source.success;
      const parsed = parseImportMarkdown(text, format, label);
      if (!parsed) {
        rows.push(failed(label, "malformed_source"));
        continue;
      }
      if (!parsed.length) {
        rows.push({ path: label, status: "skipped", reason: "no_candidates" });
        continue;
      }
      if (proposals.length + parsed.length > MAX_PROPOSALS) {
        rows.push(failed(label, "batch_candidate_limit"));
        continue;
      }
      for (const proposal of parsed) {
        if (Buffer.byteLength(proposal.title + proposal.body) > MAX_PROPOSAL_BYTES) {
          rows.push(failed(label, "candidate_too_large", proposal.source.line));
          continue;
        }
        rows.push(proposals.length);
        proposals.push(
          fileIdentity ? { ...proposal, source: { ...proposal.source, fileIdentity } } : proposal,
        );
      }
    }
    const classify = (items: readonly ImportProposal[], apply: boolean) =>
      items.length
        ? reviewImport(items, scope, cwd, apply).pipe(
            Effect.map((rows): readonly Outcome[] => rows),
            Effect.catch(() =>
              Effect.succeed(
                items.map(({ source }) =>
                  failed(
                    source.path,
                    apply ? "queue_unavailable" : "memory_unavailable",
                    source.line,
                  ),
                ),
              ),
            ),
          )
        : Effect.succeed([]);
    const classifications = yield* classify(proposals, false);
    const preview = rows.map((row) => (typeof row === "number" ? classifications[row] : row));
    if (!opts.apply) return yield* report("preview", preview, opts.json);

    // Complete the preview write before staging anything, including when
    // stdout is reserved for the single JSON apply report.
    yield* Effect.callback<void, Error>((resume) => {
      process.stderr.write(["preview", ...preview.map(describe), ""].join("\n"), (error) => {
        resume(error ? Effect.fail(error) : Effect.void);
      });
    });
    const eligible = proposals.filter((_, index) => classifications[index].status === "eligible");
    const applied = yield* classify(eligible, true);
    let index = 0;
    return yield* report(
      "apply",
      preview.map((row) => (row.status === "eligible" ? applied[index++] : row)),
      opts.json,
    );
  });

const digest = Effect.gen(function* () {
  const store = yield* EngramStore;
  const scanned = yield* store.scan("project");
  const entries = searchEngrams(scanned.entries, undefined).map(({ engram }) => engram);
  const candidates = prioritizeContext(
    entries.filter(
      (entry) =>
        !entry.appliesTo?.length &&
        ![entry.title, entry.body, entry.author ?? "", ...entry.tags].some(
          (text) => scanContent(text).length || text.includes(DIGEST_ID),
        ),
    ),
  );
  const singleLine = (text: string) => text.replace(/\s+/g, " ");
  const quoted = candidates.map((entry) => ({
    ...entry,
    title: singleLine(entry.title),
    author: entry.author === undefined ? undefined : singleLine(entry.author),
    tags: entry.tags.map(singleLine),
    // Keep stored Markdown inside the digest even when its body is truncated.
    body: entry.body
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => "> " + line)
      .join("\n"),
  }));
  const { text } = renderBudgetedContext(quoted, {
    tokens: DIGEST_BUDGET,
    scopes: ["project"],
    full: true,
    omittedFiles: scanned.omittedFiles,
    duplicateIds: scanned.duplicateIds.length,
    limited: entries.length - candidates.length,
  });
  return text;
});

export const exportCommand = (files: string[], opts: { json?: boolean }) =>
  Effect.gen(function* () {
    if (files.length > MAX_BATCH)
      return yield* Effect.fail(new Error("Pass up to 50 export files."));
    const fs = yield* FileSystem;
    const path = yield* Path;
    const cwd = process.cwd();
    const project = yield* findProjectRoot(fs, path, cwd);
    if (project === null)
      return yield* Effect.fail(new Error("Run engram init before exporting project memory."));
    const root = yield* fs.realPath(project);
    const content = yield* digest;
    const results: Outcome[] = [];
    for (const file of files) {
      if (!safePath(file)) {
        results.push(failed("[redacted path]", "unsafe_path"));
        continue;
      }
      const relative = path.relative(project, path.resolve(cwd, file));
      if (!safePath(relative)) {
        results.push(failed("[redacted path]", "unsafe_path"));
        continue;
      }
      if (
        path.isAbsolute(file) ||
        path.isAbsolute(relative) ||
        !/\.md$/i.test(relative) ||
        relative
          .split(path.sep)
          .some((part) => ["..", ".git", ".engram"].includes(part.toLowerCase()))
      ) {
        results.push(failed(relative, "target_must_be_project_markdown"));
        continue;
      }
      const target = path.join(root, relative);
      const directory = path.dirname(target);
      const inspect = Effect.gen(function* () {
        if ((yield* fs.realPath(directory)) !== directory) {
          return yield* Effect.fail(new MigrationFileError("symlink_target"));
        }
        const resolved = yield* fs.realPath(target).pipe(
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.succeed(null),
          ),
        );
        if (resolved === null) return null;
        if (resolved !== target)
          return yield* Effect.fail(new MigrationFileError("symlink_target"));
        return yield* readText(target);
      });
      const result = yield* Effect.result(
        Effect.gen(function* () {
          const before = yield* inspect;
          const text = before?.text ?? "";
          const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
          const current = text.slice(bom.length);
          const after = hasUnsafeDigestSection(current)
            ? undefined
            : replaceManagedText(
                {
                  kind: "text",
                  id: DIGEST_ID,
                  path: relative,
                  beginMarker: DIGEST_BEGIN,
                  endMarker: DIGEST_END,
                  content,
                },
                current,
              );
          if (after === undefined)
            return yield* Effect.fail(new MigrationFileError("malformed_managed_section"));
          if (before && bom + after === text) return "unchanged";
          if (Buffer.byteLength(bom + after) > MAX_MIGRATION_BYTES)
            return yield* Effect.fail(new MigrationFileError("file_too_large"));
          const latest = yield* inspect;
          if (latest?.text !== before?.text || latest?.mode !== before?.mode) {
            return yield* Effect.fail(new MigrationFileError("target_changed"));
          }
          yield* writeAtomicFile(directory, path.basename(target), bom + after, {
            mode: before?.mode ?? 0o644,
            replace: before !== null,
          });
          return "written";
        }),
      );
      results.push(
        Result.isSuccess(result)
          ? { path: relative, status: result.success }
          : failed(
              relative,
              result.failure instanceof MigrationFileError
                ? result.failure.message
                : "target_unavailable",
            ),
      );
    }
    yield* report("export", results, opts.json);
  });
