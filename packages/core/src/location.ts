/**
 * Filesystem-backed location resolution: walking up to find a project root or a
 * git root. These are Effects that take the captured FileSystem/Path services so
 * they don't add runtime requirements to the calling context.
 */
import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { projectConfigPath } from "./paths.js";

const SEP = "/";

/** Walk up from `start` to the nearest dir whose `.engram/config.json` exists. */
export const findProjectRoot = (
  fs: FileSystem,
  path: Path,
  start: string = process.cwd(),
): Effect.Effect<string | null, PlatformError> =>
  Effect.gen(function* () {
    let dir = path.resolve(start);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const exists = yield* fs.exists(projectConfigPath(dir));
      if (exists) return dir;
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
