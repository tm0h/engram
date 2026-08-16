/**
 * Filesystem-backed location resolution: walking up to find a project root or a
 * git root. These are Effects that take the captured FileSystem/Path services so
 * they don't add runtime requirements to the calling context.
 */
import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { projectConfigPath, globalConfigPath } from "./paths.js";

const SEP = "/";

/** Walk up from `start` to the nearest dir whose `.engram/config.json` exists.
 *
 * Two boundaries keep discovery local:
 * - The walk stops at the nearest `.git`: a project engram lives inside its
 *   repo, so an `.engram` above the git root (e.g. the global `~/.engram` for a
 *   repo under $HOME) is never treated as this project's root.
 * - The global `~/.engram` is the personal scope, never a project root.
 */
export const findProjectRoot = (
  fs: FileSystem,
  path: Path,
  start: string = process.cwd(),
): Effect.Effect<string | null, PlatformError> =>
  Effect.gen(function* () {
    let dir = path.resolve(start);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const isGlobalRoot = projectConfigPath(dir) === globalConfigPath();
      if (!isGlobalRoot && (yield* fs.exists(projectConfigPath(dir)))) return dir;
      if (yield* fs.exists(`${dir}${SEP}.git`)) return null;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  });

/** Walk up from `start` to the nearest `.git` directory. */
export const findGitRoot = (
  fs: FileSystem,
  path: Path,
  start: string = process.cwd(),
): Effect.Effect<string | null, PlatformError> =>
  Effect.gen(function* () {
    let dir = path.resolve(start);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const exists = yield* fs.exists(`${dir}${SEP}.git`);
      if (exists) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  });
