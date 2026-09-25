/**
 * ENG-58 `claude-code` install target: user-level Claude Code lifecycle
 * hooks in <home>/.claude/settings.json plus an engram-owned sidecar ledger
 * (turn-2, review F2). Declares WHAT to manage as data over the ENG-34
 * installer core; the core owns HOW.
 *
 * The hook entries carry only documented Claude Code schema keys (matcher,
 * hooks); the ownership ledger lives in the engram-managed.json sidecar
 * because no documented tolerance for unknown keys in settings.json is
 * citable. The markerless jsonEntries mode recognizes engram entries by
 * canonical content equality; hand-edited entries are left alone.
 *
 * A6: turn-1 event set is exactly startup, resume, and compaction. Claude
 * Code surfaces these as SessionStart sources startup|resume|compact, so
 * each logical event gets its own matcher group with its own identity.
 *
 * A5: hook commands invoke `engram` bare; the host shell resolves PATH at
 * hook runtime. No install-time absolute paths are ever written.
 */
import { join } from "node:path";
import type { AssetSpec, InstallSpec } from "../shared/installer.js";
import { HOST_HOOK_TIMEOUT_SECONDS } from "./constants.js";
import { sidecarAsset, type SidecarEntry } from "./sidecar.js";

export const CLAUDE_CODE_TARGET = "claude-code" as const;

/** Install root for user-level Claude Code configuration. */
export const claudeCodeRoot = (home: string): string => join(home.replace(/\/+$/, ""), ".claude");

const HOOK_SOURCES = ["startup", "resume", "compact"] as const;

export const claudeCodeSpec = (): InstallSpec => {
  const entries: SidecarEntry[] = HOOK_SOURCES.map((source) => ({
    identity: `engram-hook:${CLAUDE_CODE_TARGET}:${source}`,
    event: "SessionStart",
    command: `engram hook ${CLAUDE_CODE_TARGET} ${source}`,
  }));
  const asset: AssetSpec = {
    kind: "jsonEntries",
    id: "engram-claude-code-hooks",
    path: "settings.json",
    mapPath: ["hooks"],
    entries: [
      {
        key: "SessionStart",
        groups: HOOK_SOURCES.map((source) => ({
          identity: `engram-hook:${CLAUDE_CODE_TARGET}:${source}`,
          group: {
            matcher: source,
            hooks: [
              {
                type: "command",
                command: `engram hook ${CLAUDE_CODE_TARGET} ${source}`,
                timeout: HOST_HOOK_TIMEOUT_SECONDS,
              },
            ],
          },
        })),
      },
    ],
  };
  return { assets: [asset, sidecarAsset(CLAUDE_CODE_TARGET, "settings.json", entries)] };
};
