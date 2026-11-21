# Review-only capture admission

`engram-cli/capture` exports `CAPTURE_RULES_VERSION`, `evaluateCapture(request)`,
and `stageCapture(request, cwd)`. The host adapter constructs the request from
its own event records. Assign a unique ID and an origin to every message. Use
`user` for direct user-authored text and preserve `assistant`, `tool`, `recall`,
`external`, and `system` at their original boundaries, including when they are
embedded in a larger event. Treat ambiguous provenance as ineligible. A role
label or trust claim in the text has no authority.

Rule version 1 uses conservative English signals for short user statements.

| Signal                   | Accepted evidence                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remember request         | Explicit `Remember that …`, `Remember: …`, or `Remember this: …` followed by content. `Remember my preference across projects: …` selects personal scope. |
| Correction               | `Correction: …` or `Correction for …: …` stated by the user.                                                                                              |
| Decision                 | A user statement beginning with `We decided to …` and including a rationale introduced by `because` or `so`.                                              |
| Recurring gotcha         | Two consecutive user statements linking a repeated problem to an explicit workaround.                                                                     |
| Convention               | An explicit convention, such as `Our convention is to …`.                                                                                                 |
| Durable environment fact | A statement tied to every checkout, install, or deployment.                                                                                               |

Project scope is the default. The rules screen statements for transient progress,
speculation, quoted or scaffolded text, and unsafe content. Assistant, tool,
system, and recalled messages never supply candidate text. External content
requires a separate, later user message containing
`Remember this external claim: <exact external text>` and an adapter-supplied
`externalApprovals` entry with `externalId` and `userMessageId`. Both messages
are evidence. The gate checks their origins, order, and exact text, then
applies the same content checks as for a direct remember request.

An optional extractor can supply `selectedEvidence`, an array of unique
message IDs matching one complete evidence set. The gate derives the claim,
title, scope, and type from the source. Model-written text and metadata are
outside the request contract. Duplicate IDs, inconsistent approval metadata,
and nominations with missing, extra, or ineligible evidence yield no proposal.

`evaluateCapture` returns the eligible proposals in transcript order without
writing. `stageCapture(request, cwd)` stages exactly one proposal and returns its
pending ID, scope, and evidence references. The pending entry uses the existing
schema with a conversation provenance class and the source excerpt. Rejections
return a reason code, and storage failures reject the promise. Admission
suppresses same-scope body matches in pending and canonical memory after NFC and
whitespace normalization. Paraphrases and potential conflicts remain for
human review. Staging writes only to the pending queue. A reviewer can inspect,
edit, approve, or reject the entry with the existing `pending` commands.

## Offline evaluation

Run `pnpm --filter @engram/core benchmark:capture`. The evaluator runs on
messages and existing memory before reading the labels for scoring. The checked-in
adjudication maps exact reviewed bodies to gold claims. The scorer checks scope
and evidence separately. A duplicate suggestion is an emission that repeats a
mapped claim in the same session or uses evidence labeled as a duplicate of
stored memory. Unsupported assertions are remaining emissions whose claim was
never adjudicated or whose evidence is missing or misattributed.

| Corpus | Rules |  TP |  FP |  FN | Precision | Recall | Duplicate suggestions | Unsupported assertions |
| ------ | ----: | --: | --: | --: | --------: | -----: | --------------------: | ---------------------: |
| 1.0.0  |     1 |   6 |   0 |   0 |      100% |   100% |                     0 |                      0 |

These scores cover seven synthetic sessions. The rules abstain on phrasings they
do not recognize, and source attribution establishes who said something.
Reviewers still decide whether the claim belongs in canonical memory.

### Pi lifecycle evaluation

The packaged Pi lifecycle audit uses three independently labeled synthetic
sessions. The interactive eligible session contains a remember request and a
decision, with replayed lifecycle events between them. The interactive negative
session contains injected, recalled, and tool content. A JSON-mode fixture
represents the bundled Pi subagent recipe. The audit compares exact persisted
claims, source excerpts, and evidence with the fixture labels.

| Sample                          | Sessions |  TP |  FP |  FN | Precision | Recall | Duplicate suggestions | Unsupported assertions |
| ------------------------------- | -------: | --: | --: | --: | --------: | -----: | --------------------: | ---------------------: |
| Synthetic Pi lifecycle fixtures |        3 |   2 |   0 |   0 |      100% |   100% |                     0 |                      0 |
| Pi dogfood                      |        0 |   — |   — |   — |         — |      — |                     — |                      — |

No dogfood threshold or labeled Pi dogfood sessions are available. Dogfood
precision and threshold attainment remain unverified.
