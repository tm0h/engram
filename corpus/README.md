# ENG-11 Golden Retrieval Corpus

A versioned, deterministic corpus of labeled coding-memory retrieval cases.
This document is the contract. Consumers (the ENG-8 benchmark runner, the
ENG-21 harness integration) build against it; the words here are normative
and the validator in `packages/core/src/corpus.ts` is their executable
form. You can understand and author corpus content without reading code.

Everything in this directory is **synthetic**. The fixture project
("mothlight", a fictional static-site generator) does not exist. No real
personal engrams, credentials, or private data may ever be committed here.

## Layout

```
corpus/
  manifest.json        corpus-level versioning and defaults
  engrams/*.md         fixture engrams (engram file format, Markdown + YAML frontmatter)
  cases/*.json         labeled retrieval cases (JSON)
```

## Manifest (`manifest.json`)

| Field           | Type   | Required  | Meaning                                                                                                                                                                                                                                                                              |
| --------------- | ------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion` | int    | yes       | Case-schema version. Only `1` is understood; bump on a breaking change to the case schema or these rules.                                                                                                                                                                            |
| `corpusVersion` | string | yes       | Semver of the corpus **data** (fixtures plus cases). Bump the minor for additive cases, the major for semantics changes.                                                                                                                                                             |
| `name`          | string | yes       | Corpus name.                                                                                                                                                                                                                                                                         |
| `description`   | string | yes       | What the corpus covers.                                                                                                                                                                                                                                                              |
| `defaultNow`    | string | see below | Fixed evaluation timestamp (ISO 8601 with explicit zone) used by any case without its own `now`. Optional in the schema, but it becomes **mandatory in practice** the moment any case lacks `now`: the loader reports an issue if a case has neither. Shipped corpora always set it. |

## Engram fixtures (`engrams/*.md`)

Fixtures use the standard engram file format and must pass the same
validation a store scan applies (`validateEntry` plus cross-file checks).

- Required frontmatter: `id`, `title`, `type`, `tags`, `scope`, `created`,
  `updated`. `type` is one of `decision`, `fact`, `preference`, `note`,
  `issue`, `context`. `scope` is `project` or `personal`. Optional
  lifecycle fields (`status`, `supersedes`, `expires`, `reviewAfter`,
  `sourceType`, `sourceRef`, `author`, `pinned`) follow the store rules.
- `created`/`updated` are fixed ISO 8601 timestamps with explicit zone
  (`2026-01-01T00:00:00.000Z` form). Never relative, never date-only.
- **Ids**: 26 lowercase Crockford base32 characters, charset
  `0-9` and `a-z` minus `i`, `l`, `o`, `u` (26 characters, e.g.
  `01jwpz07000000000000000000`), or a legacy 4-digit id (`0001`). Ids are
  hand-written, stable, and never collide with each other.
- **Filenames** must be `<id>-<slug>.md` where the slug is the title
  lowercased, non-alphanumerics collapsed to `-`, trimmed (the
  `slugify(title)` rule). The loader rejects filename/id/slug mismatches.
- Ids must be unique across the directory; `supersedes` must point at an
  id that exists in the corpus; at most one fixture may claim an id.
- Content is fictional but realistic coding-memory prose. Tags are lowercase.

## Case schema (`cases/*.json`)

| Field             | Type             | Required | Meaning                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | string           | yes      | Stable unique id, `case-<category>-<nn>` with a per-category two-digit counter (e.g. `case-superseded-01`). The category segment must equal `category`.                                                                                                                                                                                  |
| `query`           | string           | yes      | The exact query string handed to the search function.                                                                                                                                                                                                                                                                                    |
| `category`        | string           | yes      | One of the 10 coverage categories below.                                                                                                                                                                                                                                                                                                 |
| `requiredIds`     | array of strings | yes      | Fixture engram ids that **must** appear in the results. Empty exactly when `expectEmpty` is true.                                                                                                                                                                                                                                        |
| `supportingIds`   | array of strings | yes      | Acceptable additional ids; not asserted, documents tolerated noise. Must be empty when `expectEmpty` is true.                                                                                                                                                                                                                            |
| `forbiddenIds`    | array of strings | yes      | Stale or contradictory fixture ids that must **not** appear.                                                                                                                                                                                                                                                                             |
| `scope`           | string           | yes      | `project` or `personal`. Evaluation filters fixtures to this scope, and every referenced id must live in the same scope.                                                                                                                                                                                                                 |
| `applicablePaths` | array of strings | yes      | Subsystem path prefixes the query applies to. Grammar: lowercase slash-delimited, segments `[a-z0-9][a-z0-9-]*`, no leading/trailing slash, no empty segments (e.g. `core/parser`, `cli/commands`). Shape only; the vocabulary is open.                                                                                                  |
| `expectEmpty`     | boolean          | yes      | True only for abstention cases; requires empty `requiredIds`, empty `supportingIds`, and zero results.                                                                                                                                                                                                                                   |
| `notes`           | string           | yes      | Pass/fail rationale: why these expectations hold.                                                                                                                                                                                                                                                                                        |
| `now`             | string           | no       | Fixed evaluation timestamp (temporal cases). ISO 8601 with explicit zone.                                                                                                                                                                                                                                                                |
| `limit`           | number           | no       | Fixed result limit (positive integer) for ranking-sensitive cases. Default: no limit.                                                                                                                                                                                                                                                    |
| `includeInactive` | boolean          | no       | Re-include inactive fixtures (explicit `superseded`/`archived` status, or `expires` at or before the evaluation time). Default: `false`.                                                                                                                                                                                                 |
| `duplicateOf`     | string           | no       | The id of the case this one duplicates. Allowed **only** on `ambiguity` cases, pointing at another ambiguity case with the identical query, which must not itself use `duplicateOf`. This is the only way two cases may share a query; every duplicate-query group must have exactly one canonical case (the one without `duplicateOf`). |

The three id lists must be pairwise disjoint, and no id may repeat within
one list. Unknown fields are rejected: a typo in a case file must fail
validation, not pass silently.

## Coverage categories

Every corpus must contain at least one case per category. Each section
states what it measures, what a pass means, and the expected visibility
mode (`includeInactive`).

1. **exact-facts** - a specific stated fact ("which port..."). Pass: the
   fact surfaces. Default visibility; no `includeInactive`.
2. **paraphrase** - query wording differs from the entry wording, with
   the overlap carried by body text. Pass: the paraphrased entry surfaces.
   Default visibility. Hard paraphrases (synonym-only or
   related-vocabulary bridges the current ranker cannot see) are
   welcome: the bridge must be one a plausible improved ranker could
   exploit, and the case must not be unpassable by construction.
3. **code-identifiers** - query names a code identifier (function, type,
   config key, file) in a realistic raw form a developer would type,
   including its natural casing, dots, parens, or path-like segments.
   Labels come from the memory's content, not from token mechanics. Pass:
   the identifier's memory surfaces. Default visibility.
4. **multi-token** - query tokens spread across tags, title, and body; no
   single field contains the whole query. Pass: the entry combining all
   tokens surfaces. Default visibility.
5. **subsystem-paths** - query about one subsystem; sibling notes in the
   same subsystem share no query tokens. Pass: the right subsystem entry
   surfaces, the sibling stays out. Default visibility.
6. **superseded** - a superseded decision competes with its replacement.
   Two visibility modes are pinned and the seed set must contain at least
   one case of each:
   - _under exclusion_ (default): the superseded fixture is
     lifecycle-filtered before scoring; the current decision surfaces and
     the superseded id is forbidden.
   - _under inclusion_ (`includeInactive: true`): the superseded fixture
     is back in the candidate set; the label still asserts the retired
     id is not the answer to the current-state question.
7. **temporal** - time-derived state (an expired fact, an "as of" audit).
   Cases carry a fixed `now` (or rely on `defaultNow`). Pass is evaluated
   at that instant and never at wall-clock time. Both visibility modes
   appear across the category: an audit case may set
   `includeInactive: true` to retrieve an expired entry on purpose.
8. **ambiguity** - a short query with two senses. Two cases share the
   identical query via `duplicateOf`, each requiring one sense and
   tolerating the other as support. Default visibility.
9. **distractors** - near-miss entries share some query tokens. Pass:
   required ids outrank distractors (any `limit` pins the cut), tolerated
   noise is listed in `supportingIds`, and stale contradictory entries are
   `forbiddenIds`. Default visibility.
10. **abstention** - the corpus contains no memory that answers the
    query. `expectEmpty: true`, empty `requiredIds` and
    `supportingIds`. Pass: zero results. Near-match abstention cases are
    welcome: when fixtures share vocabulary with the query, the notes
    explain why those candidates do not answer the user's need.

## Authoring guidance (label justification)

Labels are ground truth about memory meaning and the user's information
need, not statements about any ranker. Every `notes` field must justify
its labels from what the referenced memories say and what the user is
asking for, citing fixture content. A label must be valid under any
ranker; never restate ranker behavior (scores, token matches, tokenizer
rules) as justification. Queries are written as a realistic developer
would type them: raw casing, punctuation, accents, and all. No case may
be unpassable by construction: whenever a query has a plausible answer
in the corpus, at least one referenced memory must be reachable by a
plausible ranker that understands meaning (synonyms, related
vocabulary, unicode normalization, or better matching).

## Snapshot identity

The corpus snapshot hash is the sha256 over, in code-unit lexicographic
path order, `manifest.json`, every `cases/*.json`, and every
`engrams/*.md`, each fed to the hash as `<relpath>\n<byte length>\n<bytes>`
(relative to the corpus directory, UTF-8 bytes). The validation suite
recomputes the hash, asserts the recomputation matches the recorded
value, and logs `[corpus] snapshot sha256: ...` so a runner can
recompute it over the same tree state. Until the lane commits, corpus
identity is the base `git rev-parse HEAD` plus this snapshot hash; the
local commit SHA supplements it after acceptance.

## Determinism rules

- No clock reads, no randomness, no network, no environment access
  anywhere in evaluation. `Date.now()` is forbidden in the evaluation
  path; every evaluation instant comes from `case.now` or
  `manifest.defaultNow`.
- Stable file ordering (lexicographic), UTF-8, LF line endings.
- Fixture ids never collide; case ids never collide.
- Loading the corpus twice yields deep-equal output.

## Evaluation procedure

The runner invocation is pinned. For each case:

1. Filter the corpus engrams to `case.scope`.
2. Call the search function exactly once:

```
searchEngrams(
  scoped,
  case.query,
  case.limit,                 // default: no limit
  {
    includeInactive: case.includeInactive,  // default: false
    now: epochMs(case.now || manifest.defaultNow),
  },
)
```

3. A case **passes** when: every `requiredIds` id appears in the result
   ids; no `forbiddenIds` id appears; abstention cases return zero
   results. `supportingIds` carries no assertion.

`evaluateCase(engrams, case, defaultNowMs)` in
`packages/core/src/corpus.ts` is the executable form of steps 1-2; runners
should call it rather than reimplement the procedure. It refuses to read
the wall clock: a case with no fixed timestamp is a corpus defect.

## Per-category quotas

Advisory at seed scale (turn 1). **Binding from turn 2**: the corpus is
not complete below these counts.

| Category         | Quota   |
| ---------------- | ------- |
| exact-facts      | 25      |
| paraphrase       | 20      |
| code-identifiers | 20      |
| multi-token      | 20      |
| subsystem-paths  | 15      |
| superseded       | 15      |
| temporal         | 15      |
| ambiguity        | 10      |
| distractors      | 10      |
| abstention       | 10      |
| **Total**        | **160** |

## Versioning and change rules

- `schemaVersion` bumps (with a loader update) when the case schema or
  these rules change incompatibly. Loaders reject manifests whose
  `schemaVersion` differs from the supported version.
- `corpusVersion` bumps whenever fixtures or cases change: major for
  semantic changes (expectations flip, categories redefined), minor for
  additive cases/fixtures, patch for prose-only fixture edits.
- Adding a category, renaming a field, or changing evaluation semantics
  is a breaking change: it requires a `schemaVersion` bump and a note in
  the PR description so downstream runners re-validate.
- Relevance labels change only as ordinary reviewed data changes
  (`corpusVersion` bump, handoff, review), never to fit a scorer;
  ranker pass/miss is reported by the benchmark, not encoded in the
  corpus. Version 0.3.0 removed the implementation-specific authoring
  restrictions from earlier versions (tokenizer-shaped identifier
  queries, score-zero crafting guidance, and the blanket abstention
  token-absence rule); no field changed and `schemaVersion` stays 1.

## Consuming the loader

Import through the subpath export, never the barrel:

```ts
import { evaluateCase, loadCorpus } from "@engram/core/corpus";

const corpus = loadCorpus("/path/to/corpus");
if (corpus.issues.length > 0) {
  /* refuse to evaluate */
}
```

`loadCorpus` never throws on content defects; it returns every problem in
`issues`. A corpus with issues is not evaluable.

## Validating the corpus

```sh
pnpm exec vp test run packages/core/test/corpus.test.ts
```

The suite validates every fixture and case, asserts id resolution, scope
agreement, category coverage, abstention invariants, both superseded
visibility modes, determinism (two loads deep-equal), and runs every seed
case through the pinned evaluation. It prints seed and per-category
counts.
