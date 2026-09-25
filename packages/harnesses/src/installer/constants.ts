/**
 * ENG-58 shared constants for host install targets and hook runtime
 * behavior. One shared module per leader ruling A2 (handoffs/turn-1-eng58.md):
 * the fail-open bounds live here and tests assert them.
 */

/** Wall-clock bound on context loading inside a hook (A2). */
export const HOOK_TIMEOUT_MS = 5000;

/** Injected stdout cap in bytes; output beyond this is cut and marked (A2). */
export const HOOK_STDOUT_CAP_BYTES = 8192;

/** Appended when output is cut at the cap. Kept short and bounded. */
export const TRUNCATION_MARKER = "\n[engram: context truncated to 8 KiB]\n";

/** Stderr stays suppressed unless this env var is set (A2). */
export const HOOK_DEBUG_ENV = "ENGRAM_DEBUG";

/**
 * Timeout written into host hook entries. Must exceed HOOK_TIMEOUT_MS with
 * process startup slack so the internal bound fails open first.
 */
export const HOST_HOOK_TIMEOUT_SECONDS = 10;

/**
 * Minimum supported Codex CLI version (A1). Source: discovered offline
 * 2026-09-20 against the locally installed codex-cli 0.155.1
 * (`codex --version`): `~/.codex/hooks.json` hook config, event set incl.
 * SessionStart/PostCompact (binary string table), and `codex features list`
 * reporting the `hooks` feature as stage=stable, effective=true even with an
 * isolated empty CODEX_HOME. Hook tests use fixtures only; no live Codex.
 */
export const CODEX_MIN_VERSION = "0.155.1";

/**
 * Ownership markers (A3). Every engram-owned group entry in a host JSON hook
 * config carries `ENTRY_MARKER_KEY` with its stable identity; the document
 * root lists all owned identities under `OWNERSHIP_MARKER_KEY`. Hand-edited
 * entries referencing engram without the marker are left alone.
 */
export const ENTRY_MARKER_KEY = "engram";
export const OWNERSHIP_MARKER_KEY = "engramManaged";
