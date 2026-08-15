/** `engram edit <id>` — modify an existing engram via flags, --stdin, or $EDITOR. */
import { Effect } from "effect";
import chalk from "chalk";
import { EngramStore } from "@engram/core";
import { resolveScope } from "@engram/core";
import { ENGRAM_TYPES } from "@engram/core";
import type { EngramPatch, EngramType } from "@engram/core";
import { InvalidTypeError, ValidationError } from "@engram/core";
import { isInteractive, openEditor } from "../interactive.js";
import { parseTags } from "@engram/core";
import { readStdin, out } from "../io.js";

export interface EditOptions {
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

export const editCommand = (id: string, opts: EditOptions) =>
  Effect.gen(function* () {
    const store = yield* EngramStore;
    const projectRoot = yield* store.projectRoot();
    const scope = resolveScope(opts.scope, projectRoot);

    const mem = yield* store.get(scope, id);

    let patch: EngramPatch = {};

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
        patch = {
          title,
          type: editedType ?? mem.type,
          tags: edited.tags,
          body: edited.body,
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
