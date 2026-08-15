/**
 * Helpers for idempotently adding/removing lines in a repo's .gitignore.
 */
import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import { gitignorePath } from "./paths.js";

const readIfExists = (fs: FileSystem, file: string): Effect.Effect<string, PlatformError> =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(file);
    if (!exists) return "";
    return yield* fs.readFileString(file);
  });

export const ensureGitignoreLine = (
  fs: FileSystem,
  gitRoot: string,
  line: string,
): Effect.Effect<void, PlatformError> =>
  Effect.gen(function* () {
    const file = gitignorePath(gitRoot);
    let content = yield* readIfExists(fs, file);
    if (!content.split("\n").includes(line)) {
      if (content && !content.endsWith("\n")) content += "\n";
      content += `${line}\n`;
      yield* fs.writeFileString(file, content);
    }
  });

export const removeGitignoreLine = (
  fs: FileSystem,
  gitRoot: string,
  line: string,
): Effect.Effect<void, PlatformError> =>
  Effect.gen(function* () {
    const file = gitignorePath(gitRoot);
    const content = yield* readIfExists(fs, file);
    const lines = content.split("\n");
    const filtered = lines.filter((l) => l.trim() !== line.trim());
    if (filtered.length !== lines.length) {
      yield* fs.writeFileString(file, filtered.join("\n"));
    }
  });
