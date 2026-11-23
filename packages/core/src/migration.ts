import { Effect } from "effect";
import type { Engram, EngramType, Scope } from "./domain.js";
import { ValidationError } from "./errors.js";
import {
  enqueuePendingCandidate,
  listPendingIds,
  listPackRejections,
  readPendingCandidate,
  importSourceRef,
  withPendingAdmissionLock,
  type ImportSource,
} from "./pending-store.js";
import { EngramStore } from "./store.js";
import { scanContent } from "./secrets.js";
import { isDuplicate } from "./capture-rules.js";
import { findWriteCandidates, type WriteCandidate } from "./write-advisory.js";
import { canonicalPackSource, samePackEntry } from "./pack-source.js";

export interface ImportProposal<Source extends ImportSource = ImportSource> {
  readonly source: Source;
  readonly title: string;
  readonly body: string;
  readonly type: EngramType;
  readonly reviewAfter?: string;
  readonly expires?: string;
}

export const importLocation = (source: ImportSource) =>
  source.format === "pack"
    ? {
        path: source.path,
        entryId: source.entryId,
        packName: source.name,
        packVersion: source.version,
      }
    : { path: source.path, line: source.line };

export const reviewImport = (
  proposals: readonly ImportProposal[],
  scope: Scope,
  cwd: string,
  apply: boolean,
) => {
  const review = Effect.gen(function* () {
    const store = yield* EngramStore;
    const pending = yield* Effect.forEach(yield* listPendingIds(scope, cwd), (id) =>
      readPendingCandidate(scope, id, cwd).pipe(
        Effect.catchIf(
          (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      ),
    );
    // An approval writes canonical memory before removing it from pending.
    const { entries, omittedFiles, duplicateIds } = yield* store.scan(scope);
    if (omittedFiles || duplicateIds.length) {
      return yield* Effect.fail(new ValidationError({ message: "Memory store needs repair." }));
    }

    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const asEntry = (
      id: string,
      proposed: Pick<Engram, "title" | "body" | "type" | "tags" | "reviewAfter" | "expires">,
    ): Engram => ({
      ...proposed,
      id,
      scope,
      path: "",
      author: undefined,
      pinned: false,
      aliases: [],
      created: timestamp,
      updated: timestamp,
      schemaVersion: 1,
    });
    const existing = [
      ...entries,
      ...pending.flatMap((candidate) =>
        candidate ? [asEntry(candidate.id, candidate.proposed)] : [],
      ),
    ];

    const hasPacks = proposals.some(({ source }) => source.format === "pack");
    const rejectedPacks = hasPacks ? yield* listPackRejections(scope, cwd) : [];
    const canonicalPacks = hasPacks
      ? entries.flatMap((entry) => {
          const source = canonicalPackSource(entry);
          return source ? [{ source, id: entry.id, status: "already_imported" }] : [];
        })
      : [];
    const knownPacks = [
      ...canonicalPacks,
      ...pending.flatMap((candidate) =>
        candidate?.importSource?.format === "pack"
          ? [{ source: candidate.importSource, id: candidate.id, status: "already_pending" }]
          : [],
      ),
      ...rejectedPacks.map((source) => ({ source, id: undefined, status: "already_rejected" })),
    ];

    return yield* Effect.forEach(proposals, (proposal, index) =>
      Effect.gen(function* () {
        const { source } = proposal;
        const location = importLocation(source);
        const rules = [
          ...new Set([proposal.title, proposal.body].flatMap(scanContent).map(({ rule }) => rule)),
        ];
        if (rules.length)
          return { ...location, status: "rejected", reason: "sensitive_content", rules } as const;

        const { title, body, type } = proposal;
        const candidateFields = {
          title,
          body,
          type,
          ...(proposal.reviewAfter === undefined ? {} : { reviewAfter: proposal.reviewAfter }),
          ...(proposal.expires === undefined ? {} : { expires: proposal.expires }),
        };
        const proposed = { ...candidateFields, tags: [] };
        const entry = asEntry("import-preview-" + index, proposed);
        const advisory = findWriteCandidates(entry, existing, now);
        let conflicts: WriteCandidate[] = [];
        let reason: string | undefined;
        if (source.format === "pack") {
          const history = knownPacks.filter((item) => samePackEntry(source, item.source));
          const sameVersion = history.filter((item) => item.source.version === source.version);
          if (sameVersion.some((item) => item.source.digest !== source.digest)) {
            return { ...location, status: "rejected", reason: "pack_version_changed" } as const;
          }
          reason =
            sameVersion.find((item) => item.status === "already_rejected")?.status ??
            sameVersion[0]?.status;
          if (!reason && history.some((item) => item.source.version > source.version))
            reason = "older_pack_version";
          if (!reason && history.some((item) => item.source.digest === source.digest))
            reason = "unchanged_pack_entry";
          reason ??= advisory.find(({ kind }) => kind !== "possible_conflict")?.kind;
          conflicts = advisory.filter(({ kind }) => kind === "possible_conflict");
          for (const { id } of history) {
            if (id && !conflicts.some((conflict) => conflict.id === id)) {
              conflicts.push({ scope, id, kind: "possible_conflict" });
            }
          }
        } else {
          const sourceRef = importSourceRef(source);
          // An edited pending file entry retains its original source excerpt.
          const earlierImport = pending.some(
            (candidate) =>
              candidate?.importSource !== undefined &&
              importSourceRef(candidate.importSource) === sourceRef &&
              isDuplicate(entry, [{ scope, body: candidate.sourceExcerpt }]),
          );
          const publishedImport = entries.some(
            (candidate) => candidate.sourceType === "file" && candidate.sourceRef === sourceRef,
          );
          reason =
            earlierImport || advisory[0]?.kind === "exact_duplicate"
              ? "exact_duplicate"
              : publishedImport
                ? "already_imported"
                : (advisory.find(({ kind }) => kind === "possible_conflict")?.kind ??
                  advisory[0]?.kind);
        }
        if (reason) return { ...location, status: "skipped", reason } as const;
        const notices = conflicts.length ? { conflicts } : {};

        if (!apply) {
          existing.push(entry);
          return {
            ...location,
            ...notices,
            status: "eligible",
            candidate: candidateFields,
          } as const;
        }
        return yield* enqueuePendingCandidate(
          {
            scope,
            proposed,
            sourceExcerpt: body,
            provenanceClass: "file",
            importSource: proposal.source,
            duplicates: [],
            conflicts: conflicts.flatMap(({ scope, id, kind }) =>
              kind === "possible_conflict" && entries.some((entry) => entry.id === id)
                ? [{ scope, id, kind }]
                : [],
            ),
          },
          cwd,
        ).pipe(
          Effect.map((candidate) => {
            existing.push(entry);
            return { ...location, ...notices, status: "staged", id: candidate.id } as const;
          }),
          Effect.catch(() =>
            Effect.succeed({
              ...location,
              status: "failed",
              reason: "queue_write_failed",
            } as const),
          ),
        );
      }),
    );
  });
  // Preview never creates a queue or lock. Apply rechecks inside the same
  // scope lock used by capture before it admits any candidate.
  return apply ? withPendingAdmissionLock(scope, review, cwd) : review;
};
