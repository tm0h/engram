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
import {
  engramAddTool,
  engramContextTool,
  engramEditTool,
  engramSearchTool,
  engramShowTool,
} from "./tools.js";

/** Base tool execute parameters; keeps the wrapper in sync with the adapter. */
type AddArgs = Parameters<typeof engramAddTool.execute>[0];
type AddContext = Parameters<typeof engramAddTool.execute>[1] & { sessionID: string };
type AddResult = Awaited<ReturnType<typeof engramAddTool.execute>>;
type EditArgs = Parameters<typeof engramEditTool.execute>[0];
type EditContext = Parameters<typeof engramEditTool.execute>[1] & { sessionID: string };
type EditResult = Awaited<ReturnType<typeof engramEditTool.execute>>;

const engramPlugin: Plugin = async (input) => {
  // Deliberately capture the init-time directory for the automatic digest:
  // per-tool context.directory can differ (worktrees, subagents) and stays
  // authoritative for tool calls, while prompt injection follows the plugin's
  // workspace.
  const autoContext = createAutoContextTransform(input.directory);

  const writeToolWithRefresh = <
    Args,
    Ctx extends { sessionID: string },
    Result extends {
      metadata?: Record<string, unknown>;
    },
  >(base: {
    execute: (args: Args, context: Ctx) => Promise<Result>;
  }) => ({
    ...base,
    async execute(args: Args, context: Ctx): Promise<Result> {
      const result = await base.execute(args, context);
      // Refresh only this session's cached digest after a successful write.
      if (!result.metadata?.isError) autoContext.invalidate(context.sessionID);
      return result;
    },
  });

  const addToolWithRefresh = writeToolWithRefresh<AddArgs, AddContext, AddResult>(engramAddTool);
  const editToolWithRefresh = writeToolWithRefresh<EditArgs, EditContext, EditResult>(
    engramEditTool,
  );

  // Pre-existing narrow type boundary: the shared tool adapters expose zod
  // raw shapes for `args` while the SDK's ToolDefinition expects a
  // z.ZodObject, so the tool map needs this one cast. Everything else in the
  // returned Hooks object is checked against the installed SDK contract.
  const tool = {
    engram_context: engramContextTool,
    engram_search: engramSearchTool,
    engram_show: engramShowTool,
    engram_add: addToolWithRefresh,
    engram_edit: editToolWithRefresh,
  } as unknown as NonNullable<Hooks["tool"]>;

  const hooks: Hooks = {
    tool,
    "experimental.chat.system.transform": autoContext.transform,
    event: async ({ event }) => {
      // Opportunistic cleanup; correctness never depends on this event — the
      // cache is bounded and evicts FIFO.
      if (event.type === "session.deleted") {
        autoContext.dropSession(event.properties.info.id);
      }
    },
  };

  return hooks;
};

export default engramPlugin;
