/** `engram show <id>` */
import { Effect, Result } from "effect";
import { EngramStore } from "@engram/core";
import { resolveScope } from "@engram/core";
import { renderFull } from "@engram/core";
import { out } from "../io.js";

export const showCommand = (id: string, opts: { scope?: string }) =>
  Effect.gen(function* () {
    const store = yield* EngramStore;
    const projectRoot = yield* store.projectRoot();
    const primary = resolveScope(opts.scope, projectRoot);

    // Only fall back to the other scope on a genuine not-found: an ambiguous
    // or duplicate id in the primary scope must surface as such, not be
    // masked by a misleading "not found in <other scope>".
    const tried = yield* store.get(primary, id).pipe(Effect.result);
    const mem = Result.isSuccess(tried)
      ? tried.success
      : (tried.failure as { _tag?: string })._tag === "EngramNotFoundError"
        ? yield* store.get(primary === "personal" ? "project" : "personal", id)
        : yield* Effect.fail(tried.failure);

    yield* out(renderFull(mem));
  });
