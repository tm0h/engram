/** Run a shared op over the main layer; uniform for every harness adapter. */
import { Effect } from "effect";
import { ConfigRepo, EngramStore, MainLive, MainLiveAt } from "@engram/core";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import type { OpResult } from "./types.js";

export type OpEffect<A extends OpResult = OpResult> = Effect.Effect<
  A,
  never,
  EngramStore | ConfigRepo | FileSystem | Path
>;

export const runOp = (eff: OpEffect): Promise<OpResult> =>
  Effect.runPromise(Effect.provide(eff, MainLive));

/** Run an op against the workspace directory supplied by a harness. */
export const runOpAtDirectory = <A extends OpResult>(
  directory: string,
  eff: OpEffect<A>,
): Promise<A> => Effect.runPromise(Effect.provide(eff, MainLiveAt(directory)));
