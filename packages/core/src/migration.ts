import { Effect } from "effect";
import type { Engram, EngramType, Scope } from "./domain.js";
import { ValidationError } from "./errors.js";
import {
  enqueuePendingCandidate,
  listPendingIds,
  readPendingCandidate,
  importSourceRef,
  withPendingAdmissionLock,
  type ImportSource,
} from "./pending-store.js";
import { EngramStore } from "./store.js";
import { scanContent } from "./secrets.js";
import { isDuplicate } from "./capture-rules.js";
import { findWriteCandidates } from "./write-advisory.js";

export interface ImportProposal {
  readonly source: ImportSource;
  readonly title: string;
  readonly body: string;
  readonly type: EngramType;
}

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
      proposed: Pick<Engram, "title" | "body" | "type" | "tags">,
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

    return yield* Effect.forEach(proposals, (proposal, index) =>
      Effect.gen(function* () {
        const location = { path: proposal.source.path, line: proposal.source.line };
        const rules = [
          ...new Set([proposal.title, proposal.body].flatMap(scanContent).map(({ rule }) => rule)),
        ];
        if (rules.length)
          return { ...location, status: "rejected", reason: "sensitive_content", rules } as const;

        const { title, body, type } = proposal;
        const proposed = { title, body, type, tags: [] };
        const entry = asEntry("import-preview-" + index, proposed);
        const advisory = findWriteCandidates(entry, existing, now);
        const sourceRef = importSourceRef(proposal.source);
        // An edited pending entry retains its original source excerpt. Match
        // that only at the same source location so headings remain distinct.
        const earlierImport = pending.some(
          (candidate) =>
            candidate?.importSource !== undefined &&
            importSourceRef(candidate.importSource) === sourceRef &&
            isDuplicate(entry, [{ scope, body: candidate.sourceExcerpt }]),
        );
        const publishedImport = entries.some(
          (candidate) => candidate.sourceType === "file" && candidate.sourceRef === sourceRef,
        );
        const reason =
          earlierImport || advisory[0]?.kind === "exact_duplicate"
            ? "exact_duplicate"
            : publishedImport
              ? "already_imported"
              : (advisory.find(({ kind }) => kind === "possible_conflict")?.kind ??
                advisory[0]?.kind);
        if (reason) return { ...location, status: "skipped", reason } as const;

        if (!apply) {
          existing.push(entry);
          return { ...location, status: "eligible", candidate: { title, body, type } } as const;
        }
        return yield* enqueuePendingCandidate(
          {
            scope,
            proposed,
            sourceExcerpt: body,
            provenanceClass: "file",
            importSource: proposal.source,
            duplicates: [],
            conflicts: [],
          },
          cwd,
        ).pipe(
          Effect.map((candidate) => {
            existing.push(entry);
            return { ...location, status: "staged", id: candidate.id } as const;
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
