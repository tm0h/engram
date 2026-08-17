#!/usr/bin/env node
/**
 * engram — git-native agent memory.
 *
 * Engrams are plain Markdown files (YAML frontmatter + body). The `project`
 * scope lives in <repo>/.engram/ and can be committed so the whole team (and
 * cloud sessions) share it. The `personal` scope lives in ~/.engram/ and
 * is never committed.
 *
 * Built with Effect; CLI dispatch via commander.
 */
import { Command } from "commander";
import { Effect, Exit, Cause } from "effect";
import chalk from "chalk";
import process from "node:process";
import { MainLive } from "@engram/core";
import { formatDomainError, type DomainError } from "@engram/core";
import * as Init from "./commands/init.js";
import * as Add from "./commands/add.js";
import * as List from "./commands/list.js";
import * as Search from "./commands/search.js";
import * as Show from "./commands/show.js";
import * as Edit from "./commands/edit.js";
import * as Remove from "./commands/remove.js";
import * as Context from "./commands/context.js";
import * as Config from "./commands/configCmd.js";
import * as Inject from "./commands/inject.js";
import * as Where from "./commands/where.js";
import * as Dedupe from "./commands/dedupe.js";

const DOMAIN_TAGS = new Set([
  "ProjectNotInitializedError",
  "EngramNotFoundError",
  "AmbiguousIdError",
  "DuplicateIdError",
  "InvalidTypeError",
  "ValidationError",
  "FrontmatterParseError",
  "ConfigError",
]);

function isDomainError(e: unknown): e is DomainError {
  return (
    typeof e === "object" &&
    e !== null &&
    "_tag" in e &&
    DOMAIN_TAGS.has((e as { _tag: string })._tag)
  );
}

/** Run a command Effect with the main layer and uniform error handling. */
function run<A, E, R>(eff: Effect.Effect<A, E, R>): void {
  Effect.runPromiseExit(eff.pipe(Effect.provide(MainLive)) as Effect.Effect<A, E>)
    .then((exit) => {
      if (Exit.isSuccess(exit)) return;
      const e = Cause.squash(exit.cause);
      const msg = isDomainError(e)
        ? formatDomainError(e)
        : e instanceof Error
          ? e.message
          : String(e);
      console.error(chalk.red("error: ") + msg);
      process.exitCode = 1;
    })
    .catch((err) => {
      console.error(chalk.red("error: ") + (err instanceof Error ? err.message : String(err)));
      process.exitCode = 1;
    });
}

const program = new Command();

program
  .name("engram")
  .description("Git-native agent memory — personal + team/project memory any harness can use.")
  .version("0.1.1");

program
  .command("init")
  .description("Initialize .engram/ in this project and choose whether to track it in git.")
  .option("--tracked", "Track team memory in git (shared).")
  .option("--untracked", "Gitignore memory (local only).")
  .action((opts: { tracked?: boolean; untracked?: boolean }) => {
    const tracked = opts.tracked ? true : opts.untracked ? false : undefined;
    run(Init.initCommand({ tracked }));
  });

program
  .command("add [content]")
  .description("Record an engram. Body comes from the argument, --stdin, or $EDITOR.")
  .option("-t, --title <title>", "Engram title.")
  .option("--type <type>", "decision | fact | preference | note | issue | context")
  .option("--tags <tags>", "Comma-separated tags.")
  .option("-s, --scope <scope>", "personal | project (default: project if initialized)")
  .option("--stdin", "Read body from stdin.")
  .option("--pinned", "Pin this engram (always surfaces in digests).")
  .option("--author <name>", "Override author.")
  .action((content: string | undefined, opts: Record<string, string | boolean | undefined>) =>
    run(
      Add.addCommand({
        content,
        title: opts.title as string | undefined,
        type: opts.type as string | undefined,
        tags: opts.tags as string | undefined,
        scope: opts.scope as string | undefined,
        stdin: Boolean(opts.stdin),
        pinned: Boolean(opts.pinned),
        author: opts.author as string | undefined,
      }),
    ),
  );

program
  .command("list")
  .description("List engrams.")
  .option("-s, --scope <scope>", "personal | project | all")
  .option("--type <type>", "Filter by type.")
  .option("--tag <tag>", "Filter by tag.")
  .action((opts: Record<string, string | undefined>) =>
    run(
      List.listCommand({
        scope: opts.scope,
        type: opts.type,
        tag: opts.tag,
      }),
    ),
  );

