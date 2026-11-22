import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MainLiveAt } from "@engram/core";
import { evaluateCapture, stageCapture } from "@engram/core/capture";
import { Effect } from "effect";

const MAX_STATEMENT_CHARS = 1_000;
const MAX_MESSAGES = 64;
const MAX_PROPOSALS = 8;
const CAPTURE_BUDGET_MS = 200;

type CaptureMessage = {
  id: string;
  origin: "user" | "assistant" | "tool" | "system";
  text: string;
};

export function registerCapture(pi: ExtensionAPI, onWriteSuccess?: () => void): void {
  let active:
    | {
        sessionId: string;
        cwd: string;
        input?: string;
        ordinal: number;
        messages: CaptureMessage[];
      }
    | undefined;

  pi.on("session_start", () => {
    active = undefined;
  });

  pi.on("input", (event, ctx) => {
    // Pi's bundled subagent recipe uses JSON mode. Restrict capture to
    // foreground TUI input and exclude RPC, print and extension prompts.
    if (ctx.mode !== "tui") return;
    const sessionId = ctx.sessionManager.getSessionId();
    if (active?.sessionId !== sessionId || active.cwd !== ctx.cwd) {
      active = { sessionId, cwd: ctx.cwd, ordinal: 0, messages: [] };
    }

    active.input =
      event.source === "interactive" &&
      !event.streamingBehavior &&
      !event.images?.length &&
      event.text.length <= MAX_STATEMENT_CHARS &&
      !event.text.trimStart().startsWith("/")
        ? event.text
        : undefined;
  });

  pi.on("message_end", ({ message }, ctx) => {
    if (
      !active ||
      ctx.mode !== "tui" ||
      active.sessionId !== ctx.sessionManager.getSessionId() ||
      active.cwd !== ctx.cwd
    ) {
      return;
    }

    const content = message.role === "user" ? message.content : undefined;
    // Require an exact delivered text match. Expanded prompts, injected
    // messages, and past session history lack matching interactive input.
    const text =
      typeof content === "string"
        ? content
        : content?.length === 1 && content[0].type === "text"
          ? content[0].text
          : undefined;
    const direct = active.input !== undefined && text === active.input;
    if (message.role === "user") active.input = undefined;

    const origin = direct
      ? "user"
      : message.role === "assistant"
        ? "assistant"
        : message.role === "toolResult"
          ? "tool"
          : "system";
    // Keep a boundary between user statements while discarding the contents
    // of all other messages. Coalesce adjacent non-user boundaries.
    if (!direct && active.messages.at(-1)?.origin !== "user") return;
    active.messages.push({
      id: `message-${message.timestamp}-${++active.ordinal}`,
      origin,
      text: direct ? text : "",
    });
    if (active.messages.length > MAX_MESSAGES) active.messages.shift();
  });

  const flush = async (
    event: "agent_settled" | "session_before_compact" | "session_shutdown",
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) => {
    if (
      !active?.messages.length ||
      ctx.mode !== "tui" ||
      active.sessionId !== ctx.sessionManager.getSessionId() ||
      active.cwd !== ctx.cwd ||
      signal?.aborted
    ) {
      return;
    }
    const { sessionId, cwd, messages } = active;
    // Drain before starting I/O so overlapping or replayed lifecycle events
    // cannot restage the same inputs, even after the user rejects a candidate.
    active.messages = [];
    const proposals = evaluateCapture({ messages }).slice(0, MAX_PROPOSALS);
    if (!proposals.length) return;

    const timeout = new AbortController();
    const captureSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let staged = 0;
    let recorded = 0;
    const stage = async () => {
      for (const { evidence } of proposals) {
        if (captureSignal.aborted) break;
        const result = await Effect.runPromise(
          stageCapture(
            { messages, selectedEvidence: evidence.map(({ messageId }) => messageId) },
            cwd,
            { harness: "pi", sessionKind: "tui", sessionId, event },
            captureSignal,
          ).pipe(Effect.provide(MainLiveAt(cwd))),
          { signal: captureSignal },
        );
        if (result.status === "pending") staged++;
        if (result.status === "recorded") {
          recorded++;
          onWriteSuccess?.();
        }
      }
    };
    try {
      // Stop waiting at the deadline even if storage is cleaning up an
      // interrupted operation. Pi must always be free to finish the session.
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          resolve();
          timeout.abort();
        }, CAPTURE_BUDGET_MS);
      });
      await Promise.race([stage(), deadline]);
    } catch {
      // Capture is best effort. Storage or cancellation errors must not
      // cancel compaction or prevent teardown.
    } finally {
      clearTimeout(timer);
    }
    if (recorded > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `Engram automatically recorded ${recorded} ${recorded === 1 ? "memory" : "memories"}.`,
        "info",
      );
    }
    if (staged > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `Engram staged ${staged} ${staged === 1 ? "candidate" : "candidates"} for review. Run engram pending list --scope all.`,
        "info",
      );
    }
  };

  // Pi stops rendering the TUI before normal quit. Stage at the end of
  // a settled run while the review notice is still visible.
  pi.on("agent_settled", (event, ctx) => flush(event.type, ctx));
  pi.on("session_before_compact", (event, ctx) => flush(event.type, ctx, event.signal));
  pi.on("session_shutdown", (event, ctx) => flush(event.type, ctx));
}
