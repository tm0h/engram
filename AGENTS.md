# AGENTS.md

Working notes for AI coding agents (and humans) contributing to this repo.

## What this is

**engram** — a git-native memory tool for AI agents. Engrams are plain Markdown
files (YAML frontmatter + body). Project scope lives in `<repo>/.engram/`
(committed, shared with the team); personal scope lives in `~/.engram/` (never
committed).

pnpm workspace, two packages:

| Path            | npm name       | Published    | Role                                                                                    |
| --------------- | -------------- | ------------ | --------------------------------------------------------------------------------------- |
| `packages/core` | `@engram/core` | no (private) | Engine: store, config, location, frontmatter, search, formatting. Bundled into the CLI. |
| `packages/cli`  | `engram-cli`   | yes          | The `engram` CLI (commander dispatch, commands in `src/commands/`).                     |

## Commands

```bash
pnpm install                 # Node >= 20; pnpm via corepack (see packageManager)

pnpm check                   # fmt + lint + typecheck (vite-plus); must be green
pnpm exec vp check --fix     # auto-fix formatting (may reorder package.json keys — expected)

pnpm test                    # all tests (vitest via vite-plus)
pnpm exec vp test run packages/core/test/location.test.ts   # single file

pnpm typecheck               # recursive tsc --noEmit
```

**Build the CLI — always this exact form:**

```bash
pnpm --filter engram-cli build
```

**Publish — always this exact form (requires `npm login` + OTP):**

```bash
pnpm --filter engram-cli publish
```

`prepublishOnly` copies the root `README.md` into `packages/cli/` (gitignored;
delete the stray copy after a failed publish if you want a clean tree).

## Release process

1. Bump the version in **two places**: `packages/cli/package.json` and the
   hardcoded `.version()` in `packages/cli/src/index.ts`.
2. Add a `CHANGELOG.md` entry (Keep a Changelog format; link the PR).
3. Open a PR — `main` is protected; **everything** lands via PR.
4. After merge: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`.
5. Build and publish with the exact `--filter engram-cli` commands above.

Version policy: `@engram/core` is private and stays at the CLI's cadence; only
`engram-cli` is semver-visible. Check what's already published with
`npm pack engram-cli@<version>` before deciding a bump level — changes may
already be in the published tarball.

## Conventions

- **TDD**: write the failing test first (`packages/*/test/`), then implement.
  Core behavior stays fully covered; services are tested against real
  `NodeServices` on temp dirs (`mkdtempSync`), pure logic gets direct unit tests.
- **Conventional commits** (`fix(core):`, `feat(cli):`, `docs:`, `chore(release):`).
- **Effect 4.0 RC** style: `Effect.gen` + `Result`, services via
  `Context.Service`/`Layer`, commands run through `Effect.runPromiseExit` in
  `packages/cli/src/index.ts` with uniform error formatting. No raw async/await
  in core logic.
- **Bundle discipline**: the CLI ships as a single `dist/index.js`
  (~190 kB). Dependencies are vetted for bundle size — gray-matter was
  deliberately replaced by a ~60-line js-yaml frontmatter module
  (`packages/core/src/frontmatter.ts`, JSON_SCHEMA both ways: no YAML 1.1
  boolean/octal coercion).
- **Location invariants** (regression-guarded in
  `packages/core/test/location.test.ts`): project-root discovery stops at the
  nearest `.git` boundary and never treats the global `~/.engram` as a project
  root. Don't weaken these.
- Dependencies declared in the pnpm catalog (`pnpm-workspace.yaml` — the
  Effect-family and tooling) must be referenced as `catalog:`; dependencies
  not in the catalog (e.g. `chalk`, `commander`, `js-yaml`) keep inline
  version ranges.

## Map of the code

- `packages/core/src/`
  - `store.ts` — `EngramStore`: CRUD over `<id>-<slug>.md` files (ULID-style
    ids: unique across machines, sortable by creation time; legacy 4-digit
    numeric ids still supported; `dedupe` repairs legacy/hand-written
    duplicate ids)
  - `config.ts` — `ConfigRepo`: global + project JSON configs (Schema-validated)
  - `location.ts` — `findProjectRoot` / `findGitRoot` (git-boundary rules)
  - `paths.ts` — pure path math (`~/.engram` vs `<repo>/.engram`), no I/O
  - `frontmatter.ts`, `search.ts`, `format.ts`, `scope.ts`, `templates.ts`
  - `layer.ts` — `MainLive` composition root
- `packages/cli/src/`
  - `index.ts` — commander dispatch + error rendering
  - `commands/` — one file per subcommand (`init`, `add`, `list`, `show`,
    `edit`, `remove`, `search`, `context`, `config`, `inject`, `where`,
    `dedupe`)
  - `interactive.ts`, `io.ts` — TTY prompts, output helpers
