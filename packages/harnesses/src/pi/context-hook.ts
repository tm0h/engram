import { Effect } from "effect";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONTEXTUAL_RECALL_LIMITS, contextualRecallOp } from "../shared/contextual-recall.js";
import {
  compactAutomaticContext,
  reportAutomaticContext,
  type AutomaticContextDiagnostics,
  type AutomaticContextResult,
} from "../shared/automatic-compaction.js";
import { runOpAtDirectory } from "../shared/run.js";
import { elapsedUsageMs, recordAutomaticContextUsage } from "../shared/stats.js";

/** Injectable for tests; the real loader runs against `MainLiveAt(cwd)`. */
export type AutoContextLoader = (
  directory: string,
  prompt: string,
) => Promise<AutomaticContextResult>;

const defaultLoader: AutoContextLoader = (directory, prompt) =>
  runOpAtDirectory(directory, contextualRecallOp({ prompt, intent: "task" }, true));

const LOAD_FAILED_WARNING =
  "Engram automatic context could not be loaded for this session; " +
  "call engram_context to load memory manually if needed.";

export function registerAutoContext(
  pi: ExtensionAPI,
  opts: {
    load?: AutoContextLoader;
    onDiagnostics?: (diagnostics: AutomaticContextDiagnostics) => void;
  } = {},
): { readonly invalidate: () => void } {
  const load = opts.load ?? defaultLoader;
  const onDiagnostics = opts.onDiagnostics ?? reportAutomaticContext;
  let pending:
    | { directory: string; prompt: string; result: Promise<AutomaticContextResult> }
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
      return { text: "", isError: true, details: { reason: "unavailable" } };
    }
  };

  pi.on("session_start", () => {
    invalidate();
    warned = false;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const started = performance.now();
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
    const recordDelivery = (text?: string, diagnostics?: AutomaticContextDiagnostics) => {
      // Return the fitted prompt without waiting on a statistics write.
      Effect.runFork(
        recordAutomaticContextUsage("recall", elapsedUsageMs(started), result, text, diagnostics),
      );
    };
    if (
      result.isError ||
      result.details.reason === "unavailable" ||
      result.details.reason === "timeout"
    ) {
      recordDelivery();
      if (!warned && ctx.hasUI) {
        warned = true;
        ctx.ui.notify(LOAD_FAILED_WARNING, "warning");
      }
      return;
    }

    // Each full prompt starts from Pi's assembled system prompt, including
    // overrides from preceding extensions. The block stays out of transcripts.
    if (!result.automatic) {
      recordDelivery();
      return;
    }
    try {
      const { text, diagnostics } = compactAutomaticContext(result.automatic, {
        harness: "pi",
        system: [event.systemPrompt],
        prompt,
        contextWindow: ctx.model?.contextWindow,
        output: ctx.model?.maxTokens,
        priorUsage: ctx.getContextUsage?.()?.tokens,
      });
      onDiagnostics(diagnostics);
      recordDelivery(text, diagnostics);
      if (text) return { systemPrompt: `${event.systemPrompt}\n\n${text}` };
    } catch {
      // Unsupported host metadata must not interrupt the run.
    }
  });

  return { invalidate };
}
