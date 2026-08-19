/** Degraded-mode messages. Plain text: they end up in LLM tool results. */

/** Shown when reads fall back to personal scope (no project root found). */
export const PERSONAL_ONLY_NOTE = "No project engram here - personal scope only.";

/** Why-style hints for a missing project root, per operation. */
export function projectUninitialized(kind: "read" | "add"): string {
  if (kind === "add") {
    return (
      "No .engram/ project found in this directory.\n" +
      'Run `engram init` (or /engram init) first, or pass scope "personal" ' +
      "to record this engram only on this machine."
    );
  }
  return (
    "No .engram/ project found in this directory.\n" +
    "Run `engram init` (or /engram init) to create one, or use the personal scope."
  );
}
