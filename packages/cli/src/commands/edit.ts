/** `engram edit <id>` — modify an existing engram via flags, --stdin, or $EDITOR. */
import { Effect } from "effect";
import chalk from "chalk";
import { EngramStore } from "@engram/core";
import { resolveScope } from "@engram/core";
import { ENGRAM_TYPES } from "@engram/core";
import type { Engram, EngramPatch, EngramType } from "@engram/core";
import { InvalidTypeError, ValidationError } from "@engram/core";
import { isInteractive, openEditor } from "../interactive.js";
import { parseTags } from "@engram/core";
import { readStdin, out } from "../io.js";
import { checkLifecycleConflicts, checkLifecycleValues } from "../lifecycle.js";
import type {
  CheckedLifecycleValues,
  LifecycleClearFlags,
  LifecycleValueFlags,
} from "../lifecycle.js";

export interface EditOptions extends LifecycleValueFlags, LifecycleClearFlags {
  readonly title?: string;
  readonly type?: string;
  readonly tags?: string;
  readonly scope?: string;
  readonly stdin?: boolean;
  readonly pinned?: boolean;
  readonly author?: string;
  readonly content?: string;
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

export const editCommand = (id: string, opts: EditOptions) =>
  Effect.gen(function* () {
    const store = yield* EngramStore;
    const projectRoot = yield* store.projectRoot();
    const scope = resolveScope(opts.scope, projectRoot);

    // Usage errors fail before anything is read or mutated: a value and its
    // clear flag on the same field, and unknown enum values.
    yield* checkLifecycleConflicts(opts);
    let lifecycle = yield* checkLifecycleValues(opts);

    const mem = yield* store.get(scope, id);

    let patch: EngramPatch = { ...lifecyclePatchFromFlags(lifecycle, opts) };

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
        };
      }
    }

    if (patch.title !== undefined && !patch.title.trim()) {
      return yield* Effect.fail(new ValidationError({ message: "Title cannot be empty." }));
    }

    const updated = yield* store.update(scope, mem.id, patch);
    yield* out(chalk.green("✓ Updated ") + chalk.bold(`[${updated.id}]`) + ` ${updated.title}`);
    yield* out(chalk.gray(`  ${updated.path}`));
  });
