import { Effect } from "effect";
import { MainLiveAt } from "@engram/core";
import { stageCapture as stage } from "@engram/core/capture";

export { CAPTURE_RULES_VERSION, evaluateCapture } from "@engram/core/capture";

/** Run a single review-only admission using host-supplied provenance and cwd. */
export const stageCapture = (request: unknown, cwd: string) =>
  Effect.runPromise(stage(request, cwd).pipe(Effect.provide(MainLiveAt(cwd))));
