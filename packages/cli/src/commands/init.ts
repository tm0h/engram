/** `engram init` — set up .engram/ in a project and choose tracking. */
import { Effect } from "effect";
import chalk from "chalk";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { ConfigRepo } from "@engram/core";
import { findProjectRoot, findGitRoot } from "@engram/core";
import { projectEngramsDir, projectReadmePath } from "@engram/core";
import { projectReadmeContent, injectSnippet } from "@engram/core";
import { isInteractive, promptConfirm, promptText } from "../interactive.js";
import { ensureGitignoreLine, removeGitignoreLine } from "@engram/core";
import { detectAuthor } from "@engram/core";
import { out } from "../io.js";

export interface InitOptions {
  readonly tracked?: boolean;
}

export const initCommand = (opts: InitOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    const cfg = yield* ConfigRepo;

    const existing = yield* findProjectRoot(fs, path, process.cwd());
    if (existing !== null) {
      yield* out(`Already initialized: ${existing}/.engram`);
      return;
    }

    const gitRoot = yield* findGitRoot(fs, path, process.cwd());
    const root = gitRoot ?? process.cwd();

    let tracked: boolean;
    if (opts.tracked !== undefined) {
      tracked = opts.tracked;
    } else {
      const tty = yield* isInteractive();
      if (tty) {
        yield* out(chalk.bold("Initializing project engram at: ") + chalk.cyan(root));
        tracked = yield* promptConfirm(
          "Track team engram in git (shared with your whole team & cloud sessions)?",
          true,
        );
      } else {
        tracked = true;
      }
    }

    // Structure
    yield* fs.makeDirectory(projectEngramsDir(root), { recursive: true });
    yield* cfg.saveProject(root, { version: 1, tracked, defaultType: "note" });
    yield* fs.writeFileString(projectReadmePath(root), projectReadmeContent(tracked));

    // Global author (if missing)
    const global = yield* cfg.loadGlobal();
    if (global.author === undefined) {
      const tty = yield* isInteractive();
      const author = tty
        ? yield* promptText("Your name (for authoring engrams)", yield* detectAuthor())
        : yield* detectAuthor();
      yield* cfg.saveGlobal({ ...global, author });
    }

    // .gitignore handling
    if (gitRoot !== null) {
      if (tracked) {
        yield* removeGitignoreLine(fs, gitRoot, ".engram/");
        yield* removeGitignoreLine(fs, gitRoot, ".engram/engrams/");
      } else {
        yield* ensureGitignoreLine(fs, gitRoot, ".engram/");
      }
    }

    // Summary
    yield* out("");
    yield* out(chalk.green("✓ Project engram initialized."));
    yield* out(`  ${chalk.gray("location:")} ${root}/.engram`);
    yield* out(
      `  ${chalk.gray("tracking:")} ${
        tracked
          ? chalk.green("git-tracked (shared with team)")
          : chalk.yellow("gitignored (local only)")
      }`,
    );
    yield* out("");
    yield* out(chalk.bold("Next steps"));
    yield* out(`  ${chalk.gray("1.")} Record your first engram:`);
    yield* out(
      `     ${chalk.cyan('engram add --title "Replaced X with Y" --type decision "because..."')}`,
    );
    yield* out(`  ${chalk.gray("2.")} See what's stored:    ${chalk.cyan("engram list")}`);
    yield* out(`  ${chalk.gray("3.")} Commit ${chalk.cyan(".engram/")} so teammates inherit it.`);
    if (!tracked) {
      yield* out(
        `     ${chalk.yellow("(engram is gitignored — toggle with `engram config set tracked on` later)")}`,
      );
    }
    yield* out("");
    yield* out(chalk.bold("Agent integration"));
    yield* out(
      chalk.gray("Put this in your agent/harness system prompt (or run `engram inject`):"),
    );
    yield* out(chalk.gray("---"));
    yield* out(injectSnippet());
    yield* out(chalk.gray("---"));
  });
