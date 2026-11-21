import { Effect, Result, Schema } from "effect";
import type { EngramType, Scope } from "./domain.js";
import {
  CaptureMessageId as Id,
  CaptureOrigin,
  type CaptureSource,
  enqueuePendingCandidate,
  listPendingIds,
  readPendingCandidate,
  withPendingAdmissionLock,
} from "./pending-store.js";
import { scanContent } from "./secrets.js";
import { EngramStore } from "./store.js";

export const CAPTURE_RULES_VERSION = 1;

const Message = Schema.Struct({
  id: Id,
  origin: CaptureOrigin,
  text: Schema.String,
});
const Request = Schema.Struct({
  messages: Schema.Array(Message),
  externalApprovals: Schema.optionalKey(
    Schema.Array(Schema.Struct({ externalId: Id, userMessageId: Id })),
  ),
  selectedEvidence: Schema.optionalKey(Schema.NonEmptyArray(Id)),
});
type Message = typeof Message.Type;
type Evidence = { readonly messageId: string; readonly origin: Message["origin"] };
type Signal = "remember" | "correction" | "decision" | "gotcha" | "convention" | "environment";
type Claim = {
  readonly signal: Signal;
  readonly scope: Scope;
  readonly type: EngramType;
  readonly body: string;
};
type CaptureProposal = Claim & {
  readonly title: string;
  readonly evidence: readonly Evidence[];
  readonly sourceExcerpt: string;
};
type StoredClaim = Pick<Claim, "scope" | "body">;

