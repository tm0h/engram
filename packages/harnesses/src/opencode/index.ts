/**
 * The engram opencode plugin.
 *
 * Registers the engram_* tools over the @engram/harnesses shared ops plus the
 * experimental chat.system.transform hook that injects the automatic context
 * digest into each session's system prompt. Runs in-process against
 * @engram/core; no CLI binary or network required.
 *
 * Loaded by opencode through the engram-cli package's exports["./server"]
 * entry (bundled as dist/opencode-plugin.js).
 */
import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { createAutoContextTransform } from "./context-transform.js";
import { engramAddTool, engramContextTool, engramSearchTool, engramShowTool } from "./tools.js";

const engramPlugin: Plugin = async (input) => {
  // Deliberately capture the init-time directory for the automatic digest:
  // per-tool context.directory can differ (worktrees, subagents) and stays
  // authoritative for tool calls, while prompt injection follows the plugin's
  // workspace.
  const autoContext = createAutoContextTransform(input.directory);

  const addToolWithRefresh = {
    ...engramAddTool,
    async execute(
      args: unknown,
      context: { sessionID: string; directory: string },
    ): Promise<ReturnType<typeof engramAddTool.execute>> {
      const result = await engramAddTool.execute(
        args as Parameters<typeof engramAddTool.execute>[0],
        context,
      );
      // Refresh only this session's cached digest after a successful write.
      if (!result.metadata?.isError) autoContext.invalidate(context.sessionID);
      return result;
    },
  };

  return {
    tool: {
      engram_context: engramContextTool,
      engram_search: engramSearchTool,
      engram_show: engramShowTool,
      engram_add: addToolWithRefresh,
    },
    "experimental.chat.system.transform": autoContext.transform,
    event: async ({ event }: Parameters<NonNullable<Hooks["event"]>>[0]) => {
      // Opportunistic cleanup; correctness never depends on this event — the
      // cache is bounded and evicts FIFO.
      if (event.type === "session.deleted") {
        autoContext.dropSession(event.properties.info.id);
      }
    },
  } as unknown as Parameters<Plugin>[0] extends never
    ? never
    : NonNullable<Awaited<ReturnType<Plugin>>>;
};

export default engramPlugin;
