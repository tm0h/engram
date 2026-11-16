import { effectiveStatus, type Engram } from "@engram/core";

export type BootstrapReason = "pinned" | "important-decision" | "critical-preference";
export interface BootstrapCandidate {
  entry: Engram;
  reason: BootstrapReason;
}

/** Stable author-curated priority, independent of filesystem chronology. */
export function bootstrapCandidates(
  entries: ReadonlyArray<Engram>,
  options: { now: number; includeInactive: boolean; includeScoped: boolean },
): { candidates: BootstrapCandidate[]; excluded: Record<string, number> } {
  const candidates: BootstrapCandidate[] = [];
  const excluded = { inactive: 0, scoped: 0, uncurated: 0 };
  for (const entry of entries) {
    if (!options.includeInactive && effectiveStatus(entry, options.now) !== "active") {
      excluded.inactive++;
      continue;
    }
    if (!options.includeScoped && entry.appliesTo?.length) {
      excluded.scoped++;
      continue;
    }
    const reason = entry.pinned
      ? "pinned"
      : entry.type === "decision" && (entry.importance ?? 0) >= 3
        ? "important-decision"
        : entry.type === "preference" && (entry.importance ?? 0) >= 4
          ? "critical-preference"
          : undefined;
    if (reason === undefined) {
      excluded.uncurated++;
      continue;
    }
    candidates.push({ entry, reason });
  }
  candidates.sort(
    (a, b) =>
      Number(b.entry.pinned) - Number(a.entry.pinned) ||
      (b.entry.importance ?? 0) - (a.entry.importance ?? 0) ||
      (a.entry.scope === b.entry.scope ? 0 : a.entry.scope === "project" ? -1 : 1) ||
      a.entry.id.localeCompare(b.entry.id),
  );
  return { candidates, excluded };
}