program
  .command("search <query>")
  .description("Search engrams by keyword/tag/type.")
  .option("-s, --scope <scope>", "personal | project | all")
  .option("-n, --limit <n>", "Max results.", (v: string) => parseInt(v, 10))
  .action((query: string, opts: Record<string, string | number | undefined>) =>
    run(
      Search.searchCommand(query, {
        scope: opts.scope as string | undefined,
        limit: opts.limit as number | undefined,
      }),
    ),
  );

program
  .command("show <id>")
  .description("Show an engram in full (id or unique prefix).")
  .option("-s, --scope <scope>", "personal | project")
  .action((id: string, opts: Record<string, string | undefined>) =>
    run(Show.showCommand(id, { scope: opts.scope })),
  );

program
  .command("edit <id> [content]")
  .description(
    "Edit an engram: flags replace fields; no flags opens $EDITOR; --stdin replaces the body.",
  )
  .option("-t, --title <title>", "New title.")
  .option("--type <type>", "decision | fact | preference | note | issue | context")
  .option("--tags <tags>", "Comma-separated tags (replaces existing).")
  .option("-s, --scope <scope>", "personal | project")
  .option("--stdin", "Read the new body from stdin.")
  .option("--pinned", "Pin the engram.")
  .option("--no-pinned", "Unpin the engram.")
  .option("--author <name>", "Override author.")
  .action(
    (id: string, content: string | undefined, opts: Record<string, string | boolean | undefined>) =>
      run(
        Edit.editCommand(id, {
          content,
          title: opts.title as string | undefined,
          type: opts.type as string | undefined,
          tags: opts.tags as string | undefined,
          scope: opts.scope as string | undefined,
          stdin: Boolean(opts.stdin),
          pinned: typeof opts.pinned === "boolean" ? opts.pinned : undefined,
          author: opts.author as string | undefined,
        }),
      ),
  );

program
  .command("remove <id>")
  .alias("rm")
  .description("Delete an engram.")
  .option("-s, --scope <scope>", "personal | project")
  .option("-y, --yes", "Skip confirmation.")
  .action((id: string, opts: Record<string, string | boolean | undefined>) =>
    run(
      Remove.removeCommand(id, {
        scope: opts.scope as string | undefined,
        yes: Boolean(opts.yes),
      }),
    ),
  );

program
  .command("context")
  .description("Emit an agent-ready digest to inject into a session. Add --query for specifics.")
  .option("-s, --scope <scope>", "personal | project | all")
  .option("-q, --query <query>", "Return full bodies of engrams matching a query.")
  .option("--full", "Include full bodies of every engram.")
  .option("-n, --limit <n>", "Max engrams.", (v: string) => parseInt(v, 10))
  .action((opts: Record<string, string | number | boolean | undefined>) =>
    run(
      Context.contextCommand({
        scope: opts.scope as string | undefined,
        query: opts.query as string | undefined,
        full: Boolean(opts.full),
        limit: opts.limit as number | undefined,
      }),
    ),
  );

program
  .command("config [action] [key] [value]")
  .description("View/edit config. Keys: tracked, defaultType, author, editor.")
  .action((action: string | undefined, key: string | undefined, value: string | undefined) =>
    run(Config.configCommand(action, key, value)),
  );

program
  .command("inject")
  .description("Print the agent-injection snippet to paste into a system prompt.")
  .action(() => run(Inject.injectCommand()));

program
  .command("where")
  .description("Show resolved engram paths and current default scope.")
  .action(() => run(Where.whereCommand()));

program
  .command("dedupe")
  .description("Renumber duplicate engram ids (e.g. after merging branches).")
  .option("-s, --scope <scope>", "personal | project (default: project if initialized)")
  .action((opts: Record<string, string | undefined>) =>
    run(
      Dedupe.dedupeCommand({
        scope: opts.scope,
      }),
    ),
  );

program.parseAsync(process.argv).catch((err) => {
  // commander emits its own errors (e.g. unknown command); surface cleanly.
  if (err?.code === "commander.unknownCommand") process.exit(0);
  console.error(chalk.red("error: ") + (err?.message ?? String(err)));
  process.exit(1);
});
