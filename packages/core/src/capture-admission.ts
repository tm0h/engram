import { Effect, Result, Schema } from "effect";
import {
  CaptureSource,
  enqueuePendingCandidate,
  listPendingIds,
  readPendingCandidate,
  removePendingCandidate,
  withPendingCandidateLock,
  withPendingAdmissionLock,
} from "./pending-store.js";
import { evaluateCapture, isDuplicate } from "./capture-rules.js";
import { auditCaptureDuplicate, recordProjectCapture } from "./capture-control.js";
import { EngramStore } from "./store.js";

export { CAPTURE_RULES_VERSION, evaluateCapture } from "./capture-rules.js";
type CaptureSourceInput =
  | Omit<Extract<CaptureSource, { harness: "pi" }>, "evidence">
  | (Omit<Extract<CaptureSource, { harness: "opencode" }>, "evidence"> & {
      readonly partIds: ReadonlyMap<string, string>;
    });

export { CaptureMessageId } from "./pending-store.js";

export const stageCapture = Effect.fnUntraced(function* (
  input: unknown,
  cwd: string,
  source?: CaptureSourceInput,
  signal?: AbortSignal,
) {
  const proposals = evaluateCapture(input);
  if (proposals.length !== 1) {
    return { status: "rejected", reason: proposals.length ? "ambiguous" : "ineligible" } as const;
  }
  const { scope, title, body, type, sourceExcerpt, evidence } = proposals[0];
  let captureSource: CaptureSource | undefined;
  if (source?.harness === "opencode") {
    const { partIds, ...provenance } = source;
    const parts = evidence.flatMap((item) => {
      const partId = partIds.get(item.messageId);
      return partId ? [{ ...item, partId }] : [];
    });
    if (parts.length !== evidence.length) {
      return { status: "rejected", reason: "ineligible" } as const;
    }
    captureSource = { ...provenance, evidence: parts };
  } else if (source) {
    captureSource = { ...source, evidence };
  }
  if (captureSource && !Schema.is(CaptureSource)(captureSource)) {
    return { status: "rejected", reason: "ineligible" } as const;
  }
  const store = yield* EngramStore;
  return yield* withPendingAdmissionLock(
    scope,
    Effect.gen(function* () {
      const pending = yield* Effect.forEach(
        yield* listPendingIds(scope, cwd),
        (id) =>
          readPendingCandidate(scope, id, cwd).pipe(
            Effect.catchIf(
              (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
              () => Effect.succeed(undefined),
            ),
          ),
        { concurrency: 8 },
      );
      const existing = pending.flatMap((candidate) =>
        candidate ? [{ scope, body: candidate.proposed.body }] : [],
      );
      // Review publishes before it removes a candidate. Read canonical memory
      // after pending so a concurrent approval remains visible in either store.
      const canonical = yield* Effect.result(store.list(scope));
      if (Result.isFailure(canonical) && (scope !== "project" || !captureSource)) {
        return yield* Effect.fail(canonical.failure);
      }
      const canonicalEntries = Result.isSuccess(canonical) ? canonical.success : [];
      if (isDuplicate(proposals[0], [...existing, ...canonicalEntries])) {
        if (scope === "project" && captureSource) yield* auditCaptureDuplicate(captureSource);
        return { status: "rejected", reason: "duplicate" } as const;
      }
      const stage = Effect.gen(function* () {
        const candidate = yield* enqueuePendingCandidate(
          {
            scope,
            proposed: { title, body, type, tags: [] },
            sourceExcerpt,
            provenanceClass: "conversation",
            ...(captureSource && { captureSource }),
            duplicates: [],
            conflicts: [],
          },
          cwd,
        );
        if (scope === "project" && captureSource) {
          return yield* withPendingCandidateLock(
            scope,
            candidate.id,
            Effect.gen(function* () {
              const current = yield* readPendingCandidate(scope, candidate.id, cwd);
              const result = yield* recordProjectCapture(current, signal, () => {
                const [checked, ...rest] = evaluateCapture(input);
                return (
                  checked !== undefined &&
                  rest.length === 0 &&
                  JSON.stringify(checked) === JSON.stringify(proposals[0]) &&
                  JSON.stringify(current) === JSON.stringify(candidate)
                );
              });
              if (result.status === "pending") {
                return { ...result, id: candidate.id, scope, evidence } as const;
              }
              // The audit is durable before queue cleanup. A cleanup failure leaves
              // the approved candidate's deterministic ID available to manual retry.
              yield* Effect.ignore(removePendingCandidate(scope, candidate.id, cwd));
              return result;
            }),
            cwd,
          );
        }
        return { status: "pending", id: candidate.id, scope, evidence } as const;
      });
      // Once a shipped adapter enqueues, finish its local audit even when
      // the host stops waiting. The signal still guards canonical publication.
      return yield* scope === "project" && captureSource ? Effect.uninterruptible(stage) : stage;
    }),
    cwd,
  );
});
