/**
 * The main application layer: wires the EngramStore + ConfigRepo services over
 * the Node.js platform services (FileSystem, Path, Terminal, ...).
 */
import { Layer } from "effect";
import { NodeServices } from "@effect/platform-node";
import { EngramStoreLive, EngramStoreLiveAt } from "./store.js";
import { ConfigRepoLive } from "./config.js";

/** Services built on the platform layer (FileSystem/Path satisfied). */
const appServices = (store: typeof EngramStoreLive) =>
  Layer.mergeAll(store, ConfigRepoLive).pipe(Layer.provide(NodeServices.layer));

/**
 * Provides EngramStore, ConfigRepo, and the raw platform services
 * (FileSystem, Path, Terminal) for commands that need them directly.
 */
export const MainLive = Layer.mergeAll(appServices(EngramStoreLive), NodeServices.layer);

/** Main application layer pinned to a harness-provided workspace directory. */
export const MainLiveAt = (directory: string): typeof MainLive =>
  Layer.mergeAll(appServices(EngramStoreLiveAt(directory)), NodeServices.layer);
