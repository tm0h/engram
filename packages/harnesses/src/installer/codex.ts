/**
 * ENG-58 `codex` install target: user-level Codex CLI lifecycle hooks in
 * <home>/.codex/hooks.json. Declares WHAT to manage as data over the ENG-34
 * installer core; the core owns HOW.
 *
 * A1 discovery (offline, codex-cli 0.155.1, see constants.ts for the source):
 * - Hook config lives in hooks.json: {"hooks": {Event: [{hooks:
 *   [{type:"command", command, timeout}]}]}}. No matcher field in the
 *   observed schema.
 * - Event set includes SessionStart, SessionEnd, PreCompact, PostCompact,
 *   PreToolUse, PostToolUse, PermissionRequest, UserPromptSubmit. There is
 *   NO distinct resume event, so A6's startup and resume both map onto
 *   SessionStart (one entry serves both; the engram hook command is
 *   identical in both cases).
 * - The `hooks` feature is stage=stable and effective=true with an isolated
 *   empty CODEX_HOME, so installers must NOT touch config.toml. An explicit
 *   `features.hooks = false` is user config: reported by status, never
 *   modified (A3).
 *
 * A6: compaction maps onto PostCompact (context injection after compaction,
 * mirroring Claude Code's SessionStart:compact source).
 *
 * A5: hook commands invoke `engram` bare; PATH resolves at hook runtime.
 */
import { join } from "node:path";
import type { AssetSpec, InstallSpec } from "../shared/installer.js";
import { ENTRY_MARKER_KEY, HOST_HOOK_TIMEOUT_SECONDS, OWNERSHIP_MARKER_KEY } from "./constants.js";

export const CODEX_TARGET = "codex" as const;

/** Install root for user-level Codex configuration. */
export const codexRoot = (home: string): string => join(home.replace(/\/+$/, ""), ".codex");

const codexGroup = (command: string): { readonly [key: string]: any } => ({
  hooks: [
    {
      type: "command",
      command,
      timeout: HOST_HOOK_TIMEOUT_SECONDS,
    },
  ],
});

export const codexSpec = (): InstallSpec => {
  const asset: AssetSpec = {
    kind: "jsonEntries",
    id: "engram-codex-hooks",
    path: "hooks.json",
    mapPath: ["hooks"],
    registryKey: OWNERSHIP_MARKER_KEY,
    entryMarker: ENTRY_MARKER_KEY,
    entries: [
      {
        key: "SessionStart",
        groups: [
          { identity: "engram-hook:codex:startup", group: codexGroup("engram hook codex startup") },
        ],
      },
      {
        key: "PostCompact",
        groups: [
          { identity: "engram-hook:codex:compact", group: codexGroup("engram hook codex compact") },
        ],
      },
    ],
  };
  return { assets: [asset] };
};

/**
 * Detect the user's explicit `hooks` feature flag from config.toml text.
 * Read-only reporting (A1/A3): an explicit `hooks = false` under [features]
 * disables hook execution; engram never modifies it. Absent flag means the
 * stable default (enabled at the pinned minimum version).
 */
export const codexHooksFlagState = (
  configToml: string | null,
): "default" | "enabled" | "disabled" => {
  if (configToml === null) return "default";
  let inFeatures = false;
  for (const raw of configToml.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const table = /^\[+([^\]]+)\]+/.exec(line);
    if (table) {
      inFeatures = table[1].trim() === "features";
      continue;
    }
    if (!inFeatures) continue;
    const kv = /^hooks\s*=\s*(true|false)\b/.exec(line);
    if (kv) return kv[1] === "true" ? "enabled" : "disabled";
  }
  return "default";
};
