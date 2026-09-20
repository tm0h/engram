/**
 * ENG-58 `claude-code` install target: user-level Claude Code lifecycle
 * hooks in <home>/.claude/settings.json. Declares WHAT to manage as data
 * over the ENG-34 installer core; the core owns HOW.
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
import { ENTRY_MARKER_KEY, HOST_HOOK_TIMEOUT_SECONDS, OWNERSHIP_MARKER_KEY } from "./constants.js";

export const CLAUDE_CODE_TARGET = "claude-code" as const;

/** Install root for user-level Claude Code configuration. */
export const claudeCodeRoot = (home: string): string => join(home.replace(/\/+$/, ""), ".claude");

const claudeGroup = (event: string): { readonly [key: string]: any } => ({
  matcher: event,
  hooks: [
    {
      type: "command",
      command: `engram hook ${CLAUDE_CODE_TARGET} ${event}`,
      timeout: HOST_HOOK_TIMEOUT_SECONDS,
    },
  ],
});

export const claudeCodeSpec = (): InstallSpec => {
  const asset: AssetSpec = {
    kind: "jsonEntries",
    id: "engram-claude-code-hooks",
    path: "settings.json",
    mapPath: ["hooks"],
    registryKey: OWNERSHIP_MARKER_KEY,
    entryMarker: ENTRY_MARKER_KEY,
    entries: [
      {
        key: "SessionStart",
        groups: [
          { identity: "engram-hook:claude-code:startup", group: claudeGroup("startup") },
          { identity: "engram-hook:claude-code:resume", group: claudeGroup("resume") },
          { identity: "engram-hook:claude-code:compact", group: claudeGroup("compact") },
        ],
      },
    ],
  };
  return { assets: [asset] };
};
