/**
 * Shared ENG-13 lifecycle flag validation for `engram add` / `engram edit`.
 * Enums are checked here (fail fast, before the store runs) reusing the
 * core vocabularies; timestamp, id, and sourceRef value correctness stays
 * with the store write boundary, which reports through the standard
 * FrontmatterParseError path without mutating files.
 */
import { Effect } from "effect";
import { ENGRAM_STATUSES, SOURCE_TYPES, ValidationError } from "@engram/core";
import type { SourceType, Status } from "@engram/core";

/** Value flags, shared by add and edit (camelCase option properties). */
export interface LifecycleValueFlags {
  readonly status?: string;
  readonly supersedes?: string;
  readonly reviewAfter?: string;
  readonly expires?: string;
  readonly sourceType?: string;
  readonly sourceRef?: string;
}

/** Paired clear flags, edit only (add creates; it never clears). */
export interface LifecycleClearFlags {
  readonly clearStatus?: boolean;
  readonly clearSupersedes?: boolean;
  readonly clearReviewAfter?: boolean;
  readonly clearExpires?: boolean;
  readonly clearSourceType?: boolean;
  readonly clearSourceRef?: boolean;
}

const checkEnumFlag = (
  flag: string,
  value: string | undefined,
  allowed: ReadonlyArray<string>,
): Effect.Effect<string | undefined, ValidationError> => {
  if (value === undefined) return Effect.succeed(undefined);
  return allowed.includes(value)
    ? Effect.succeed(value)
    : Effect.fail(
        new ValidationError({
          message: `invalid ${flag} ${JSON.stringify(value)}. Valid: ${allowed.join(", ")}.`,
        }),
      );
};

/** Validated lifecycle values: enums narrowed to their core types. */
export interface CheckedLifecycleValues {
  readonly status: Status | undefined;
  readonly supersedes: string | undefined;
  readonly reviewAfter: string | undefined;
  readonly expires: string | undefined;
  readonly sourceType: SourceType | undefined;
  readonly sourceRef: string | undefined;
}

/** Fail fast on unknown enum values; pass everything else through for the
 * store write boundary to validate. */
export const checkLifecycleValues = (
  opts: LifecycleValueFlags,
): Effect.Effect<CheckedLifecycleValues, ValidationError> =>
  Effect.gen(function* () {
    const status = yield* checkEnumFlag("--status", opts.status, ENGRAM_STATUSES);
    const sourceType = yield* checkEnumFlag("--source-type", opts.sourceType, SOURCE_TYPES);
    return {
      status: status as Status | undefined,
      supersedes: opts.supersedes,
      reviewAfter: opts.reviewAfter,
      expires: opts.expires,
      sourceType: sourceType as SourceType | undefined,
      sourceRef: opts.sourceRef,
    };
  });

/** A value flag and its clear flag on the same field is a usage error:
 * fail before any mutation instead of picking a silent precedence. */
export const checkLifecycleConflicts = (
  opts: LifecycleValueFlags & LifecycleClearFlags,
): Effect.Effect<void, ValidationError> => {
  const pairs: ReadonlyArray<
    [valueFlag: string, clearFlag: string, value: string | undefined, clear: boolean | undefined]
  > = [
    ["--status", "--clear-status", opts.status, opts.clearStatus],
    ["--supersedes", "--clear-supersedes", opts.supersedes, opts.clearSupersedes],
    ["--review-after", "--clear-review-after", opts.reviewAfter, opts.clearReviewAfter],
    ["--expires", "--clear-expires", opts.expires, opts.clearExpires],
    ["--source-type", "--clear-source-type", opts.sourceType, opts.clearSourceType],
    ["--source-ref", "--clear-source-ref", opts.sourceRef, opts.clearSourceRef],
  ];
  const conflict = pairs.find(([, , value, clear]) => value !== undefined && clear === true);
  if (conflict === undefined) return Effect.void;
  const [valueFlag, clearFlag] = conflict;
  return Effect.fail(
    new ValidationError({
      message: `Use either ${valueFlag} <value> or ${clearFlag}, not both.`,
    }),
  );
};