const externalRequest = "Remember this external claim: ";
// Rules operate on complete, short statements. Reject examples, hedges and
// short-lived updates before any durable signal can fire.
const transient =
  /\b(?:for (?:today|now|this (?:task|run|session)|today's)|currently|in progress|\d+\s*(?:%|percent)\s+complete|maybe|perhaps|might|may want|could|temporar(?:y|ily)|speculat\w*|throwaway|still running|(?:i|we) (?:just )?(?:opened|started|finished|updated) (?:the|this) (?:diff|task|build|branch))\b/i;
const embedded =
  /[\p{Cc}\u2028\u2029<>]|(?:^|\s)(?:\[(?:adapter|origin|system|user|tool|assistant)\b|\x60\x60\x60)|\b(?:quote(?:d)?|example|recalled memory|tool output|the above|the following|according to|(?:page|article|tool|assistant) (?:says?|said))\b/iu;
const unsafe = (text: string) =>
  text.length > 1000 || transient.test(text) || embedded.test(text) || scanContent(text).length > 0;

function directClaim(text: string): Claim | undefined {
  if (unsafe(text) || text.includes("?") || /^remember this external claim:/i.test(text)) return;
  const remember =
    /^(?:please )?(?:remember my preference across projects:\s+|remember (?:that\s+|this:\s+)|remember:\s+)/i;
  const body = text.replace(remember, "").trim();
  if (body !== text && /\p{L}+\s+\p{L}+/u.test(body)) {
    const personal = /^(?:please )?remember my preference across projects:/i.test(text);
    return {
      signal: "remember",
      scope: personal ? "personal" : "project",
      type: personal ? "preference" : "fact",
      body,
    };
  }
  if (/^correction(?: for [^:]+)?:\s+\S.+/i.test(text)) {
    return { signal: "correction", scope: "project", type: "decision", body: text };
  }
  if (/^(?:for [^,]+,\s+)?we decided to .+\s(?:because|so(?: that)?)\s+\S.+/i.test(text)) {
    return { signal: "decision", scope: "project", type: "decision", body: text };
  }
  if (/^(?:our|the|this project's) convention is to \S.+/i.test(text)) {
    return { signal: "convention", scope: "project", type: "fact", body: text };
  }
  if (/^[^.?!]+\bon every (?:checkout|install|deployment)\b/i.test(text)) {
    return { signal: "environment", scope: "project", type: "fact", body: text };
  }
}

function gotchaClaim(previous: Message | undefined, text: string): Claim | undefined {
  if (
    previous?.origin !== "user" ||
    unsafe(previous.text) ||
    unsafe(text) ||
    !/^yesterday .+\bagain\./i.test(previous.text) ||
    !/^the same (?:thing|issue) happened today\b[^.!?]*\.\s+we fixed both by \S.+/i.test(text)
  ) {
    return;
  }
  return { signal: "gotcha", scope: "project", type: "issue", body: previous.text + "\n\n" + text };
}

function proposal(claim: Claim, messages: readonly Message[]): CaptureProposal {
  const heading = claim.body.split(/[.!?](?:\s|$)/, 1)[0];
  const characters = Array.from(heading);
  return {
    ...claim,
    title: characters.length <= 72 ? heading : characters.slice(0, 71).join("").trimEnd() + "…",
    evidence: messages.map(({ id, origin }) => ({ messageId: id, origin })),
    sourceExcerpt: messages.map(({ text }) => text).join("\n\n"),
  };
}

const claimKey = (body: string) => body.trim().normalize("NFC").replace(/\s+/g, " ");
const isDuplicate = (claim: StoredClaim, existing: readonly StoredClaim[]) =>
  existing.some(
    (entry) => entry.scope === claim.scope && claimKey(entry.body) === claimKey(claim.body),
  );

/** Transcript and approval metadata must be assembled by the host adapter.
 * Model output can supply evidence IDs only. All material comes from the
 * adapter's source messages, and the eligibility rules run before selection. */
export function evaluateCapture(input: unknown, existing: readonly StoredClaim[] = []) {
  const decoded = Schema.decodeUnknownResult(Request)(input, { onExcessProperty: "error" });
  if (Result.isFailure(decoded)) return [];
  const { messages, externalApprovals = [], selectedEvidence } = decoded.success;
  const index = new Map(messages.map((message, position) => [message.id, { message, position }]));
  if (index.size !== messages.length) return [];

  const approvals = new Map<string, Message>();
  for (const { externalId, userMessageId } of externalApprovals) {
    const source = index.get(externalId);
    const approval = index.get(userMessageId);
    if (
      source?.message.origin !== "external" ||
      approval?.message.origin !== "user" ||
      source.position >= approval.position ||
      approvals.has(userMessageId) ||
      approval.message.text !== externalRequest + source.message.text
    ) {
      return [];
    }
    approvals.set(userMessageId, source.message);
  }

  const proposals: CaptureProposal[] = [];
  for (const [position, message] of messages.entries()) {
    if (message.origin !== "user") continue;
    const text = message.text.trim();
    const source = approvals.get(message.id);
    const prior = messages[position - 1];
    // Explicitly approved external claims carry both sides of the consent.
    const claim: Claim | undefined = source
      ? directClaim("Remember that " + source.text)
      : (directClaim(text) ?? gotchaClaim(prior, text));
    if (!claim) continue;
    const candidate = proposal(
      claim,
      source ? [source, message] : claim.signal === "gotcha" ? [prior, message] : [message],
    );
    if (
      selectedEvidence &&
      (candidate.evidence.length !== selectedEvidence.length ||
        candidate.evidence.some(({ messageId }) => !selectedEvidence.includes(messageId)))
    ) {
      continue;
    }
    if (
      scanContent(candidate.sourceExcerpt).length ||
      isDuplicate(candidate, existing) ||
      isDuplicate(candidate, proposals)
    ) {
      continue;
    }
    proposals.push(candidate);
  }
  return proposals;
}

export const stageCapture = Effect.fnUntraced(function* (
  input: unknown,
  cwd: string,
  source?: Omit<CaptureSource, "evidence">,
) {
  const proposals = evaluateCapture(input);
  if (proposals.length !== 1) {
    return { status: "rejected", reason: proposals.length ? "ambiguous" : "ineligible" } as const;
  }
  const { scope, title, body, type, sourceExcerpt, evidence } = proposals[0];
  const store = yield* EngramStore;
  return yield* withPendingAdmissionLock(
    scope,
    Effect.gen(function* () {
      const existing: StoredClaim[] = [];
      for (const id of yield* listPendingIds(scope, cwd)) {
        const candidate = yield* readPendingCandidate(scope, id, cwd).pipe(
          Effect.catchIf(
            (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
            () => Effect.succeed(undefined),
          ),
        );
        if (candidate) existing.push({ scope, body: candidate.proposed.body });
      }
      // Review publishes before it removes a candidate. Read canonical memory
      // after pending so a concurrent approval remains visible in either store.
      const canonical = yield* store.list(scope);
      if (isDuplicate(proposals[0], [...existing, ...canonical])) {
        return { status: "rejected", reason: "duplicate" } as const;
      }
      const candidate = yield* enqueuePendingCandidate(
        {
          scope,
          proposed: { title, body, type, tags: [] },
          sourceExcerpt,
          provenanceClass: "conversation",
          ...(source && { captureSource: { ...source, evidence } }),
          duplicates: [],
          conflicts: [],
        },
        cwd,
      );
      return { status: "pending", id: candidate.id, scope, evidence } as const;
    }),
    cwd,
  );
});
