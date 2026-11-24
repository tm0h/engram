# Authoring Engram skills

Keep the skill name and discovery metadata stable. Describe what the skill
does and when it applies. Aim for about 120 lines or fewer in the Pi and
Claude entrypoints. Keep the host's context, search, show, and recording
commands there, along with scope, how to treat recalled text, secret
handling, and approval rules.

Put task-specific procedures in `references/`. Link to each file from
`SKILL.md` and describe when to read it. Resolve the link from the installed
skill directory even when the working directory is a project elsewhere.
Keep links one level deep. Use CLI help and the README for exhaustive flags
and ranking internals.

For example, a routine auth recall uses the entrypoint's search and show
commands. A request to find an archived auth decision with an explicit
field filter should open `references/search.md` for the filter syntax and
historical-entry options. Add related search guidance to that file. Add a
new file only when it serves a distinct task, and link it from the
entrypoint. Keep examples specific to each host's actual tools.

Pi ships its skill tree in the npm tarball. The Claude marketplace plugin
ships its own skill tree. The project scaffold ships through CLI prepack
and installs each reference as a managed asset. Keep the two Claude
reference sets synchronized and register new scaffold reference topics in
`packages/harnesses/src/installer/claude.ts`. Use guidance tests to check
routing and `pnpm test:e2e:docker` from a clean commit to check all three
shipments offline, including scaffold preview, upgrade, and uninstall.

OpenClaw and Hermes fit in self-contained skills. Keep OpenClaw scoped to
the selected project checkout. Keep Hermes commands and project data in the
user's local shell outside Hermes and its inference path.
