/**
 * ENG-58 turn-2 (review F2): engram-owned ownership ledger sidecar.
 *
 * Host hook configs whose schema rejects unknown keys must carry no engram
 * marker or registry keys at all (codex hooks.json; and claude
 * settings.json under the conservative reading — no documented tolerance
 * for unknown keys is citable). The ownership ledger therefore moves to a
 * wholly-owned sidecar file next to the host config, installed as an
 * ENG-34 `file` asset with line markers, so the core provides drift repair
 * (stale sidecar rebuilt in place), owned-only uninstall (removed only
 * when exactly the managed block), and never overwrites a foreign file.
 *
 * Marker lines are JSON string elements, so the whole sidecar stays valid
 * JSON: JSON.parse(sidecar) returns [beginMarker, ledger, endMarker].
 */
import type { AssetSpec } from "../shared/installer.js";

export const SIDECAR_FILENAME = "engram-managed.json";
export const SIDECAR_VERSION = 1;

export interface SidecarEntry {
  readonly identity: string;
  readonly event: string;
  readonly command: string;
}

/** Parse a sidecar file into its ledger; null when it is not a sidecar. */
export const parseSidecarLedger = (
  text: string,
): {
  configFile: string;
  entries: Array<{ readonly command: string; readonly event: string; readonly identity: string }>;
  target: string;
  version: number;
} | null => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const ledger = parsed[1];
    if (typeof ledger !== "object" || ledger === null) return null;
    return ledger as {
      configFile: string;
      entries: Array<{ command: string; event: string; identity: string }>;
      target: string;
      version: number;
    };
  } catch {
    return null;
  }
};

/**
 * Build the wholly-owned sidecar asset for a target. Marker lines are the
 * first and last lines and embed the asset id; both are valid JSON syntax
 * (array with string elements), keeping the file parseable.
 */
export const sidecarAsset = (
  target: string,
  configFile: string,
  entries: ReadonlyArray<SidecarEntry>,
): AssetSpec => {
  const ledger = {
    configFile,
    entries: [...entries]
      .sort((a, b) => a.identity.localeCompare(b.identity))
      .map((e) => ({ command: e.command, event: e.event, identity: e.identity })),
    target,
    version: SIDECAR_VERSION,
  };
  return {
    kind: "file",
    id: `engram-${target}-sidecar`,
    path: SIDECAR_FILENAME,
    markers: {
      begin: `["engram-${target}-sidecar",`,
      end: `,"engram-${target}-sidecar"]`,
    },
    content: JSON.stringify(ledger, null, 2),
  };
};
