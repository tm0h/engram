/** `engram list` */
import { Effect } from "effect";
import chalk from "chalk";
import { EngramStore } from "@engram/core";
import { incompleteMemoryWarning, renderList, scopesToQuery } from "@engram/core";
import { out, err } from "../io.js";

export interface ListOptions {
  readonly scope?: string;
  readonly type?: string;
  readonly tag?: string;
}

export const listCommand = (opts: ListOptions) =>
  Effect.gen(function* () {
    const store = yield* EngramStore;
    const projectRoot = yield* store.projectRoot();
    const scopes = scopesToQuery(opts.scope, projectRoot);
    const typeFilter = opts.type?.toLowerCase();
    const tagFilter = opts.tag?.toLowerCase();

    let total = 0;
    let omitted = 0;
    let candidates = 0;
    let readable = 0;
    let first = true;
    for (const scope of scopes) {
      // Consume the full scan so malformed candidates cannot vanish silently.
      const scanned = yield* store.scan(scope);
      omitted += scanned.omittedFiles;
      candidates += scanned.filesChecked;
      readable += scanned.entries.length;
      const engrams = scanned.entries.filter((m) => {
        if (typeFilter && m.type !== typeFilter) return false;
        if (tagFilter && !m.tags.includes(tagFilter)) return false;
        return true;
      });
      if (scopes.length > 1) {
        if (!first) yield* out("");
        yield* out(
          chalk.bold(scope === "personal" ? "Personal" : "Project") +
            chalk.gray(` (${engrams.length})`),
        );
        first = false;
      }
      yield* out(renderList(engrams));
      total += engrams.length;
    }
    if (total === 0) {
      if (readable > 0) {
        // Entries exist but the filters matched none of them: the store is
        // fine, so do not claim it is unreadable.
        yield* out(chalk.gray("No matching engrams."));
      } else if (candidates > 0) {
        yield* out(chalk.gray("(no readable engrams)"));
      } else {
        yield* out(chalk.gray("No engrams yet. Add one with `engram add`."));
      }
    }
    // Fail-open but loud: exactly one bounded aggregate warning on stderr.
    if (omitted > 0) yield* err(incompleteMemoryWarning(omitted));
  });
