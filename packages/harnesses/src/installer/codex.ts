/**
 * ENG-58 `codex` install target: user-level Codex CLI lifecycle hooks in
 * <home>/.codex/hooks.json plus an engram-owned sidecar ledger (turn-2,
 * review F2). Declares WHAT to manage as data over the ENG-34 installer
 * core; the core owns HOW.
 *
 * A1 discovery (offline, codex-cli 0.155.1, see constants.ts for the source):
 * - Hook config lives in hooks.json: {"hooks": {Event: [{hooks:
 *   [{type:"command", command, timeout}]}]}}. No matcher field in the
 *   observed schema, and the schema rejects unknown keys, so entries carry
 *   only spec-valid keys; the ownership ledger lives in the engram-owned
 *   engram-managed.json sidecar (markerless jsonEntries mode recognizes
 *   engram entries by canonical content equality; hand-edited entries are
 *   left alone).
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
import { HOST_HOOK_TIMEOUT_SECONDS } from "./constants.js";
import { sidecarAsset, type SidecarEntry } from "./sidecar.js";

export const CODEX_TARGET = "codex" as const;

/** Install root for user-level Codex configuration. */
export const codexRoot = (home: string): string => join(home.replace(/\/+$/, ""), ".codex");

const sidecarEntries = (): SidecarEntry[] => [
  {
    identity: "engram-hook:codex:startup",
    event: "SessionStart",
    command: "engram hook codex startup",
  },
  {
    identity: "engram-hook:codex:compact",
    event: "PostCompact",
    command: "engram hook codex compact",
  },
];

export const codexSpec = (): InstallSpec => {
  const asset: AssetSpec = {
    kind: "jsonEntries",
    id: "engram-codex-hooks",
    path: "hooks.json",
    mapPath: ["hooks"],
    entries: [
      {
        key: "SessionStart",
        groups: [
          {
            identity: "engram-hook:codex:startup",
            group: {
              hooks: [
                {
                  type: "command",
                  command: "engram hook codex startup",
                  timeout: HOST_HOOK_TIMEOUT_SECONDS,
                },
              ],
            },
          },
        ],
      },
      {
        key: "PostCompact",
        groups: [
          {
            identity: "engram-hook:codex:compact",
            group: {
              hooks: [
                {
                  type: "command",
                  command: "engram hook codex compact",
                  timeout: HOST_HOOK_TIMEOUT_SECONDS,
                },
              ],
            },
          },
        ],
      },
    ],
  };
  return { assets: [asset, sidecarAsset(CODEX_TARGET, "hooks.json", sidecarEntries())] };
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
  const unquote = (key: string): string => {
    const t = key.trim();
    return /^".*"$|^'.*'$/.test(t) ? t.slice(1, -1) : t;
  };
  let inFeatures = false;
  // Review turn-5: an inline `features = { ... }` line only counts at the
  // top level; under any [table] it belongs to that table, not the root.
  let atTopLevel = true;
  for (const raw of configToml.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const inline = atTopLevel && /^"?features"?\s*=\s*\{([^}]*)\}/.exec(line);
    if (inline) {
      const kv = /(?:^|[,{])\s*"?hooks"?\s*=\s*(true|false)\b/.exec(inline[1]);
      if (kv) return kv[1] === "true" ? "enabled" : "disabled";
      continue;
    }
    const table = /^\[+([^\]]+)\]+/.exec(line);
    if (table) {
      atTopLevel = false;
      inFeatures = unquote(table[1]) === "features";
      continue;
    }
    if (!inFeatures) continue;
    const kv = /^"?hooks"?\s*=\s*(true|false)\b/.exec(line);
    if (kv) return kv[1] === "true" ? "enabled" : "disabled";
  }
  return "default";
};
