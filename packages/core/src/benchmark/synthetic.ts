/**
 * ENG-18 deterministic synthetic corpus generator for latency measurement
 * (the D1 protocol measures p95 over 1,000 entries; the golden corpus has
 * 123). Pure and dependency-free: no Math.random, no clock, no I/O. The
 * same source entries and size always produce the same output.
 *
 * Methodology (pinned by the reviewer preflight measurement, adopted for
 * the shadow harness): entries repeat round-robin over the source list;
 * each clone gets a deterministic id, a variant suffix on the title, and
 * one fixed-pool filler sentence appended to the body so token statistics
 * vary without randomness. Scope, lifecycle, pinned, tags, type, and
 * timestamps are preserved unchanged so lifecycle filtering behaves on the
 * synthetic corpus exactly as on the source.
 */
import type { Engram } from "../domain.js";

/** Fixed filler pool: one sentence per clone index modulo pool size. */
const FILLERS: ReadonlyArray<string> = [
  "Notes captured during a routine maintenance window.",
  "This entry was kept for cross-referencing later.",
  "A short reminder about follow-up work and ownership.",
  "Context moved here from an older document.",
  "Related discussion happened in the team channel.",
  "Double-check the numbers before relying on them.",
  "The steps below were verified once and recorded.",
  "Keep this next to the runbook for quick access.",
];

/** Build `size` synthetic engrams by round-robin cloning `entries`.
 * Throws a RangeError on a non-integer or negative size and when the
 * source list is empty and a nonzero size was requested. */
export function syntheticCorpus(entries: ReadonlyArray<Engram>, size: number): Engram[] {
  if (!Number.isInteger(size) || size < 0) {
    throw new RangeError(`synthetic: size must be a nonnegative integer, got ${size}`);
  }
  if (size > 0 && entries.length === 0) {
    throw new RangeError("synthetic: source entries must not be empty for a nonzero size");
  }
  const out: Engram[] = [];
  for (let i = 0; i < size; i++) {
    const src = entries[i % entries.length] as Engram;
    const variant = Math.floor(i / entries.length);
    out.push({
      ...src,
      id: `syn-${String(i).padStart(4, "0")}-${src.id}`,
      title: `${src.title} (variant ${variant})`,
      body:
        src.body === ""
          ? (FILLERS[i % FILLERS.length] as string)
          : `${src.body} ${FILLERS[i % FILLERS.length]}`,
    });
  }
  return out;
}
