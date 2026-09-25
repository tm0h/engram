/** `engram edit <id>` — modify an existing engram via flags, --stdin, or $EDITOR. */
import { Effect } from "effect";
import chalk from "chalk";
import { EngramStore } from "@engram/core";
import { ConfigRepo } from "@engram/core";
import { resolveScope } from "@engram/core";
import { ENGRAM_TYPES } from "@engram/core";
import type { Engram, EngramPatch, EngramType } from "@engram/core";
import { InvalidTypeError, ValidationError } from "@engram/core";
import { isInteractive, openEditor } from "../interactive.js";
import type { EditedEngram } from "../interactive.js";
import { resolveScanOptions, reportScanOutcome } from "../scanPolicy.js";
import { parseTags } from "@engram/core";
import { readStdin, out } from "../io.js";
import { checkLifecycleConflicts, checkLifecycleValues } from "../lifecycle.js";
import type {
  CheckedLifecycleValues,
  LifecycleClearFlags,
  LifecycleValueFlags,
} from "../lifecycle.js";
import { checkRelatedConflict, relatedFromFlag } from "../related.js";

export interface EditOptions extends LifecycleValueFlags, LifecycleClearFlags {
  readonly title?: string;
  readonly type?: string;
  readonly tags?: string;
  readonly scope?: string;
  readonly stdin?: boolean;
  readonly pinned?: boolean;
  readonly author?: string;
  readonly content?: string;
  /** ENG-42: comma-separated same-scope related ids. An empty value
   * preserves (no instruction); empty tokens are a usage error (Q2). */
  readonly related?: string;
  /** ENG-42: remove the related list (mutually exclusive with --related). */
  readonly clearRelated?: boolean;
  /** ENG-15: explicit per-write override for a blocking scan policy. */
  readonly allowSecrets?: boolean;
}

const checkType = (t?: string): Effect.Effect<EngramType | undefined, InvalidTypeError> => {
  if (!t) return Effect.succeed(undefined);
  const lower = t.toLowerCase() as EngramType;
  return ENGRAM_TYPES.includes(lower)
    ? Effect.succeed(lower)
    : Effect.fail(new InvalidTypeError({ type: t }));
};

/** A writable view of EngramPatch for constructing patch objects. */
type PatchDraft = { -readonly [K in keyof EngramPatch]?: EngramPatch[K] };

/** Flag-driven lifecycle patch: a clear flag wins its field (null = clear),
 * otherwise a validated value replaces it, otherwise the field is omitted
 * (undefined = unchanged). */
const lifecyclePatchFromFlags = (
  values: CheckedLifecycleValues,
  clears: LifecycleClearFlags,
): Partial<EngramPatch> => {
  const patch: PatchDraft = {};
  if (clears.clearStatus === true) patch.status = null;
  else if (values.status !== undefined) patch.status = values.status;
  if (clears.clearSupersedes === true) patch.supersedes = null;
  else if (values.supersedes !== undefined) patch.supersedes = values.supersedes;
  if (clears.clearReviewAfter === true) patch.reviewAfter = null;
  else if (values.reviewAfter !== undefined) patch.reviewAfter = values.reviewAfter;
  if (clears.clearExpires === true) patch.expires = null;
  else if (values.expires !== undefined) patch.expires = values.expires;
  if (clears.clearSourceType === true) patch.sourceType = null;
  else if (values.sourceType !== undefined) patch.sourceType = values.sourceType;
  if (clears.clearSourceRef === true) patch.sourceRef = null;
  else if (values.sourceRef !== undefined) patch.sourceRef = values.sourceRef;
  return patch;
};

/** Editor-driven lifecycle patch: a changed value replaces it; a removed or
 * blanked line on a field that had a value is an explicit clear (null);
 * unchanged fields are omitted so they are preserved. */
const lifecyclePatchFromEditor = (
  mem: Engram,
  next: CheckedLifecycleValues,
): Partial<EngramPatch> => {
  const patch: PatchDraft = {};
  if (next.status === undefined) {
    if (mem.status !== undefined) patch.status = null;
  } else if (next.status !== mem.status) patch.status = next.status;
  if (next.supersedes === undefined) {
    if (mem.supersedes !== undefined) patch.supersedes = null;
  } else if (next.supersedes !== mem.supersedes) patch.supersedes = next.supersedes;
  if (next.reviewAfter === undefined) {
    if (mem.reviewAfter !== undefined) patch.reviewAfter = null;
  } else if (next.reviewAfter !== mem.reviewAfter) patch.reviewAfter = next.reviewAfter;
  if (next.expires === undefined) {
    if (mem.expires !== undefined) patch.expires = null;
  } else if (next.expires !== mem.expires) patch.expires = next.expires;
  if (next.sourceType === undefined) {
    if (mem.sourceType !== undefined) patch.sourceType = null;
  } else if (next.sourceType !== mem.sourceType) patch.sourceType = next.sourceType;
  if (next.sourceRef === undefined) {
    if (mem.sourceRef !== undefined) patch.sourceRef = null;
  } else if (next.sourceRef !== mem.sourceRef) patch.sourceRef = next.sourceRef;
  return patch;
};

