/**
 * The engram opencode plugin.
 *
 * Registers the engram_* tools over the @engram/harnesses shared ops plus the
 * experimental chat.system.transform hook that injects memory into the active
 * model request. Retrieval runs in-process against @engram/core.
 *
 * Loaded by opencode through the engram-cli package's exports["./server"]
 * entry (bundled as dist/opencode-plugin.js).
 */
import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { createCaptureCommand } from "./capture-command.js";
import { createContextTransform, resolveActiveRequest } from "./context-transform.js";
import {
  engramAddTool,
  engramContextTool,
  engramEditTool,
  engramSearchTool,
  engramShowTool,
} from "./tools.js";

const engramPlugin: Plugin = async (input) => {
  const capture = createCaptureCommand(input);
  const autoContext = createContextTransform(resolveActiveRequest(input.client));

  const writeToolWithRefresh = <
    Args,
    Ctx,
    Result extends {
      metadata?: Record<string, unknown>;
    },
  >(base: {
    execute: (args: Args, context: Ctx) => Promise<Result>;
  }) => ({
    ...base,
    async execute(args: Args, context: Ctx): Promise<Result> {
      const result = await base.execute(args, context);
      // Project and personal memory can both be shared by several sessions.
      if (result.metadata?.isError === false) autoContext.invalidate();
      return result;
    },
  });

  // Pre-existing narrow type boundary: the shared tool adapters expose zod
  // raw shapes for `args` while the SDK's ToolDefinition expects a
  // z.ZodObject, so the tool map needs this one cast. Everything else in the
  // returned Hooks object is checked against the installed SDK contract.
  const tool = {
    engram_context: engramContextTool,
    engram_search: engramSearchTool,
    engram_show: engramShowTool,
    engram_add: writeToolWithRefresh(engramAddTool),
    engram_edit: writeToolWithRefresh(engramEditTool),
  } as unknown as NonNullable<Hooks["tool"]>;

  const hooks: Hooks = {
    tool,
    config: capture.config,
    "chat.message": capture.observe,
    "command.execute.before": capture.command,
    "experimental.chat.system.transform": autoContext.transform,
    event: async ({ event }) => {
      // Opportunistic cleanup; correctness never depends on this event — the
      // cache is bounded and evicts FIFO.
      if (event.type === "session.deleted") {
        autoContext.dropSession(event.properties.info.id);
        capture.dropSession(event.properties.info.id);
      }
    },
  };

  return hooks;
};

export default engramPlugin;
