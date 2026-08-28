# Releasing

How a version of `engram-cli` gets published, and the one-time GitHub and npm
settings that make it safe. Those settings cannot be expressed in the
repository, so this document records them; treat any drift from this list as
a defect.

## The flow

1. Dispatch the `release-prep` workflow with the target version (`X.Y.Z`).
   It opens a PR that bumps the five synchronized version locations, the two
   Pi README pins, and rotates the CHANGELOG. Merging the PR never publishes.
2. Merge the PR to `main` after review.
3. Tag the merged main commit and push the tag:
   `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`.
4. The `release` workflow validates the tag (strict `vX.Y.Z` shape, target
   commit, ancestry on `origin/main`, all version locations, CHANGELOG
   heading, `pnpm check`, tests on `/var/tmp`, CLI build) and fails closed.
5. The `npm` environment gate: approve the deployment (if required reviewers
   are configured, see below). The workflow then publishes with npm trusted
   publishing. No npm token exists anywhere.
6. Only after a successful publish, the workflow creates the GitHub Release
   with notes taken from the CHANGELOG section.

If validation or publishing fails, fix forward and tag the next version.
Never re-point or re-push a version tag that has been published.

## Required manual configuration (one-time)

### Branch protection for `main`

- Require pull requests before merging.
- Require the `check` job of the `ci` workflow as a required status check.

### Tag ruleset for `v*`

- Restrict tag creation to maintainers (release managers).
- Block deletions and force-pushes. This protects the publish trigger: the
  release workflow runs only on `v*` tag pushes.

### GitHub environment `npm`

- Create an environment named exactly `npm`.
- No secrets in it; publishing uses OIDC trusted publishing.
- Restrict deployments to tags matching `v*`.
- Optionally add required reviewers; that is the manual approval gate before
  every publish.

### npm trusted publisher for `engram-cli`

On npmjs.com, configure the trusted publisher for `engram-cli` as:

- Repository: `tm0h/engram`
- Workflow filename: `release.yml` (frozen)
- Environment: `npm` (frozen)
- Allowed action: `npm publish`

Renaming the workflow file or the environment silently breaks the OIDC chain.
If publishing fails with authentication errors, check this entry first. A
token-based fallback (`npm publish` from `packages/cli` with an `NPM_TOKEN`
secret) is deliberately not configured; adding one would weaken the model.

## Action pinning policy

Every GitHub Action is pinned to a full 40-character commit SHA, never to a
moving tag. To upgrade an action: resolve the target tag to its commit (peel
annotated tags), review the upstream diff, update the SHA and the version
comment in the workflows, and add a row here with the verification date.

| Action             | Version | SHA                                        | Verified   |
| ------------------ | ------- | ------------------------------------------ | ---------- |
| actions/checkout   | v7.0.1  | `3d3c42e5aac5ba805825da76410c181273ba90b1` | 2026-08-28 |
| pnpm/action-setup  | v6.0.10 | `0977fd99725f1db4007ccb2928dbb4e90d06cc86` | 2026-08-28 |
| actions/setup-node | v7.0.0  | `820762786026740c76f36085b0efc47a31fe5020` | 2026-08-28 |

## Security posture

- CI (`ci`) runs on pull requests and main with `contents: read` and no
  secrets; fork PRs run unprivileged.
- `release-prep` holds `contents: write` + `pull-requests: write` because it
  must push its generated branch and open its PR. It is `workflow_dispatch`
  only, checks out `main`, never tags, releases, or publishes, and the `v*`
  tag ruleset plus main protection bound the blast radius.
- `release` publishes only from a validated `v*` tag of `main` ancestry,
  after the `npm` environment gate, using OIDC. There are no secrets in this
  repository, and no GitHub Release is created before a successful publish.
