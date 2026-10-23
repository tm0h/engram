/**
 * ENG-37 `claude` install target (SPEC decision 4, amended): scaffold the
 * project skill at `.claude/skills/engram/` as two wholly-owned markered
 * `file` assets over the ENG-34 core:
 *
 * - `SKILL.md` (id `engram-claude-skill`): the curated scaffold variant of
 *   `packages/harnesses/claude/skills/engram/SKILL.md` (decision 6, kept
 *   in-repo beside it). Its YAML frontmatter is the declared header (the
 *   guaranteed-parsed first lines); HTML-comment markers wrap the body.
 * - `bin/engram` (id `engram-claude-launcher`): the existing plugin
 *   launcher shipped as-is, release-time version pin included. The
 *   `#!/bin/sh` shebang is the declared header (always line 1);
 *   shell-comment markers wrap the body. It is invoked through an
 *   interpreter as `sh ${CLAUDE_SKILL_DIR}/bin/engram <args>`, so no
 *   exec-bit support exists or is needed.
 *
 * Markered ownership means release updates classify as drift and repair
 * through a plain previewed re-run instead of force-only overwrites.
 * Source of truth per decision 6: the assets are read from their in-repo
 * locations at spec-build time; the packaged CLI reads the prepack copies
 * (packages/cli `claude-scaffold/` payload, decision 7). No version is
 * hard-coded here: the pin lives only in the launcher source file.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetSpec, InstallSpec } from "../shared/installer.js";

export const CLAUDE_TARGET = "claude" as const;

/** Scaffolded files, relative to the project root. */
export const CLAUDE_SKILL_PATH = ".claude/skills/engram/SKILL.md";
export const CLAUDE_LAUNCHER_PATH = ".claude/skills/engram/bin/engram";

/** Stable, unversioned asset ids; also embedded in the markers. */
export const CLAUDE_SKILL_ASSET_ID = "engram-claude-skill";
export const CLAUDE_LAUNCHER_ASSET_ID = "engram-claude-launcher";

/** HTML-comment markers around the SKILL.md body. */
export const CLAUDE_SKILL_BEGIN_MARKER = "<!-- BEGIN: engram-claude-skill -->";
export const CLAUDE_SKILL_END_MARKER = "<!-- END: engram-claude-skill -->";

/** Shell-comment markers around the launcher body. */
export const CLAUDE_LAUNCHER_BEGIN_MARKER = "# BEGIN: engram-claude-launcher";
export const CLAUDE_LAUNCHER_END_MARKER = "# END: engram-claude-launcher";

/**
 * Scaffold-root layouts, checked in order while walking up from this
 * module: the repo checkout (`<pkg>/claude/...`) and the packaged CLI
 * payload (`<pkg>/claude-scaffold/...`, written by the prepack copy).
 */
const SCAFFOLD_DIRS = ["claude", "claude-scaffold"] as const;
const SCAFFOLD_SKILL_RELPATH = "skills/engram-scaffold/SKILL.md";
const SCAFFOLD_LAUNCHER_RELPATH = "bin/engram";

interface ScaffoldAssets {
  readonly skillSource: string;
  readonly launcherSource: string;
}

const looksLikeScaffoldRoot = (root: string, dir: string): boolean =>
  existsSync(join(root, dir, SCAFFOLD_LAUNCHER_RELPATH)) &&
  existsSync(join(root, dir, SCAFFOLD_SKILL_RELPATH));

const findScaffoldAssets = (): ScaffoldAssets => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    for (const sub of SCAFFOLD_DIRS) {
      if (looksLikeScaffoldRoot(dir, sub)) {
        return {
          skillSource: readFileSync(join(dir, sub, SCAFFOLD_SKILL_RELPATH), "utf8"),
          launcherSource: readFileSync(join(dir, sub, SCAFFOLD_LAUNCHER_RELPATH), "utf8"),
        };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "claude scaffold assets not found: expected the scaffold SKILL.md and the " +
      "launcher beside the engram installation (packaging bug)",
  );
};

/** Split the scaffold SKILL.md into its frontmatter block and body. */
const splitSkill = (source: string): { header: string; body: string } => {
  const m = /^---\n[\s\S]*?\n---\n/.exec(source);
  if (m === null) {
    throw new Error("claude scaffold SKILL.md is missing its YAML frontmatter");
  }
  return { header: m[0].replace(/\n$/, ""), body: source.slice(m[0].length) };
};

/** Split the launcher into its shebang line and the rest of the script. */
const splitLauncher = (source: string): { shebang: string; body: string } => {
  const nl = source.indexOf("\n");
  const shebang = nl === -1 ? source : source.slice(0, nl);
  if (!shebang.startsWith("#!")) {
    throw new Error("claude launcher is missing its #! shebang line");
  }
  return { shebang, body: nl === -1 ? "" : source.slice(nl + 1) };
};

export const claudeSpec = (): InstallSpec => {
  const { skillSource, launcherSource } = findScaffoldAssets();
  const { header, body } = splitSkill(skillSource);
  const { shebang, body: launcherBody } = splitLauncher(launcherSource);

  const skill: AssetSpec = {
    kind: "file",
    id: CLAUDE_SKILL_ASSET_ID,
    path: CLAUDE_SKILL_PATH,
    content: body,
    markers: { begin: CLAUDE_SKILL_BEGIN_MARKER, end: CLAUDE_SKILL_END_MARKER },
    header,
  };
  const launcher: AssetSpec = {
    kind: "file",
    id: CLAUDE_LAUNCHER_ASSET_ID,
    path: CLAUDE_LAUNCHER_PATH,
    content: launcherBody,
    markers: { begin: CLAUDE_LAUNCHER_BEGIN_MARKER, end: CLAUDE_LAUNCHER_END_MARKER },
    header: shebang,
  };
  return { assets: [skill, launcher] };
};

/** Project targets install into the project directory itself. */
export const claudeRoot = (projectRoot: string): string => projectRoot.replace(/\/+$/, "");
