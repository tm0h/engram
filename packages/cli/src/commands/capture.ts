import { Effect } from "effect";
import { ValidationError, captureControl } from "@engram/core";
import { out, readStdin } from "../io.js";

export const captureCommand = (action: Parameters<typeof captureControl>[0]) =>
  Effect.gen(function* () {
    const input = action === "evidence" ? yield* readStdin() : undefined;
    if (input !== undefined && Buffer.byteLength(input) > 128_000) {
      return yield* Effect.fail(
        new ValidationError({ message: "Capture evidence exceeds 128 KB." }),
      );
    }
    const result = yield* captureControl(action, input);
    yield* out(JSON.stringify(result));
    if (action === "evidence" && result.status === "review-only") process.exitCode = 1;
  });
