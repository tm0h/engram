/**
 * ENG-37 `generic` install target (SPEC decision 2): one `text` asset that
 * installs the shared guidance template as a managed block in the project's
 * AGENTS.md. Content outside the markers is foreign and preserved
 * byte-for-byte by the ENG-34 installer core; uninstall removes the block,
 * never the file. Project-local: the install root is the project directory
 * itself, never the OS home. Marker wording is stable forever once shipped.
 */
import type { AssetSpec, InstallSpec } from "../shared/installer.js";
import { ENGRAM_GUIDANCE_TEMPLATE } from "./guidance-template.js";

export const GENERIC_TARGET = "generic" as const;

/** Managed file, relative to the project root. */
export const GENERIC_AGENTS_PATH = "AGENTS.md";

/** Stable, unversioned asset id; also embedded in both markers. */
export const GENERIC_ASSET_ID = "engram-agents-instructions";

/**
 * HTML-comment markers, both single-line and containing the asset id
 * (core `validMarkers` requires that). Exact wording is fixed forever.
 */
export const GENERIC_BEGIN_MARKER = "<!-- BEGIN: engram-agents-instructions -->";
export const GENERIC_END_MARKER = "<!-- END: engram-agents-instructions -->";

export const genericSpec = (): InstallSpec => {
  const asset: AssetSpec = {
    kind: "text",
    id: GENERIC_ASSET_ID,
    path: GENERIC_AGENTS_PATH,
    beginMarker: GENERIC_BEGIN_MARKER,
    endMarker: GENERIC_END_MARKER,
    content: ENGRAM_GUIDANCE_TEMPLATE,
  };
  return { assets: [asset] };
};

/** Project targets install into the project directory itself. Trailing
 * separators are trimmed, but a separator-only root stays the root. */
export const genericRoot = (projectRoot: string): string => {
  const trimmed = projectRoot.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
};
