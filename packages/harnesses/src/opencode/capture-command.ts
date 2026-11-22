import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { MainLiveAt } from "@engram/core";
import { CaptureMessageId, evaluateCapture, stageCapture } from "@engram/core/capture";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { Effect, Schema } from "effect";

const NAME = "engram-capture";
const TEMPLATE = "Engram handles this command locally. Direct the user to the Engram notification.";
const MAX_SESSIONS = 100;
const MAX_MESSAGES = 64;
const MAX_PROPOSALS = 8;
const MAX_TEXT = 1_000;
const CAPTURE_MS = 1_500;
const isId = Schema.is(CaptureMessageId);
const commandPart = Symbol("OpenCode command part");

type CommandHook = NonNullable<Hooks["command.execute.before"]>;
type ChatHook = NonNullable<Hooks["chat.message"]>;
type Part = Parameters<ChatHook>[1]["parts"][number];
type Message = NonNullable<
  Awaited<ReturnType<PluginInput["client"]["session"]["messages"]>>["data"]
>[number];
type Observed = { partId: string; digest: string; handled: boolean };

function plainText(parts: Part[], sessionID: string, messageID: string) {
  const [part] = parts;
  if (
    parts.length !== 1 ||
    part?.type !== "text" ||
    part.synthetic ||
    part.ignored ||
    part.metadata !== undefined ||
    commandPart in part ||
    part.sessionID !== sessionID ||
    part.messageID !== messageID ||
    !isId(part.id) ||
    typeof part.text !== "string" ||
    part.text.length > MAX_TEXT ||
    part.text.trimStart().startsWith("/")
  ) {
    return;
  }
  return part;
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export function createCaptureCommand(
  { client, directory, project }: PluginInput,
  onWriteSuccess?: () => void,
) {
  const sessions = new Map<string, Map<string, Observed>>();
  const active = new Set<string>();
  let registered = false;

  const config: NonNullable<Hooks["config"]> = async (value) => {
    value.command ??= {};
    if (Object.hasOwn(value.command, NAME)) return;
    value.command[NAME] = {
      description: "Capture Engram memory suggestions for project review or opt-in recording",
      template: TEMPLATE,
    };
    registered = true;
  };

  const observe: ChatHook = async ({ sessionID }, { message, parts }) => {
    if (!registered || message.role !== "user" || message.sessionID !== sessionID) return;
    if (!isId(sessionID) || !isId(message.id)) return;

    // Reusing a message ID for a different prompt makes both versions ambiguous.
    let observed = sessions.get(sessionID);
    if (observed?.has(message.id)) {
      observed.get(message.id)!.handled = true;
      return;
    }
    if (message.system !== undefined) return;
    const part = plainText(parts, sessionID, message.id);
    if (!part) return;

    if (!observed) {
      observed = new Map();
      sessions.set(sessionID, observed);
      if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    }
    observed.set(message.id, { partId: part.id, digest: digest(part.text), handled: false });
    if (observed.size > MAX_MESSAGES) observed.delete(observed.keys().next().value!);
  };

  const notify = (message: string, variant: "info" | "warning" = "info") => {
    // Notification delivery must never hold up the OpenCode command.
    void Promise.resolve()
      .then(() =>
        client?.tui?.showToast({
          body: { title: "Engram capture", message, variant },
          query: { directory },
          signal: AbortSignal.timeout(CAPTURE_MS),
        }),
      )
      .catch(() => undefined);
  };

  const command: CommandHook = async ({ command, sessionID, arguments: args }, { parts }) => {
    if (!registered) return;
    // OpenCode expands custom commands into ordinary user text. The pinned
    // host copies these drafts into chat.message using object spreads.
    // A symbol follows the copies in-process and is omitted by serialization.
    for (const [index, part] of parts.entries()) {
      if (part.type !== "text") continue;
      const marked = { ...part, [commandPart]: true };
      parts[index] = marked;
    }
    if (command !== NAME || !isId(sessionID)) return;
    if (args.trim() || parts.length !== 1) {
      notify("Use /engram-capture without arguments.", "warning");
      return;
    }
    if (parts[0].type !== "text" || parts[0].text !== TEMPLATE) return;
    if (active.has(sessionID)) {
      notify("Engram capture is already running.");
      return;
    }

    const observed = sessions.get(sessionID);
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let count = 0;
    let recorded = 0;
    const capture = async () => {
      if (!client?.session || !project?.id || !directory || !isAbsolute(directory)) {
        return "unavailable";
      }
      const { signal } = abort;
      const { data: session } = await client.session.get({
        path: { id: sessionID },
        query: { directory },
        signal,
      });
      if (
        signal.aborted ||
        !session ||
        session.id !== sessionID ||
        session.projectID !== project.id ||
        !session.directory ||
        !isAbsolute(session.directory) ||
        resolve(session.directory) !== resolve(directory) ||
        session.parentID !== undefined ||
        session.revert !== undefined
      ) {
        return "unavailable";
      }
      if (!observed?.size) return "complete";
      const { data } = await client.session.messages({
        path: { id: sessionID },
        query: { directory, limit: MAX_MESSAGES },
        signal,
      });
      if (signal.aborted || !Array.isArray(data) || data.length > MAX_MESSAGES) {
        return "unavailable";
      }

      const partIds = new Map<string, string>();
      const messages = [];
      for (const item of data as Message[]) {
        const info = item?.info;
        if (!info || info.sessionID !== sessionID || !isId(info.id)) return "unavailable";
        const evidence = observed.get(info.id);
        const part =
          info.role === "user" && info.system === undefined && Array.isArray(item.parts)
            ? plainText(item.parts, sessionID, info.id)
            : undefined;
        if (
          !evidence ||
          !part ||
          evidence.partId !== part.id ||
          evidence.digest !== digest(part.text)
        ) {
          // Keep the boundary so the shared gates cannot join separate turns.
          messages.push({ id: info.id, origin: "system", text: "" });
          continue;
        }
        partIds.set(info.id, part.id);
        messages.push({ id: info.id, origin: "user", text: part.text });
      }

      const proposals = evaluateCapture({ messages }).filter(({ evidence }) =>
        evidence.every(({ messageId }) => observed.get(messageId)?.handled === false),
      );
      for (const { evidence } of proposals.slice(0, MAX_PROPOSALS)) {
        if (signal.aborted || sessions.get(sessionID) !== observed) return "unavailable";
        const ids = evidence.map(({ messageId }) => messageId);
        if (ids.some((id) => observed.get(id)?.handled !== false)) continue;
        const result = await Effect.runPromise(
          stageCapture(
            { messages, selectedEvidence: ids },
            directory,
            {
              harness: "opencode",
              sessionKind: "root",
              sessionId: sessionID,
              event: "command.execute.before",
              partIds,
            },
            signal,
          ).pipe(Effect.provide(MainLiveAt(directory))),
          { signal },
        );
        if (result.status !== "rejected" || result.reason === "duplicate") {
          for (const id of ids) {
            const source = observed.get(id);
            if (source) source.handled = true;
          }
        }
        if (result.status === "pending") count++;
        if (result.status === "recorded") {
          recorded++;
          onWriteSuccess?.();
        }
      }
      return "complete";
    };

    active.add(sessionID);
    try {
      const deadline = new Promise<"unavailable">((resolve) => {
        timer = setTimeout(() => {
          resolve("unavailable");
          abort.abort();
        }, CAPTURE_MS);
      });
      const result = await Promise.race([capture(), deadline]);
      if (recorded > 0) {
        notify(
          `Engram automatically recorded ${recorded} ${recorded === 1 ? "memory" : "memories"}.`,
        );
      }
      if (count) {
        notify(
          `Engram staged ${count} ${count === 1 ? "candidate" : "candidates"} for review. Run engram pending list --scope all.`,
        );
      }
      if (result === "unavailable") {
        notify("Engram capture could not complete for this session.", "warning");
      } else if (!count && !recorded) {
        notify("Engram found no new eligible candidates.");
      }
    } catch {
      notify("Engram capture could not complete. Run engram pending list --scope all.", "warning");
    } finally {
      clearTimeout(timer);
      active.delete(sessionID);
    }
  };

  return { config, command, observe, dropSession: (id: string) => sessions.delete(id) };
}