/** Editor-driven ENG-42 related patch (leader note: unchanged-preserves is
 * parsed array equality, so reformatting the line without changing the ids
 * preserves, while reordering or editing replaces). Semantics by line state
 * (turn 2 + turn 3, PR comment P2):
 *   deleted line  -> explicit clear (the renderer always writes the line,
 *                    so removal is always a user act)
 *   blank line    -> preserves a stored explicit empty list (an unchanged
 *                    save of [] renders blank) and clears a populated list
 *   changed list  -> replaces the whole list
 * Flags still clear any state via --clear-related. */
const relatedPatchFromEditor = (mem: Engram, edited: EditedEngram): Partial<EngramPatch> => {
  if (edited.relatedDeleted === true) {
    return mem.related !== undefined ? { related: null } : {};
  }
  const next = edited.related;
  if (next === undefined) {
    return mem.related !== undefined && mem.related.length > 0 ? { related: null } : {};
  }
  const unchanged =
    mem.related !== undefined &&
    mem.related.length === next.length &&
    mem.related.every((rel, i) => rel === next[i]);
  return unchanged ? {} : { related: [...next] };
};

export const editCommand = (id: string, opts: EditOptions) =>
  Effect.gen(function* () {
    const store = yield* EngramStore;
    const cfg = yield* ConfigRepo;
    const projectRoot = yield* store.projectRoot();
    const scope = resolveScope(opts.scope, projectRoot);

    // Usage errors fail before anything is read or mutated: a value and its
    // clear flag on the same field, the related flag pair, and unknown enum
    // values.
    yield* checkLifecycleConflicts(opts);
    yield* checkRelatedConflict(opts);
    let lifecycle = yield* checkLifecycleValues(opts);
    const flagRelated = yield* relatedFromFlag(opts.related);

    const mem = yield* store.get(scope, id);

    let patch: EngramPatch = { ...lifecyclePatchFromFlags(lifecycle, opts) };

    // ENG-42 three-state mapping: clear wins, a parsed value replaces, an
    // absent flag (or a value that trims to nothing) preserves.
    if (opts.clearRelated === true) patch = { ...patch, related: null };
    else if (flagRelated !== undefined) patch = { ...patch, related: flagRelated };

    if (opts.title !== undefined) patch = { ...patch, title: opts.title };
    const type = yield* checkType(opts.type);
    if (type !== undefined) patch = { ...patch, type };
    if (opts.tags !== undefined) {
      patch = { ...patch, tags: parseTags(opts.tags) };
    }
    if (opts.pinned !== undefined) patch = { ...patch, pinned: opts.pinned };
    if (opts.author !== undefined) patch = { ...patch, author: opts.author };

    if (opts.stdin) {
      patch = { ...patch, body: (yield* readStdin()).trim() };
    } else if (opts.content !== undefined) {
      patch = { ...patch, body: opts.content.trim() };
    }

    if (Object.keys(patch).length === 0) {
      const tty = yield* isInteractive();
      if (!tty) {
        const body = (yield* readStdin()).trim();
        if (!body) {
          return yield* Effect.fail(
            new ValidationError({
              message: "Nothing to edit: pass flags, content, or --stdin.",
            }),
          );
        }
        patch = { body };
      } else {
        const edited = yield* openEditor({
          title: mem.title,
          type: mem.type,
          tags: mem.tags,
          body: mem.body,
          status: mem.status,
          supersedes: mem.supersedes,
          reviewAfter: mem.reviewAfter,
          expires: mem.expires,
          sourceType: mem.sourceType,
          sourceRef: mem.sourceRef,
          related: mem.related,
        });
        if (!edited) {
          yield* out(chalk.gray("Cancelled."));
          return;
        }
        const title = edited.title.trim();
        if (!title) {
          yield* out(chalk.gray("Aborted: a title is required."));
          return;
        }
        const editedType = yield* checkType(edited.type);
        lifecycle = yield* checkLifecycleValues(edited);
        patch = {
          title,
          type: editedType ?? mem.type,
          tags: edited.tags,
          body: edited.body,
          ...lifecyclePatchFromEditor(mem, lifecycle),
          ...relatedPatchFromEditor(mem, edited),
        };
      }
    }

    if (patch.title !== undefined && !patch.title.trim()) {
      return yield* Effect.fail(new ValidationError({ message: "Title cannot be empty." }));
    }

    const scan = yield* resolveScanOptions(cfg, scope, projectRoot, Boolean(opts.allowSecrets));
    const updated = yield* store.update(scope, mem.id, patch, scan);
    yield* out(chalk.green("✓ Updated ") + chalk.bold(`[${updated.id}]`) + ` ${updated.title}`);
    yield* out(chalk.gray(`  ${updated.path}`));
    yield* reportScanOutcome(updated.scan);
  });
