import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { EngramTypeSchema, ScopeSchema } from "./domain.js";

const Id = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));
const Text = Schema.String.check(Schema.makeFilter((text) => text.trim() !== ""));
const Origin = Schema.Literals(["user", "assistant", "tool", "recall", "external"]);
const Memory = Schema.Struct({
  id: Id,
  title: Text,
  body: Text,
  type: EngramTypeSchema,
  scope: ScopeSchema,
});
const Evidence = Schema.Struct({ messageId: Id, origin: Origin });
const Session = Schema.Struct({
  id: Id,
  messages: Schema.Array(Schema.Struct({ id: Id, origin: Origin, text: Text })),
  existingMemory: Schema.Array(Memory),
  expected: Schema.Array(
    Schema.Struct({
      ...Memory.fields,
      signal: Schema.Literals([
        "remember",
        "correction",
        "decision",
        "gotcha",
        "convention",
        "environment",
      ]),
      evidence: Schema.Array(Evidence),
      conflicts: Schema.Array(Id),
    }),
  ),
  rejected: Schema.Array(
    Schema.Struct({
      messageId: Id,
      reason: Schema.Literals([
        "progress",
        "speculation",
        "tool-output",
        "recalled",
        "external",
        "injection",
        "secret",
        "duplicate",
      ]),
      rationale: Text,
      duplicateOf: Schema.optionalKey(Id),
    }),
  ),
});
const Manifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  corpusVersion: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/)),
  name: Text,
});
export const validateCaptureManifest = Schema.decodeUnknownSync(Manifest);
const strict = { onExcessProperty: "error" } as const;

type Session = typeof Session.Type;
type Proposal = {
  candidateId: string | null;
  scope: typeof ScopeSchema.Type;
  evidence: readonly { messageId: string; origin: string }[];
};

function index<T extends { id: string }>(items: readonly T[], kind: string) {
  const byId = new Map<string, T>();
  for (const item of items) {
    if (byId.has(item.id)) throw new Error(`duplicate ${kind} id ${item.id}`);
    byId.set(item.id, item);
  }
  return byId;
}

export function validateCaptureSession(input: unknown): Session {
  const session = Schema.decodeUnknownSync(Session)(input, strict);
  const messages = index(session.messages, "message");
  const memory = index(session.existingMemory, "existing memory");
  index(session.expected, "candidate");
  if (messages.size === 0) throw new Error("empty transcript");

  const used = new Set<string>();
  for (const candidate of session.expected) {
    if (!candidate.evidence.length) throw new Error(`missing evidence for ${candidate.id}`);
    const refs = new Set<string>();
    for (const { messageId, origin } of candidate.evidence) {
      if (messages.get(messageId)?.origin !== origin || refs.has(messageId)) {
        throw new Error(`invalid evidence or provenance for ${candidate.id}: ${messageId}`);
      }
      refs.add(messageId);
      used.add(messageId);
    }
    if (
      new Set(candidate.conflicts).size !== candidate.conflicts.length ||
      candidate.conflicts.some((id) => memory.get(id)?.scope !== candidate.scope)
    ) {
      throw new Error(`invalid existing memory conflict for ${candidate.id}`);
    }
  }
  for (const { messageId, reason, duplicateOf } of session.rejected) {
    if (!messages.has(messageId) || used.has(messageId)) {
      throw new Error(`invalid rejected message ${messageId}`);
    }
    if (
      reason === "duplicate" ? !duplicateOf || !memory.has(duplicateOf) : duplicateOf !== undefined
    ) {
      throw new Error(`invalid existing memory duplicate for ${messageId}`);
    }
    used.add(messageId);
  }
  if (used.size !== messages.size) throw new Error("unlabelled transcript message");
  return session;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function loadCaptureCorpus(root: string) {
  const manifest = Schema.decodeUnknownSync(Manifest)(
    readJson(join(root, "manifest.json")),
    strict,
  );
  const directory = join(root, "sessions");
  const sessions = readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      try {
        const session = validateCaptureSession(readJson(join(directory, file)));
        if (file !== session.id + ".json") throw new Error("filename does not match session id");
        return session;
      } catch (error) {
        throw new Error(`Invalid capture session ${file}: ${(error as Error).message}`, {
          cause: error,
        });
      }
    });
  if (!sessions.length) throw new Error("empty capture corpus");
  return { manifest, sessions };
}

/** Score proposals after their meanings have been independently mapped to gold labels. */
export function scoreCapture(
  sessions: readonly Session[],
  proposals: Readonly<Record<string, readonly Proposal[]>>,
) {
  const byId = index(sessions, "session");
  for (const id of Object.keys(proposals)) {
    if (!byId.has(id)) throw new Error(`unknown session ${id}`);
  }

  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const session of sessions) {
    const remaining = index(session.expected, "candidate");
    for (const proposal of Object.hasOwn(proposals, session.id) ? proposals[session.id] : []) {
      const expected =
        proposal.candidateId === null ? undefined : remaining.get(proposal.candidateId);
      const provided = new Map(
        proposal.evidence.map(({ messageId, origin }) => [messageId, origin]),
      );
      if (
        expected &&
        proposal.scope === expected.scope &&
        proposal.evidence.length === expected.evidence.length &&
        expected.evidence.every(({ messageId, origin }) => provided.get(messageId) === origin)
      ) {
        remaining.delete(expected.id);
        tp++;
      } else {
        fp++;
      }
    }
    fn += remaining.size;
  }
  return {
    tp,
    fp,
    fn,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
  };
}
