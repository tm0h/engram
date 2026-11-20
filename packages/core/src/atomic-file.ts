import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";

/** Stage complete bytes on the destination filesystem, then publish atomically. */
export const writeAtomicFile = Effect.fnUntraced(function* (
  directory: string,
  name: string,
  content: string,
  options: { readonly mode?: number; readonly replace?: boolean } = {},
) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const staging = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".write-" });
      const temporary = path.join(staging, name);
      const target = path.join(directory, name);
      yield* fs.writeFileString(temporary, content, { mode: options.mode, flag: "wx" });
      if (options.replace) yield* fs.rename(temporary, target);
      else yield* fs.link(temporary, target);
    }),
  );
});
