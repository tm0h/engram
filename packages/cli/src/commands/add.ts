/** `engram add` — record a new engram. */
import { Effect, Option } from "effect";
import chalk from "chalk";
import { EngramStore } from "@engram/core";
import { ConfigRepo } from "@engram/core";
import { resolveScope } from "@engram/core";
import { ENGRAM_TYPES } from "@engram/core";
import type { EngramType } from "@engram/core";
import { InvalidTypeError, ValidationError } from "@engram/core";
import { isInteractive, openEditor } from "../interactive.js";
import { parseTags, detectAuthor } from "@engram/core";
import { readStdin, out } from "../io.js";

export interface AddOptions {
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

export const addCommand = (opts: AddOptions) =>
  Effect.gen(function* () {
    const store = yield* EngramStore;
    const cfg = yield* ConfigRepo;
    const projectRoot = yield* store.projectRoot();
    const scope = resolveScope(opts.scope, projectRoot);

    let title = opts.title?.trim() ?? "";
    let type = yield* checkType(opts.type);
    let tags = parseTags(opts.tags);
    let body = "";

    if (opts.stdin) {
      body = (yield* readStdin()).trim();
    } else if (opts.content) {
      body = opts.content.trim();
    } else {
      const tty = yield* isInteractive();
      if (!tty) {
        body = (yield* readStdin()).trim();
      } else {
        const edited = yield* openEditor({
          title,
          type: type ?? "note",
          tags,
          body,
        });
        if (!edited || !edited.title) {
          yield* out(chalk.gray("Aborted: a title is required."));
          return;
        }
        title = edited.title;
        type = yield* checkType(edited.type);
        tags = edited.tags;
        body = edited.body;
      }
    }

    if (!title) {
      return yield* Effect.fail(
        new ValidationError({
          message: 'A title is required. Pass --title "..." (or set it in the editor).',
        }),
      );
    }

    type ??=
      scope === "project" && Option.isSome(projectRoot)
        ? ((yield* cfg.loadProject(projectRoot.value)).defaultType ?? "note")
        : "note";

    const projectAuthor =
      scope === "project" && Option.isSome(projectRoot)
        ? (yield* cfg.loadProject(projectRoot.value)).author
        : undefined;
    const globalAuthor = (yield* cfg.loadGlobal()).author;
    const author = opts.author ?? projectAuthor ?? globalAuthor ?? (yield* detectAuthor());

    const mem = yield* store.add(scope, {
      title,
      type,
      tags,
      body,
      pinned: Boolean(opts.pinned),
      author,
    });

    yield* out(chalk.green("✓ Added ") + chalk.bold(`[${mem.id}]`) + ` ${mem.title}`);
    yield* out(chalk.gray(`  ${mem.path}`));
    if (scope === "project" && Option.isSome(projectRoot)) {
      const tracked = (yield* cfg.loadProject(projectRoot.value)).tracked;
      if (tracked) {
        yield* out(
          chalk.gray(`  commit it: git add .engram && git commit -m "engram: ${mem.title}"`),
        );
      }
    }
  });
