/**
 * ENG-43: read-time link adjacency over one completed {@link StoreScan}.
 *
 * Pure computation, one graph per scan: given a scan of one scope and one
 * exact target id, this module resolves the target, resolves the target's
 * outgoing `related` ids, and derives the incoming backlinks. It performs
 * no Effect, no filesystem access, no clock read, and no store call, so
 * reading links can never write: derived adjacency exists only in the
 * returned value, never on disk.
 *
 * Matching is exact and complete-string only. No prefix resolver exists
 * here (unlike `EngramStore.get`, whose prefix behavior stays unchanged):
 * an id resolves found iff a valid entry carries exactly that id, and
 * ambiguous iff `StoreScan.duplicateIds` claims exactly that id. A strict
 * prefix of any id — including a duplicate-claimed one — is missing.
 *
 * Results are total and never thrown: missing and ambiguous resolutions
 * are structured data, and every collection is always present (an empty
 * array where nothing qualifies). Self-links are not filtered (determinism
 * over damaged or synthetic scans; ENG-42 already rejects them at write
 * time), and backlink referrers are never filtered through duplicateIds:
 * every valid entry whose `related` contains the exact target id appears,
 * one row per source entry.
 */
import type { Engram } from "./domain.js";
import type { DuplicateIdClaim, StoreScan } from "./integrity.js";

/** Resolution of one exact id against one scan's entries and duplicate
 * claims. `duplicateIds` is consulted before `entries`, so a duplicate
 * claim resolves ambiguous even when exactly one claimant file is a valid
 * entry (mirroring the store's `get` refusal, but as data, not an error). */
export type LinkTargetResolution =
  | { readonly status: "found"; readonly id: string; readonly entry: Engram }
  | { readonly status: "missing"; readonly id: string }
  | {
      readonly status: "ambiguous";
      readonly id: string;
      /** Absolute claimant paths, as `StoreScan.duplicateIds` provides them
       * (the store sorts them lexicographically). */
      readonly claimants: ReadonlyArray<string>;
    };

/** Derived same-scope link adjacency for one requested target. Plain
 * serializable data with no omitted fields: `outgoing` is an empty array
 * whenever the target is not found (there is no source entry whose
 * `related` list could be read), never undefined or absent. */
export interface LinkAdjacency {
  /** The requested target's resolution (found, missing, or ambiguous). */
  readonly target: LinkTargetResolution;
  /** The found target's `related` ids resolved in authored order, one
   * discriminated result per slot; dangling and duplicate-claimed ids stay
   * in place. Empty when the target is missing or ambiguous. */
  readonly outgoing: ReadonlyArray<LinkTargetResolution>;
  /** Incoming backlinks: every valid entry in the scan whose `related`
   * contains the exact target id, complete strings only, ordered by
   * `created` then `id` (the store's list order). One row per source
   * entry; reciprocity is never inferred and nothing is written. */
  readonly incoming: ReadonlyArray<Engram>;
}

/** Same order as the store's list view: creation time, then id. Kept local
 * (instead of imported) so this module stays free of store imports and of
 * Effect. */
const chronological = (a: Engram, b: Engram): number =>
  a.created.localeCompare(b.created) || a.id.localeCompare(b.id);

/** Compute the same-scope link adjacency for one exact target id from one
 * completed {@link StoreScan}.
 *
 * Guarantees:
 * - Pure: no I/O, no clock, no Effect, no store calls; the scan is not
 *   mutated and reading never persists anything.
 * - Exact-match only, in both the target lookup and every outgoing id and
 *   backlink match; prefixes never resolve, in either direction.
 * - One graph per scan: entries and duplicate claims outside the given
 *   scan (e.g. the other scope) are invisible.
 * - Total: missing and ambiguous targets are structured results, never
 *   thrown; all result collections are always present.
 * - One linear pass to build exact-id maps up front: duplicate-claim ids
 *   and entry ids are each indexed once per call, so the requested target
 *   and every outgoing id resolve in constant time and incoming matching
 *   stays a single pass over entries. Total cost is linear in entries plus
 *   duplicate claims, independent of out-degree.
 *
 * Callers own scan acquisition (ENG-45's `linksOp` should pass one scan
 * per query so target and adjacency share one coherent snapshot). */
export const computeLinkAdjacency = (scan: StoreScan, targetId: string): LinkAdjacency => {
  /* Exact-id views, built once per call and shared by target and outgoing
   * resolution. Duplicate claims take precedence over entries; an unclaimed
   * id resolves to its first entry in scan order (the previous `find`
   * behavior, kept for synthetic scans with unclaimed duplicate ids). */
  /* ENG-45 R2: same first-wins rule as entryById. Map-from-iterable would
   * keep the LAST of a pathological same-id claim pair; the guard keeps the
   * FIRST (the old `find` semantics). */
  const claimById = new Map<string, DuplicateIdClaim>();
  for (const c of scan.duplicateIds) {
    if (!claimById.has(c.id)) claimById.set(c.id, c);
  }
  const entryById = new Map<string, Engram>();
  for (const m of scan.entries) {
    if (!entryById.has(m.id)) entryById.set(m.id, m);
  }

  /* Exact-id resolution only: duplicate claims win over valid entries, and
   * no prefix of any id ever resolves. */
  const resolveExact = (id: string): LinkTargetResolution => {
    const claimed = claimById.get(id);
    if (claimed !== undefined) {
      return { status: "ambiguous", id, claimants: claimed.files };
    }
    const entry = entryById.get(id);
    return entry === undefined ? { status: "missing", id } : { status: "found", id, entry };
  };

  const target = resolveExact(targetId);
  const outgoing =
    target.status === "found" ? (target.entry.related ?? []).map((id) => resolveExact(id)) : [];
  const incoming = scan.entries
    .filter((m) => m.related?.includes(targetId) === true)
    .sort(chronological);
  return { target, outgoing, incoming };
};
