/**
 * Shared ENG-42 comma-separated related-id parsing for `--related` flags and
 * the interactive editor's `related:` line. One code path guarantees the
 * identical rule on both surfaces (leader decisions Q1/Q2):
 *
 *   - a value that is empty or trims to nothing is ABSENT (add records no
 *     key; edit preserves), never an empty list;
 *   - empty tokens between separators are a usage error, on both surfaces;
 *   - member order is preserved verbatim: no sorting, no deduplication.
 *     Duplicates are the store boundary's hard error, never silently
 *     dropped here.
 *
 * Id syntax is NOT checked here: the store write boundary owns id validity,
 * so this parser stays a pure shape mapper.
 */
import { Effect } from "effect";
import { ValidationError } from "@engram/core";

/** Result of splitting one raw related value. */
export type RelatedParse =
  | { readonly kind: "absent" }
  | { readonly kind: "ids"; readonly ids: ReadonlyArray<string> }
  | { readonly kind: "invalid"; readonly reason: string };

export const parseRelatedIds = (raw: string | undefined): RelatedParse => {
  if (raw === undefined) return { kind: "absent" };
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "absent" };
  const tokens = trimmed.split(",").map((t) => t.trim());
  if (tokens.some((t) => t === "")) {
    return {
      kind: "invalid",
      reason: `empty values between commas are not ids: "${raw}"`,
    };
  }
  return { kind: "ids", ids: tokens };
};

/** Flag parsing for `engram add` / `engram edit`: an invalid value fails
 * with the standard usage error before any store call. */
export const relatedFromFlag = (
  value: string | undefined,
): Effect.Effect<ReadonlyArray<string> | undefined, ValidationError> =>
  Effect.gen(function* () {
    const parsed = parseRelatedIds(value);
    if (parsed.kind === "invalid") {
      return yield* Effect.fail(
        new ValidationError({ message: `invalid --related: ${parsed.reason}` }),
      );
    }
    return parsed.kind === "ids" ? parsed.ids : undefined;
  });

/** A `--related` value together with `--clear-related` is a usage error:
 * fail before any read or write instead of picking a silent precedence. */
export const checkRelatedConflict = (opts: {
  readonly related?: string;
  readonly clearRelated?: boolean;
}): Effect.Effect<void, ValidationError> => {
  if (opts.related !== undefined && opts.clearRelated === true) {
    return Effect.fail(
      new ValidationError({
        message: "Use either --related <ids> or --clear-related, not both.",
      }),
    );
  }
  return Effect.void;
};
