/**
 * Pi lifecycle delivery for the automatic context digest.
 *
 * `session_start` starts one `autoContextOp` load per session and caches the
 * PROMISE (not the resolved payload — the first prompt in print/piped mode
 * can otherwise race the load). `before_agent_start` awaits that promise and
 * appends the single bounded block to the turn's system prompt; it never
 * injects a persistent transcript message, so resumed sessions do not
 * accumulate copies.
 *
 * Failure is fail-open: any error leaves the system prompt untouched and
 * surfaces at most one concise UI warning per session (never engram
 * content), only when `ctx.ui.hasUI` is true.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { autoContextOp } from "../shared/ops.js";
import { runOpAtDirectory } from "../shared/run.js";
import type { OpResult } from "../shared/types.js";

/** Injectable for tests; the real loader runs against `MainLiveAt(cwd)`. */
export type AutoContextLoader = (directory: string) => Promise<OpResult>;

/** The slice of ExtensionContext the warning path touches. */
type NotifyContext = Pick<ExtensionContext, "hasUI" | "ui">;

export interface AutoContextState {
  /** Drop the cached load; the next agent start reloads the digest. */
  readonly invalidate: () => void;
}

const defaultLoader: AutoContextLoader = (directory) =>
  runOpAtDirectory(directory, autoContextOp());

const LOAD_FAILED_WARNING =
  "Engram automatic context could not be loaded for this session; " +
  "call engram_context to load memory manually if needed.";

/** Structured failure the cached promise resolves to when loading breaks. */
const LOAD_FAILED: OpResult = {
  text: "",
  isError: false,
  details: { loaded: false, error: "load failed" },
};

export function registerAutoContext(
  pi: ExtensionAPI,
  opts: { load?: AutoContextLoader } = {},
): AutoContextState {
  const load = opts.load ?? defaultLoader;
  let pending: Promise<OpResult> | null = null;
  let warned = false;

  /**
   * Start a load whose failure modes are handled at creation time:
   * synchronous throws and asynchronous rejections convert to the structured
   * failure, so the cached promise can never reject. Without this, a fast
   * rejection in the gap between session_start and the first
   * before_agent_start await would be an unhandled rejection (potentially
   * fatal under strict Node handling). The user-facing warning still fires
   * only later, from before_agent_start.
   */
  const startLoad = (directory: string): Promise<OpResult> => {
    try {
      return load(directory).then(
        (result) => result,
        () => LOAD_FAILED,
      );
    } catch {
      return Promise.resolve(LOAD_FAILED);
    }
  };

  const warnOnce = (ctx: NotifyContext) => {
    if (warned || !ctx.hasUI) return;
    warned = true;
    ctx.ui.notify(LOAD_FAILED_WARNING, "warning");
  };

  // All documented reasons reload: startup | reload | new | resume | fork.
  // (new/resume/fork rebind extension instances, so the closure is fresh,
  // but reload happens in-place and must reset the cache explicitly.)
  pi.on("session_start", (_event, ctx) => {
    pending = startLoad(ctx.cwd);
    warned = false; // fresh session: one new warning budget
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // Safety net: start late if session_start was missed or after invalidate.
    const promise = pending ?? (pending = startLoad(ctx.cwd));

    let result: OpResult;
    try {
      result = await promise;
    } catch {
      // autoContextOp is infallible by type; a rejection here is a defect.
      warnOnce(ctx);
      return undefined; // leave the system prompt untouched
    }

    if (result.text === "") {
      // Disabled, empty, or failed load: no block. Failed loads warn once.
      if (typeof result.details.error === "string") warnOnce(ctx);
      return undefined;
    }

    return { systemPrompt: `${event.systemPrompt}\n\n${result.text}` };
  });

  return {
    invalidate: () => {
      pending = null;
    },
  };
}
