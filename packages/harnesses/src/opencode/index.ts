/**
 * The engram opencode plugin.
 *
 * Registers the engram_* tools over the @engram/harnesses shared ops.
 * Runs in-process against @engram/core; no CLI binary or network required.
 *
 * Loaded by opencode through the engram-cli package's exports["./server"]
 * entry (bundled as dist/opencode-plugin.js).
 */
import type { Plugin } from "@opencode-ai/plugin";
import { engramAddTool, engramContextTool, engramSearchTool, engramShowTool } from "./tools.js";

const engramPlugin: Plugin = async () => ({
  tool: {
    engram_context: engramContextTool,
    engram_search: engramSearchTool,
    engram_show: engramShowTool,
    engram_add: engramAddTool,
  } as unknown as Parameters<Plugin>[0] extends never
    ? never
    : NonNullable<Awaited<ReturnType<Plugin>>["tool"]>,
});

export default engramPlugin;
