/** Run a shared op over the main layer; uniform for tools and commands. */
import { Effect } from "effect";
import { ConfigRepo, EngramStore, MainLive } from "@engram/core";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import type { OpResult } from "../shared/types.js";

export type OpEffect = Effect.Effect<OpResult, never, EngramStore | ConfigRepo | FileSystem | Path>;

export const runOp = (eff: OpEffect): Promise<OpResult> =>
  Effect.runPromise(Effect.provide(eff, MainLive));

/** Map an OpResult to a pi tool result (D16: isError for genuine failures). */
export const toToolResult = (r: OpResult) => ({
  content: [{ type: "text" as const, text: r.text }],
  isError: r.isError,
  details: r.details,
});
