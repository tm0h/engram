/**
 * @engram/core — the engram engine.
 *
 * Pure library: domain models, stores, config, search, and rendering.
 * Any harness (CLI, editor plugin, review bot) can embed this; the
 * `engram` CLI in `packages/cli` is just one consumer.
 */
export * from "./domain.js";
export * from "./errors.js";
export * from "./config.js";
export * from "./store.js";
export * from "./search.js";
export * from "./scope.js";
export * from "./location.js";
export * from "./paths.js";
export * from "./format.js";
export * from "./templates.js";
export * from "./gitignore.js";
export * from "./util.js";
export * from "./layer.js";
