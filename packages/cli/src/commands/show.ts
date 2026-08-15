/** `engram show <id>` */
import { Effect, Option } from "effect";
import { EngramStore } from "@engram/core";
import { resolveScope } from "@engram/core";
import { renderFull } from "@engram/core";
import { out } from "../io.js";

export const showCommand = (id: string, opts: { scope?: string }) =>
  Effect.gen(function* () {
    const store = yield* EngramStore;
    const projectRoot = yield* store.projectRoot();
    const primary = resolveScope(opts.scope, projectRoot);

    const tried = yield* store.get(primary, id).pipe(Effect.option);
    const mem = Option.isSome(tried)
      ? tried.value
      : yield* store.get(primary === "personal" ? "project" : "personal", id);

    yield* out(renderFull(mem));
  });
