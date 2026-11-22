# Review repository-backed memories

Record an exact reviewed Git commit and a repository-relative file path when
adding or editing a project memory derived from a file.

```bash
engram add --title "Release command" --source-type file \
  --source-ref "git:$(git rev-parse HEAD):.github/workflows/release.yml" \
  "Run pnpm release:quartz."
engram evidence <memory-id>
```

`engram evidence` compares the recorded file at the reviewed commit with the
current working tree. A changed file calls for human review of the claim.
Results can be `changed`, `unchanged`, or `unavailable`. Existing unversioned
references retain their original format and report a missing reviewed revision.
The command accepts only project-local regular UTF-8 files up to 64 KiB.
It scans each full file for sensitive content before showing bounded excerpts.
For files with Git line-ending conversion, LF blobs can match CRLF checkouts.
Use `--json` for a versioned report.

Commit the changed source file before staging a correction. The source text
must agree with the current commit so the new memory can point to an immutable
reviewed revision. Staging preserves the title, type, and tags as editable
pending fields.

```bash
engram evidence <memory-id> --propose "Run pnpm publish:quartz."
engram pending approve <pending-id> --dry-run
engram pending approve <pending-id>
```

Approval uses the pending queue's canonical validation, secret scanning, and
write advisories. It publishes the replacement with a `supersedes` reference
and marks the original superseded. A change to the original after staging
requires a new correction. Use `engram pending reject <pending-id>` to discard
the proposal and keep the original. Repository corrections require explicit
approval even when automatic capture is enabled.
