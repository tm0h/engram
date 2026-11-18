import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONTEXTUAL_RECALL_LIMITS, contextualRecallOp } from "../shared/contextual-recall.js";
import { runOpAtDirectory } from "../shared/run.js";
import type { OpResult } from "../shared/types.js";

/** Injectable for tests; the real loader runs against `MainLiveAt(cwd)`. */
export type AutoContextLoader = (directory: string, prompt: string) => Promise<OpResult>;

const defaultLoader: AutoContextLoader = (directory, prompt) =>
  runOpAtDirectory(directory, contextualRecallOp({ prompt, intent: "task" }));

const LOAD_FAILED_WARNING =
  "Engram automatic context could not be loaded for this session; " +
  "call engram_context to load memory manually if needed.";

export function registerAutoContext(
  pi: ExtensionAPI,
  opts: { load?: AutoContextLoader } = {},
): { readonly invalidate: () => void } {
  const load = opts.load ?? defaultLoader;
  let pending:
    | { directory: string; prompt: string; result: Promise<OpResult | undefined> }
    | undefined;
  let generation = 0;
  let warned = false;

  const invalidate = () => {
    generation++;
    pending = undefined;
  };

  const read = async (directory: string, prompt: string) => {
    try {
      return await load(directory, prompt);
    } catch {
      return undefined;
    }
  };

  pi.on("session_start", () => {
    invalidate();
    warned = false;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const { prompt } = event;
    const directory = ctx.cwd;
    if (prompt.length > CONTEXTUAL_RECALL_LIMITS.promptChars) {
      invalidate();
      return;
    }

    // Share only an in-flight read. New prompts see current settings and store
    // contents. Pi reuses the override for provider requests within the run.
    if (pending?.directory !== directory || pending.prompt !== prompt) {
      generation++;
      pending = { directory, prompt, result: read(directory, prompt) };
    }
    const requestGeneration = generation;
    const result = await pending.result;
    if (requestGeneration !== generation) return;

    pending = undefined;
    if (
      !result ||
      result.isError ||
      result.details.reason === "unavailable" ||
      result.details.reason === "timeout"
    ) {
      if (!warned && ctx.hasUI) {
        warned = true;
        ctx.ui.notify(LOAD_FAILED_WARNING, "warning");
      }
      return;
    }

    // Each full prompt starts from Pi's assembled system prompt, including
    // overrides from preceding extensions. The block stays out of transcripts.
    if (result.text) return { systemPrompt: `${event.systemPrompt}\n\n${result.text}` };
  });

  return { invalidate };
}
