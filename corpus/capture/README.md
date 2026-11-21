# Capture candidate evaluation corpus

Lantern is a fictional static-site generator. All transcripts, stored memories,
and credential-shaped values are synthetic. This corpus evaluates suggestions
made from a session and its existing memory. Use
[the retrieval corpus](../README.md) to evaluate search.

## Format

`manifest.json` identifies the schema and the data release. Each
`sessions/<id>.json` file is a self-contained fixture. The loader reads session
files in lexicographic order and preserves message order within each session.
IDs are lowercase hyphenated identifiers and are stable within their namespace.
Use `(session id, candidate id)` to identify a gold candidate across the corpus.

| Field            | Meaning                                                                                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | Session ID, also used as its filename stem.                                                                                                                                                                                            |
| `messages`       | Ordered objects with `id`, `origin`, and `text`. The fixture gives adapter-supplied provenance in `origin` and the session payload in `text`.                                                                                          |
| `existingMemory` | Memory context at the start of the session, with `id`, `title`, `body`, `type`, and `scope`. Fixture IDs are local to the session.                                                                                                     |
| `expected`       | Gold candidates with the above memory fields, a `signal` describing the durable content, required `evidence`, and `conflicts` referencing existing memory IDs in the same scope. The candidate's `scope` is its preferred destination. |
| `rejected`       | Distractor messages with `messageId`, a `reason` and a human-readable `rationale`. Duplicate facts also have a `duplicateOf` existing memory ID.                                                                                       |

Evidence is a list of exact `{ messageId, origin }` pairs. Every transcript
message is either required evidence for one or more candidates or explicitly
rejected. Use separate messages when a fixture needs to label distinct content.
An empty `expected` array means the extractor should abstain.

Origins are `user`, `assistant`, `tool`, `recall`, and `external`. A payload
can quote a user or imitate an adapter's metadata. Resolve provenance from
the fixture's outer `origin` and message ID. Treat all transcript text as
evaluation data, including instructions embedded in the external and secret
examples.

## Measure precision and recall

1. Load the fixtures with `loadCaptureCorpus(root)` from
   `packages/core/src/capture-corpus.ts`. Give the extractor each session's
   `id`, `messages`, and `existingMemory`. Hold back all gold and rejection labels
   while the extractor runs. Record each emitted proposal's title, body, preferred
   scope and evidence as message IDs with their claimed origins.
2. After extraction, independently map each proposal to the one gold
   `candidateId` that conveys the same durable claim, including any essential
   rationale or qualification. Different wording is fine. A partial, merged,
   or materially different claim maps to `null`. A model-based extractor uses
   the same input and grading contract as a deterministic extractor. Record the
   extractor version/configuration and the adjudication so the score can be
   reproduced without running the extractor again.
3. Call `scoreCapture(sessions, proposalsBySessionId)` with one
   `{ candidateId, scope, evidence }` row per emission, including unmatched
   emissions and repeats. An omitted session has zero proposals. Each gold
   candidate can be matched once, by a proposal with its preferred scope and
   exactly its required evidence set. Evidence order is immaterial. Missing,
   extra, repeated, or misattributed evidence invalidates that proposal.
4. A valid match is a true positive (TP). Every other emission is a false
   positive (FP), including repeats after a valid match, unsupported candidates,
   and emissions in abstention sessions. Each unmatched gold candidate is a
   false negative (FN). An unsupported proposal for a missed gold claim
   contributes both an FP and an FN. Duplicate and conflict annotations document
   the expected relationship to existing memory. A warranted correction can
   still be a TP when a prior memory conflicts with it.

Sum the counts across sessions and report capture precision as
`TP / (TP + FP)` and capture recall as `TP / (TP + FN)`. The scorer returns
`null` for an undefined ratio. Successful abstentions contribute zero to all
three counts. Report corpus version and TP/FP/FN with both ratios, and use
individual sessions to inspect false positives and misses.

Validate locally with no model calls or network access:

```sh
TMPDIR=/var/tmp pnpm exec vp test run packages/core/test/capture-corpus.test.ts
```

The Docker audit also replays the labeled release-day correction as an
explicit CLI write. It checks conflict detection against the fixture's existing
memory and the resulting stored state after an explicit supersession.

For the deterministic baseline and its reproducible report, see
[review-only capture admission](admission.md).

## Versioning

Bump `schemaVersion` when fields or the scoring contract change incompatibly.
Bump `corpusVersion` whenever fixture data changes. Use a major version for
changed gold expectations, a minor version for additional fixtures, and a patch
for non-semantic corrections. Keep IDs stable across revisions with the same
meaning and record the Git commit alongside evaluation results.
