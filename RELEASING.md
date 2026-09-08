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
   are configured, see below). The publish job performs a clean, uncached
   install, repeats the checks and tests, builds, then publishes with npm
   trusted publishing. No npm token exists anywhere.
6. Only after a successful publish, the workflow creates the GitHub Release
   with notes taken from the CHANGELOG section.

If validation or publishing fails, fix forward and tag the next version.
Never re-point or re-push a version tag that has been published.

If npm publishes successfully but GitHub Release creation fails, use GitHub's
**Re-run failed jobs** action. That reruns only `github-release` and does not
attempt to publish the immutable npm version again. Do not re-run all jobs.

## Required manual configuration (one-time)

### GitHub Actions workflow permissions

- In **Settings > Actions > General > Workflow permissions**, keep the default
  `GITHUB_TOKEN` permissions read-only.
- Enable **Allow GitHub Actions to create and approve pull requests**. The
  `release-prep` workflow needs this repository switch for `gh pr create` even
  though its job declares `pull-requests: write`. The workflow never approves
  its own PR, and branch protection still requires review.

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

## Setup verification (read-only)

Run these checks after the one-time setup, before trusting it for a release,
and whenever a failure suggests configuration drift. Two principles keep
them honest:

- They assert presence. Each check verifies that a documented requirement
  is present. The repository currently enforces more than the documented
  minimum (required signatures and linear history on `main`, for example,
  and admins may bypass the `npm` environment). Extra hardening is not
  drift; only a missing requirement or a wrong value is.
- Optional settings are checked as configured-or-absent. Required reviewers
  on the `npm` environment are optional. A populated reviewer list and an
  empty one are both compliant.

The `gh` calls need a session that can read repository rulesets and
environments, normally repository admin visibility; anonymous or restricted
sessions get empty lists or 404s. API references: [rulesets][1],
[environments][2], [Actions permissions][3]. Every check below is
read-only and self-contained, so any single one can be run alone during an
incident. Numeric ruleset ids are not stable; every lookup goes through the
name.

### Rulesets

1. Both rulesets exist and are active:

   ```sh
   gh api repos/tm0h/engram/rulesets --jq '.[] | {name, target, enforcement}'
   ```

   Expected exactly two lines, `main` with `"target":"branch"` and
   `release-tags` with `"target":"tag"`, both `"enforcement":"active"`.

2. The `main` ruleset requires pull requests and the `check` job. Both
   lines run in one shell:

   ```sh
   main_id="$(gh api repos/tm0h/engram/rulesets \
     --jq '.[] | select(.name == "main") | .id')"
   gh api "repos/tm0h/engram/rulesets/$main_id" --jq '.rules[].type'
   ```

   The rule list must contain at least `pull_request` and
   `required_status_checks`. The current ruleset also enforces deletion,
   non-fast-forward, linear history, signatures, and update rules; those are
   additional hardening. Then confirm the required check is the ci `check`
   job (same shell, `$main_id` from above):

   ```sh
   gh api "repos/tm0h/engram/rulesets/$main_id" --jq '.rules[]
     | select(.type == "required_status_checks")
     | .parameters.required_status_checks[].context'
   ```

   Expected exactly `check`. Anything else means the gate points at the
   wrong job, probably a renamed one.

3. The `release-tags` ruleset restricts `v*` tags:

   ```sh
   tags_id="$(gh api repos/tm0h/engram/rulesets \
     --jq '.[] | select(.name == "release-tags") | .id')"
   gh api "repos/tm0h/engram/rulesets/$tags_id" \
     --jq '{include: .conditions.ref_name.include, rules: [.rules[].type]}'
   ```

   `include` must be `["refs/tags/v*"]`, and the rules must contain
   `creation`, `deletion`, and `non_fast_forward`. The creation rule is what
   restricts who may push release tags. Add `bypass_actors` to the jq
   filter to list who may bypass the ruleset, and confirm that list still
   matches the intended release managers. Entries of type
   `RepositoryRole` carry a numeric role id; do not infer a role name from
   the number.

### The npm environment

4. The environment exists, is protected by the branch policy, and carries
   the optional reviewers:

   ```sh
   gh api repos/tm0h/engram/environments/npm \
     --jq '{protection: [.protection_rules[].type],
            custom_branch_policies: .deployment_branch_policy.custom_branch_policies,
            reviewers: [.protection_rules[]
                        | select(.type == "required_reviewers")
                        | .reviewers[].reviewer.login]}'
   ```

   `protection` must contain `branch_policy` and `custom_branch_policies`
   must be `true`. `reviewers` may list logins (every publish then waits for
   one of their approvals) or be empty; both states comply.

5. The deployment branch policy admits only release tags. The endpoint path
   is plural; the singular form returns 404:

   ```sh
   gh api repos/tm0h/engram/environments/npm/deployment-branch-policies \
     --jq '.branch_policies[] | {name, type}'
   ```

   Expected exactly `{"name":"v*","type":"tag"}`.

### Actions permissions and posture

6. The default token is read-only and workflows may open pull requests:

   ```sh
   gh api repos/tm0h/engram/actions/permissions/workflow
   ```

   Expected
   `{"default_workflow_permissions":"read","can_approve_pull_request_reviews":true}`.

7. The no-secrets posture holds. These endpoints return names and counts
   only, never values:

   ```sh
   gh api repos/tm0h/engram/actions/secrets --jq .total_count
   gh api repos/tm0h/engram/environments/npm/secrets --jq .total_count
   gh api repos/tm0h/engram/actions/variables --jq .total_count
   ```

   All three must print `0`. A non-zero count means someone added a secret
   or variable; reconcile it with this document before releasing.

8. The names the trusted-publisher binding depends on are still the real
   ones:

   ```sh
   git ls-files .github/workflows
   grep -n 'environment: npm' .github/workflows/release.yml
   ```

   `release.yml` must be listed, and the grep must find `environment: npm`
   in it. Renaming the workflow file or the environment silently breaks the
   OIDC chain; see the trusted-publisher section above.

### npm trusted publishing (indirect check)

9. Every publish from this repository goes through OIDC trusted publishing,
   so the published package carries provenance attestations:

   ```sh
   curl -sS https://registry.npmjs.org/engram-cli \
     | jq -r '."dist-tags".latest,
              (.versions[."dist-tags".latest].dist.attestations.url
               // "no attestations")'
   ```

   The first line is the latest published version. The second must be an
   attestation URL under
   `https://registry.npmjs.org/-/npm/v1/attestations/`, not
   `no attestations`. See npm's provenance documentation [4]. A missing
   attestation on a version this repository should have published means
   that publish did not go through the trusted-publisher chain; investigate
   before the next release.

### What no repository check can verify

The trusted-publisher entry itself (repository, workflow filename,
environment) lives in npmjs.com package settings and has no public API.
Inspecting it requires an npm account with admin rights on `engram-cli`.
That inspection is inherently manual. Do it whenever publishes fail with
authentication errors, following the guidance in the trusted-publisher
section above.

[1]: https://docs.github.com/en/rest/repos/rules
[2]: https://docs.github.com/en/rest/deployments/environments
[3]: https://docs.github.com/en/rest/actions/permissions
[4]: https://docs.npmjs.com/generating-provenance-statements/

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
  after the `npm` environment gate, using OIDC. The publish job uses no package
  manager cache and repeats the checks and tests against the checkout it
  builds. There are no secrets in this repository, and no GitHub Release is
  created before a successful publish.
