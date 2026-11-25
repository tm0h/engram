# Review and capture memory

Use `engram review` to find superseded, archived, expired, or review-due
entries and broken lineage in the canonical store. Use `engram pending`
to inspect proposals before adding them to memory. For changes across Git
snapshots, see [review project memory changes](project-memory-diff.md).

## Local pending memory

The pending-memory store keeps proposals in `.engram/pending/` for the current
project and `~/.engram/pending/` for personal memory. Both queues install a
Git ignore rule before writing, including in projects with tracked canonical
memory. Each version-1 JSON file contains the proposed title, type, tags and
body, a source excerpt, its provenance class, the scope, duplicate and conflict
references by scope and ID, and the creation time. A reference is an advisory
hint. The queue is separate from canonical Markdown, and ordinary search and
context only read canonical memory.

The queue rejects excerpts and proposed text flagged by the secret and
prompt-injection scanner. Diagnostics give scanner rule information without
quoting matched text. Files are published atomically under unique IDs.

Pending files have no automatic expiry. Review them with the packaged CLI:

```sh
engram pending list --scope all
engram pending show <id>
engram pending edit <id> --patch '{"title":"Updated decision","tags":["capture"]}'
engram pending approve <id> --dry-run
engram pending approve <id>
engram pending reject <id>
```

Use full pending IDs. Review defaults to project scope when initialized and
personal scope otherwise. Use `--scope personal` or `--scope project` to select
the queue explicitly. `show` includes the source excerpt and the original
capture hints. `edit` changes only the supplied proposal fields (`title`,
`type`, `tags`, `body`) and accepts a JSON patch on stdin with `--stdin`.
Rejection discards the local queue file.

Approval previews the full canonical Markdown, including its ID, timestamps,
and provenance, before prompting. The timestamps come from the proposal,
`sourceType` comes from its provenance class, and `sourceRef` records its
pending ID. The source excerpt and capture hints stay in the queue. Use
`--dry-run --json` to get the exact file bytes as the `markdown` string.
Approval revalidates the proposal and checks the current canonical store
before publishing. Sensitive content and exact duplicates block approval.
Review likely duplicates and possible conflicts before retrying with
`--confirm-write`. If validation fails, edit or reject the pending candidate.
If queue cleanup fails after publication, retry approval to finish cleanup
using the existing canonical memory. The leftover queue file cannot be edited.
Use `engram edit` on the canonical memory to make changes.

Pass multiple IDs to `show`, `edit`, `approve`, or `reject` to process a
batch in one scope. A batch edit applies the same patch to each candidate.
Each ID has its own outcome, and the process exits 1 if any item fails or
requires cleanup. `--json` emits one versioned document with a `results`
array on stdout. Use `--yes` for non-interactive approval. To approve a
previously reviewed proposal, pass `--expect <revision>` from its dry run
with `--yes` and one ID. With `--yes --json`, pre-write previews go to
stderr. Use `engram review` for
the canonical lifecycle report.

After an interrupted process, remove leftover `.write-*` staging directories
or a candidate's `<id>.json.lock` directory only after all writers have stopped.
If approval also left a canonical store `.write-lock`, clear it under the same
condition before retrying.

## Project automatic recording

Pi lifecycle capture and OpenCode's `/engram-capture` stage candidates for
review by default. A local project owner can opt in to automatic recording
after reviewing a representative sample from the checkout. Personal capture
always stays in the review queue.

- `engram capture status` shows the mode, required evidence, and local audit.
- `engram capture evidence < report.json` evaluates the reviewed sample.
- `engram capture enable --confirm-owner` opts the project in after it qualifies.
- `engram capture disable` immediately revokes the opt-in.

See the [capture graduation policy](../corpus/capture/graduation.md) for the
report format, minimum samples, and automatic suspension rules.

## Duplicate and conflict advisories

Add and edit check the destination scope. An exact match has the same title
and body after trimming, Unicode NFC normalization, and line-ending
normalization. Case, punctuation, and interior whitespace still matter.
Metadata differences do not make an exact copy distinct. Exact matches
are refused even against inactive memories. Editing an existing record
excludes that record from comparison, and ordinary metadata-only updates
can still proceed.

Likely duplicates use overlapping title, body, and tag terms. Possible
conflicts use matching subjects and differing preference or decision text.
These advisories consider active entries and exclude an explicitly
superseded predecessor. Each advisory names the existing `scope:id`.
The CLI exits 1 without saving. Review the entries, then retry with
`--confirm-write` if the write is intentional. Pi and OpenCode tools take
`confirmWrite: true`. Confirmation cannot override exact duplicates or
the secret scan. A confirmed write preserves the other entries unless
you explicitly specify a lifecycle change such as `--supersedes`.

See [write scanning](diagnostics.md#secret-and-prompt-injection-scanning) for per-scope policies and diagnostic codes.
