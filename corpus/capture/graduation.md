# Project automatic recording

Pi capture and OpenCode's `/engram-capture` use pending review by default.
Personal capture always uses pending review. Only facts, decisions, and issues
with direct user evidence from the shipped Pi TUI or root OpenCode adapter can
be recorded automatically.

## Owner controls

`engram capture status` returns the current mode, policy, evidence, and bounded
audit as JSON. A passing report moves a project to `eligible`. The local owner
runs `engram capture enable --confirm-owner` separately to move it to `active`.
Run `engram capture disable` to revoke consent before the next automatic write.
A disabled project with fresh passing evidence can appear as `eligible` in
subsequent status reports. Pending work remains available throughout.

Engram uses POSIX ownership as its local authority. The real and effective user
must match and own the checkout root, the Engram directory, and the project
configuration. Automatic writes also require control of the canonical directory
and a valid configuration with blocking project secret scanning. Symlinked or
group-writable control paths, platforms without POSIX ownership, and copied
control state fail closed. Consent is bound to the checkout path, device, inode,
and owner. Separate checkouts of a tracked project each make their own decision.
People and software running under the same operating-system account share its
authority. Git author fields and environment variables do not grant authority.

## Sampling and graduation

1. Use ordinary project sessions in both harnesses over multiple work days.
   Include different work types and benign and adversarial source material.
   Exclude rehearsed or synthetic sessions from the project evidence. The CLI
   separately reruns the bundled, labeled capture corpus.
2. Read `engram capture status` to get the rolling population, the latest 240
   unique emitted outcomes in the last 30 days. Review the original user
   turns independently, then compare them with the proposed or recorded
   memory. Inspect pending proposals with `engram pending show` before
   deleting them. Compare recorded cases via their audit `canonicalId`.
   Review all selected sessions and other real sessions in the same interval,
   including sessions with no capture, to detect missed and abstained claims.
3. Prepare a local JSON report. Use `schemaVersion: 1` and copy `project`,
   `policy`, and `through` from status. In `assessments`, include one
   `{ "id": "<sample ID>", "outcome": "accurate" }` per sample. Use
   `false_positive`, `unsupported`, `secret_escape`, `injection_escape`,
   `duplicate`, `conflict`, `schema_error`, `lifecycle_error`, or `override`
   for unsuccessful outcomes. A material edit or reviewer override counts
   against the emitted claim. With multiple defects, classify any safety
   or integrity escape ahead of a general false positive. Include all reviewed
   session digests in `reviewedSessions`. Each entry in `coverage` contains
   `id` (a unique local 64-character lowercase hex digest for the reviewed
   opportunity), `harness` (`pi` or `opencode`), `type` (`fact`,
   `decision`, or `issue`), `provenance` (`direct_user` or `other`), and
   `outcome` (`missed` or `abstained`). Use `missed` for an eligible claim
   the system omitted and `abstained` for a correctly withheld uncertain claim.
4. Submit the owner-reviewed report with `engram capture evidence < report.json`.
   Keep the sample file local and include only outcome labels and opaque IDs.
   Status reports counts and rates overall, by harness, content class, provenance, and each
   harness/class and harness/provenance combination. An incomplete or mismatched
   report is rejected. A complete failing report suspends active consent.

The minimum is 60 outcomes overall, 25 per harness, 15 per durable class, and
5 per harness/class combination. Each harness must span at least 10 distinct
sessions. At least 60 outcomes require direct user provenance. Each nonempty
segment must reach 98% precision and 90% recall. Every segment permits zero
unsupported assertions, secret or injection escapes, duplicates, unresolved
conflicts, schema or lifecycle errors, or reviewer overrides. Precision is
accurate emissions divided by all emissions. Recall is accurate emissions
divided by accurate emissions plus missed eligible claims. Correct abstentions
are reported separately. The project owner supplies ground truth and is
responsible for the representativeness of the underlying sessions.

## Continued operation

Evidence expires after 14 days and is recomputed against the surviving rolling
window before writes. Once 24 additional emissions accumulate, the next automatic
write requires a fresh review. The same assessments cannot reset a passing report's
expiry. Policy, implementation, or corpus changes invalidate old evidence.
When suspended, supply current passing evidence and opt in again.

Automatic publication rechecks host admission and provenance, effective
configuration, the evidence gate, the canonical schema and lifecycle, secret
and injection scanning, exact duplicates, likely duplicates, and conflicts.
Exact repeats are rejected. A likely duplicate, unresolved conflict, or failed
control keeps the candidate pending. Ineligible or unsafe source input is
discarded by the shared admission rules.

The owner-only `.engram/capture/state.json` is ignored by Git. It retains
up to 512 decision records plus the current evidence report. The latest 240
in-window review samples have priority over duplicate and control events
when the audit fills. An authorized
write records its intended canonical ID before the store publishes it.
After an interruption, reconciliation compares that ID and source reference
against the store and records an observed publication or interrupted attempt.
An unresolved intent prevents a new authorized write. Capture controls reclaim
a lock when they can verify that the owning process has exited in the same
local process namespace. For an unidentifiable holder or a legacy lock, stop
all Engram processes using the checkout before removing the abandoned
`.engram/capture/.holder` directory or legacy `.engram/capture/.lock`
directory. The regular `.lock` protocol marker stays in place.
Audits include the local UID, time, policy and evidence digests, redacted
provenance references, outcome, and reason. Pending proposals remain the
place to examine source excerpts. When audit storage is unavailable, the
adapter can still stage a candidate for manual review.

Regenerate the implementation fingerprint after changing the capture,
adapter, scanner, write, schema, or corpus inputs.

```sh
node --import tsx scripts/capture-fingerprint.ts > packages/core/src/capture-fingerprint.json
```
