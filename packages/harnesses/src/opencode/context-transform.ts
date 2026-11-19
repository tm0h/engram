import { isAbsolute } from "node:path";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { Effect, Option } from "effect";
import {
  compactAutomaticContext,
  reportAutomaticContext,
  type AutomaticContext,
  type AutomaticContextDiagnostics,
} from "../shared/automatic-compaction.js";
import { CONTEXTUAL_RECALL_LIMITS, contextualRecallOp } from "../shared/contextual-recall.js";
import { autoContextOp } from "../shared/ops.js";
import { elapsedUsageMs, recordBootstrapUsage } from "../shared/stats.js";
import { runOpAtDirectory } from "../shared/run.js";

export const MAX_SESSIONS = 100;
const MAX_ID_CHARS = 256;
const CACHE_MS = 30_000;
const SDK_TIMEOUT_MS = 500;

export interface ActiveRequest {
  readonly directory: string;
  readonly messageID: string;
  readonly prompt: string;
}

type SystemTransform = NonNullable<Hooks["experimental.chat.system.transform"]>;
type RequestModel = Pick<Parameters<SystemTransform>[0]["model"], "id" | "providerID">;
type RequestResolver = (
  sessionID: string,
  model: RequestModel,
) => Promise<ActiveRequest | undefined>;
type ContextLoader = (request: ActiveRequest) => Promise<AutomaticContext | undefined>;

const validId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && id.length <= MAX_ID_CHARS;

/**
 * OpenCode stores the pending assistant message before preparing its system
 * prompt. Its parent identifies the user message for this turn, even when
 * tool calls have added newer assistant messages. The assistant's working
 * directory comes from the same execution context as the native tools.
 */
const lookupActiveRequest = async (
  client: PluginInput["client"] | undefined,
  sessionID: string,
  model: RequestModel,
  signal: AbortSignal,
): Promise<ActiveRequest | undefined> => {
  const session = client?.session;
  if (typeof session?.messages !== "function" || typeof session.message !== "function") return;
  if (!model?.id || !model.providerID) return;

  const { data } = await session.messages({
    path: { id: sessionID },
    query: { limit: 1 },
    signal,
  });
  if (!Array.isArray(data) || data.length !== 1) return;
  const assistant = data[0]?.info;
  if (
    assistant?.role !== "assistant" ||
    assistant.sessionID !== sessionID ||
    assistant.modelID !== model.id ||
    assistant.providerID !== model.providerID ||
    !assistant.time ||
    assistant.time.completed !== undefined ||
    assistant.summary ||
    assistant.finish !== undefined ||
    !validId(assistant.parentID)
  )
    return;

  const directory = assistant.path?.cwd;
  if (
    typeof directory !== "string" ||
    directory.length > CONTEXTUAL_RECALL_LIMITS.rootChars ||
    directory.includes("\0") ||
    !isAbsolute(directory)
  )
    return;

  const messageID = assistant.parentID;
  const { data: message } = await session.message({
    path: { id: sessionID, messageID },
    signal,
  });
  if (
    signal.aborted ||
    message?.info?.role !== "user" ||
    message.info.id !== messageID ||
    message.info.sessionID !== sessionID ||
    !Array.isArray(message.parts)
  )
    return;

  let prompt = "";
  for (const part of message.parts) {
    if (part?.type !== "text" || part.synthetic || part.ignored || part.text === "") continue;
    if (
      part.sessionID !== sessionID ||
      part.messageID !== messageID ||
      typeof part.text !== "string"
    )
      return;
    if (
      prompt.length + part.text.length + Number(Boolean(prompt)) >
      CONTEXTUAL_RECALL_LIMITS.promptChars
    )
      return;
    prompt += prompt ? "\n" + part.text : part.text;
  }
  if (prompt.trim()) return { directory, messageID, prompt };
};

export const resolveActiveRequest =
  (client: PluginInput["client"] | undefined): RequestResolver =>
  (sessionID, model) =>
    Effect.runPromise(
      Effect.promise((signal) => lookupActiveRequest(client, sessionID, model, signal)).pipe(
        Effect.timeoutOption(SDK_TIMEOUT_MS),
        Effect.map(Option.getOrUndefined),
      ),
    );

