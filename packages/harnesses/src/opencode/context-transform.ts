/**
 * OpenCode automatic prompt delivery through the experimental
 * `chat.system.transform` hook.
 *
 * OpenCode rebuilds its system array for every physical model request, so the
 * cached block is reapplied per call by mutating `output.system` in place.
 * Loading is lazy per sessionID and shares one immediately-handled,
 * never-rejecting promise; the cache is bounded and evicts FIFO.
 *
 * The digest directory is the PluginInput.directory captured at plugin
 * initialization — tool calls may receive a different per-call
 * context.directory (worktrees, subagents) and are unaffected here.
 *
 * Isolated in this module so drift in the experimental SDK seam fails the
 * focused contract tests instead of the tool adapters.
 */
import { autoContextOp } from "../shared/ops.js";
import { runOpAtDirectory } from "../shared/run.js";
import type { OpResult } from "../shared/types.js";

/** Hard bound on cached sessions; oldest insertion is evicted first. */
export const MAX_SESSIONS = 100;

const MARKER = "<engram-memory>";

/** Injectable for tests; the real loader runs against MainLiveAt(directory). */
export type AutoContextLoader = (directory: string) => Promise<OpResult>;

const defaultLoader: AutoContextLoader = (directory) =>
  runOpAtDirectory(directory, autoContextOp());

/** Structured failure the cached promise resolves to when loading breaks. */
const LOAD_FAILED: OpResult = {
  text: "",
  isError: false,
  details: { loaded: false, error: "load failed" },
};

export interface AutoContextTransform {
  /** The experimental.chat.system.transform hook implementation. */
  readonly transform: (
    input: { sessionID?: string; model?: unknown },
    output: { system: string[] },
  ) => Promise<void>;
  /** Drop one session's cached load so its next model request reloads. */
  readonly invalidate: (sessionID: string) => void;
  /** Drop one session's cached load (session.deleted cleanup). */
  readonly dropSession: (sessionID: string) => void;
}

export function createAutoContextTransform(
  directory: string,
  opts: { load?: AutoContextLoader } = {},
): AutoContextTransform {
  const load = opts.load ?? defaultLoader;
  const cache = new Map<string, Promise<OpResult>>();

  /**
   * Start a load whose failure modes are handled at creation time: sync
   * throws and async rejections convert to the structured failure, so no
   * cached promise can ever reject (an unhandled rejection could kill the
   * opencode server process during the gap before the first await).
   */
  const startLoad = (sessionID: string): Promise<OpResult> => {
    const promise = (() => {
      try {
        return load(directory).then(
          (result) => result,
          () => LOAD_FAILED,
        );
      } catch {
        return Promise.resolve(LOAD_FAILED);
      }
    })();
    cache.set(sessionID, promise);
    if (cache.size > MAX_SESSIONS) {
      // Map iterates in insertion order: evict the oldest session.
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return promise;
  };

  const dropSession = (sessionID: string): void => {
    cache.delete(sessionID);
  };

  const transform = async (
    input: { sessionID?: string; model?: unknown },
    output: { system: string[] },
  ): Promise<void> => {
    // OpenCode also invokes prompt transforms for non-session workflows
    // (e.g. small-model helpers); those get no injection.
    if (!input.sessionID) return;

    const result = await (cache.get(input.sessionID) ?? startLoad(input.sessionID));
    if (result.text === "") return; // disabled, empty, or failed: leave as-is

    // At most one marker per output array, even if some earlier plugin
    // (or a reused array) already contains one.
    if (output.system.some((part) => part.includes(MARKER))) return;

    if (output.system.length === 0) {
      output.system.push(result.text);
    } else {
      output.system[0] = `${output.system[0]}\n\n${result.text}`;
    }
  };

  return { transform, invalidate: dropSession, dropSession };
}
