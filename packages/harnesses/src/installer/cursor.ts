/**
 * ENG-37 `cursor` install target (SPEC decision 3): one wholly-owned `file`
 * asset at `.cursor/rules/engram.mdc` holding cursor frontmatter
 * (`description` + `alwaysApply: true`, verified against
 * https://cursor.com/docs/context/rules) and the shared CLI-variant
 * guidance template body. All applicable project rules merge, so user
 * `.mdc` files in `.cursor/rules/` are never touched.
 *
 * Marker strategy: the markers wrap the entire file (begin marker on line
 * 0, frontmatter inside the block). ENG-34 classifies a markered wholly
 * owned file as `current` only when nothing sits outside the block, and a
 * markerless file would make template drift permanently unrepairable
 * (blocked without force), which the SPEC forbids. Re-running install
 * repairs hand edits inside the block; a pre-existing `engram.mdc` without
 * our markers is foreign and is refused, never clobbered.
 */
import type { AssetSpec, InstallSpec } from "../shared/installer.js";
import { ENGRAM_GUIDANCE_TEMPLATE } from "./guidance-template.js";

export const CURSOR_TARGET = "cursor" as const;

/** Managed rules file, relative to the project root. */
export const CURSOR_RULES_PATH = ".cursor/rules/engram.mdc";

/** Stable, unversioned asset id; also embedded in both markers. */
export const CURSOR_ASSET_ID = "engram-cursor-rules";

/** HTML-comment markers, single-line, invisible when the rule renders. */
export const CURSOR_BEGIN_MARKER = "<!-- BEGIN: engram-cursor-rules -->";
export const CURSOR_END_MARKER = "<!-- END: engram-cursor-rules -->";

const frontmatter = (): string =>
  [
    "---",
    "description: Engram recorded project memory for this repository (how to read, search, and record it).",
    "alwaysApply: true",
    "---",
  ].join("\n");

export const cursorSpec = (): InstallSpec => {
  const asset: AssetSpec = {
    kind: "file",
    id: CURSOR_ASSET_ID,
    path: CURSOR_RULES_PATH,
    content: `${frontmatter()}\n\n${ENGRAM_GUIDANCE_TEMPLATE}\n`,
    markers: { begin: CURSOR_BEGIN_MARKER, end: CURSOR_END_MARKER },
  };
  return { assets: [asset] };
};

/** Project targets install into the project directory itself. */
export const cursorRoot = (projectRoot: string): string => projectRoot.replace(/\/+$/, "");