const loadContext: ContextLoader = async ({ directory, prompt }) => {
  const recall = await runOpAtDirectory(
    directory,
    contextualRecallOp({ prompt, intent: "task" }, true),
  );
  if (recall.details.reason !== "weak" && recall.details.reason !== "empty-query")
    return recall.automatic;

  // The fallback adds title-only bootstrap rows after critical excerpts.
  const started = performance.now();
  const loaded = await runOpAtDirectory(
    directory,
    Effect.gen(function* () {
      const digest = yield* autoContextOp(true).pipe(
        Effect.timeoutOption(CONTEXTUAL_RECALL_LIMITS.timeoutMs),
      );
      const result = Option.getOrUndefined(digest);
      const text = result?.text ?? "";
      yield* recordBootstrapUsage("bootstrap", elapsedUsageMs(started), result, text);
      return result ?? { text, isError: false, details: {}, automatic: undefined };
    }),
  );
  if (loaded.details.enabled === false) return;
  if (!loaded.automatic) return recall.automatic;
  const source = loaded.automatic;
  const critical = recall.automatic?.rows ?? [];
  const ids = new Set(critical.map(({ scope, id }) => `${scope}/${id}`));
  return {
    ...source,
    outsideCandidateWindow:
      (source.outsideCandidateWindow ?? 0) + (recall.automatic?.outsideCandidateWindow ?? 0),
    rows: [...critical, ...source.rows.filter(({ scope, id }) => !ids.has(`${scope}/${id}`))],
  };
};

interface SessionCache {
  context?: {
    request: ActiveRequest;
    until: number;
    source: Promise<AutomaticContext | undefined>;
  };
}

interface OutputState {
  injection?: string;
}

export function createContextTransform(
  resolve: RequestResolver,
  {
    load = loadContext,
    onDiagnostics = reportAutomaticContext,
  }: {
    load?: ContextLoader;
    onDiagnostics?: (diagnostics: AutomaticContextDiagnostics) => void;
  } = {},
) {
  const sessions = new Map<string, SessionCache>();
  const outputs = new WeakMap<string[], OutputState>();

  const transform: SystemTransform = async (input, output) => {
    try {
      const system = output?.system;
      if (!Array.isArray(system) || !Object.isExtensible(system)) return;
      const previous = outputs.get(system)?.injection;
      if (previous) {
        // Remove our own unmodified entry even if another hook shifted it.
        const index = system.indexOf(previous);
        if (index !== -1 && index === system.lastIndexOf(previous)) system.splice(index, 1);
      }
      const state: OutputState = {};
      outputs.set(system, state);
      const sessionID = input?.sessionID;
      if (!validId(sessionID)) return;

      let cache = sessions.get(sessionID);
      if (!cache) {
        cache = {};
        sessions.set(sessionID, cache);
        const oldest = sessions.keys().next().value;
        if (sessions.size > MAX_SESSIONS && oldest !== undefined) sessions.delete(oldest);
      }

      const request = await resolve(sessionID, input.model);
      if (!request || sessions.get(sessionID) !== cache || outputs.get(system) !== state) return;

      const now = performance.now();
      let context = cache.context;
      if (
        !context ||
        context.until <= now ||
        context.request.directory !== request.directory ||
        context.request.messageID !== request.messageID ||
        context.request.prompt !== request.prompt
      ) {
        const source = (async () => load(request))().catch(() => undefined);
        context = { request, until: now + CACHE_MS, source };
        cache.context = context;
      }

      const source = await context.source;
      if (!source?.rows.length && cache.context === context) cache.context = undefined;
      if (!source) return;
      // A deletion, write, or reused output can race a read. Its old promise
      // may finish, but it cannot inject into a newer request's output.
      if (
        sessions.get(sessionID) !== cache ||
        outputs.get(system) !== state ||
        output.system !== system
      )
        return;
      const limit: { context?: number; input?: number; output?: number } | undefined =
        input.model?.limit;
      const { text, diagnostics } = compactAutomaticContext(source, {
        harness: "opencode",
        system,
        prompt: request.prompt,
        contextWindow: limit?.context,
        inputLimit: limit?.input,
        output: limit?.output,
      });
      onDiagnostics(diagnostics);
      if (!text) return;
      system.push(text);
      state.injection = text;
    } catch {
      // An unavailable SDK or unsupported hook shape leaves the model usable.
    }
  };

  return {
    transform,
    invalidate: () => sessions.clear(),
    dropSession: (sessionID: string) => sessions.delete(sessionID),
  };
}
