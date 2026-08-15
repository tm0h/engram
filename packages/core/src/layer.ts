/**
 * The main application layer: wires the EngramStore + ConfigRepo services over
 * the Node.js platform services (FileSystem, Path, Terminal, ...).
 */
import { Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import { EngramStoreLive } from "./store.js";
import { ConfigRepoLive } from "./config.js";

/** Services built on the platform layer (FileSystem/Path satisfied). */
const AppServices = Layer.mergeAll(EngramStoreLive, ConfigRepoLive).pipe(
  Layer.provide(NodeServices.layer),
);

/**
 * Provides EngramStore, ConfigRepo, and the raw platform services
 * (FileSystem, Path, Terminal) for commands that need them directly.
 */
export const MainLive = Layer.mergeAll(AppServices, NodeServices.layer);
