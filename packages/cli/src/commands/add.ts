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
import { resolveScanOptions, reportScanOutcome } from "../scanPolicy.js";
import { parseTags, detectAuthor } from "@engram/core";
import { readStdin, out } from "../io.js";
import { checkLifecycleValues } from "../lifecycle.js";
import type { LifecycleValueFlags } from "../lifecycle.js";
import { relatedFromFlag } from "../related.js";

export interface AddOptions extends LifecycleValueFlags {
  readonly title?: string;
  readonly type?: string;
  readonly tags?: string;
  readonly scope?: string;
  readonly stdin?: boolean;
  readonly pinned?: boolean;
  readonly author?: string;
  readonly content?: string;
  /** ENG-42: comma-separated same-scope related ids (Q1: a value that
   * trims to nothing records no key; Q2: empty tokens are a usage error). */
  readonly related?: string;
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
    // Enum flags fail fast here, before anything is created. Timestamp, id,
    // and sourceRef value errors surface from the store write boundary.
    let lifecycle = yield* checkLifecycleValues(opts);
    let related = yield* relatedFromFlag(opts.related);

    if (opts.stdin) {
      body = (yield* readStdin()).trim();
    } else if (opts.content) {
      body = opts.content.trim();
    } else {
      const tty = yield* isInteractive();
      if (!tty) {
        body = (yield* readStdin()).trim();
      } else {
        // flags prefill the editor and survive an unchanged save; blank or
        // removed lifecycle lines mean unset, a blank related line means no
        // list (Q1)
        const edited = yield* openEditor({
          title,
          type: type ?? "note",
          tags,
          body,
          status: opts.status,
          supersedes: opts.supersedes,
          reviewAfter: opts.reviewAfter,
          expires: opts.expires,
          sourceType: opts.sourceType,
          sourceRef: opts.sourceRef,
          related,
        });
        if (!edited || !edited.title) {
          yield* out(chalk.gray("Aborted: a title is required."));
          return;
        }
        title = edited.title;
        type = yield* checkType(edited.type);
        tags = edited.tags;
        body = edited.body;
        lifecycle = yield* checkLifecycleValues(edited);
        related = edited.related;
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

    const scan = yield* resolveScanOptions(cfg, scope, projectRoot, Boolean(opts.allowSecrets));

    const mem = yield* store.add(
      scope,
      {
        title,
        type,
        tags,
        body,
        pinned: Boolean(opts.pinned),
        author,
        status: lifecycle.status,
        supersedes: lifecycle.supersedes,
        related,
        reviewAfter: lifecycle.reviewAfter,
        expires: lifecycle.expires,
        sourceType: lifecycle.sourceType,
        sourceRef: lifecycle.sourceRef,
      },
      scan,
    );

    yield* out(chalk.green("✓ Added ") + chalk.bold(`[${mem.id}]`) + ` ${mem.title}`);
    yield* out(chalk.gray(`  ${mem.path}`));
    yield* reportScanOutcome(mem.scan);
    if (scope === "project" && Option.isSome(projectRoot)) {
      const tracked = (yield* cfg.loadProject(projectRoot.value)).tracked;
      if (tracked) {
        yield* out(
          chalk.gray(`  commit it: git add .engram && git commit -m "engram: ${mem.title}"`),
        );
      }
    }
  });
