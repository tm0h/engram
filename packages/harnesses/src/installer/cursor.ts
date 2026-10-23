/**
 * ENG-37 `cursor` install target (SPEC decision 3, amended 2026-10-23):
 * one wholly-owned `file` asset at `.cursor/rules/engram.mdc`. The
 * documented, guaranteed-parsed cursor frontmatter (`description` +
 * `alwaysApply: true`, https://cursor.com/docs/context/rules) is the
 * file's declared header; the ENG-34 core's optional `header` support
 * (SPEC decision-3 exception) pins those exact lines above the managed
 * block, whose body is the shared CLI-variant guidance template. All
 * applicable project rules merge, so user `.mdc` files in
 * `.cursor/rules/` are never touched.
 *
 * Ownership shape: hand edits inside the block AND in the frontmatter are
 * drift; re-running install repairs both by rewriting header + block. A
 * pre-existing `engram.mdc` without our markers is foreign and refused,
 * never clobbered. Uninstall removes exactly header + block.
 */
import type { AssetSpec, InstallSpec } from "../shared/installer.js";
import { ENGRAM_GUIDANCE_TEMPLATE } from "./guidance-template.js";

export const CURSOR_TARGET = "cursor" as const;

/** Managed rules file, relative to the project root. */
export const CURSOR_RULES_PATH = ".cursor/rules/engram.mdc";

/** Stable, unversioned asset id; also embedded in both markers. */
export const CURSOR_ASSET_ID = "engram-cursor-rules";

/** HTML-comment markers around the body; invisible when the rule renders. */
export const CURSOR_BEGIN_MARKER = "<!-- BEGIN: engram-cursor-rules -->";
export const CURSOR_END_MARKER = "<!-- END: engram-cursor-rules -->";

/**
 * Declared header: the cursor frontmatter, always the file's first lines.
 * Markers must never appear inside it (core validateSpec enforces this).
 */
export const CURSOR_HEADER = [
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
    content: ENGRAM_GUIDANCE_TEMPLATE,
    markers: { begin: CURSOR_BEGIN_MARKER, end: CURSOR_END_MARKER },
    header: CURSOR_HEADER,
  };
  return { assets: [asset] };
};

/** Project targets install into the project directory itself. Trailing
 * separators are trimmed, but a separator-only root stays the root. */
export const cursorRoot = (projectRoot: string): string => {
  const trimmed = projectRoot.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
};
