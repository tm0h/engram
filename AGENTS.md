# Repository Guidelines

Engram is a git-native memory tool for AI agents. It stores personal or project knowledge as Markdown with YAML frontmatter. This repository is a pnpm workspace and requires Node.js 20 or newer.

## Project Structure and Module Organization

- `packages/core/` contains the Effect-based engine: storage, lifecycle and integrity checks, secret scanning, BM25 search, structured output, and retrieval benchmarks.
- `packages/cli/` contains the published `engram-cli` command surface. Commands live in `src/commands/`; Pi and OpenCode bundle entry points live beside `src/index.ts`.
- `packages/harnesses/` contains shared serializable operations, the host-neutral installer, and Pi, OpenCode, and Claude Code integrations. Keep the Pi and Claude `SKILL.md` guidance synchronized. Update both skills and their guidance tests when adding user-facing CLI features.
- Tests are colocated under each package's `test/` directory. `corpus/` holds synthetic retrieval fixtures and labeled cases. Follow `corpus/README.md` when changing them.

## Build, Test, and Development Commands

```bash
pnpm install                              # install the pinned workspace
pnpm dev                                  # run the CLI from source
pnpm check                                # format, lint, and typecheck
TMPDIR=/var/tmp pnpm test                 # run all Vitest suites in isolation
pnpm exec vp test run packages/core/test/search.test.ts
pnpm --filter @engram/core benchmark      # evaluate the retrieval corpus
pnpm --filter engram-cli build            # canonical CLI build
pnpm test:e2e:docker                       # isolated release and CLI audit
```

Use `pnpm exec vp check --fix` for safe formatter and lint fixes. Review its diff because automated rewrites can alter code-point counting.

## Coding Style and Naming Conventions

Write strict TypeScript ESM with two-space indentation. Let Vite Plus format and lint. Use `camelCase` for values and functions, `PascalCase` for types and services, and `*.test.ts` for tests. Core logic uses `Effect.gen`, `Result`, `Context.Service`, and `Layer`; avoid raw `async`/`await` there. Reference cataloged dependencies with `catalog:`.

## Testing Guidelines

Use TDD: add a failing test, then implement. Test services with real `NodeServices` and isolated temporary directories. Keep pure logic deterministic. Core behavior needs regression coverage. Retrieval changes must preserve the checked-in benchmark gate; never edit corpus labels to make a ranker pass.

Run `pnpm test:e2e:docker` before a release and after changes to CLI commands, packaging, harness integration, or the container audit. It accepts only a clean committed snapshot. The runner builds that snapshot, then tests the packaged CLI without network access or host-directory mounts. CI runs this audit after the faster `check` job passes.

## Commit and Pull Request Guidelines

Branch before editing and never commit directly to `main`. Use Conventional Commits such as `feat(core):`, `fix(cli):`, and `docs:`. PRs need a concise public description, linked issue when applicable, and exact verification commands. CI requires `pnpm check`, `pnpm test`, the canonical CLI build, and the Docker E2E audit. Follow `RELEASING.md` for releases. Never commit credentials or real personal engrams.
