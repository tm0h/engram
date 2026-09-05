/**
 * Corpus adapter for the ENG-8 benchmark.
 *
 * PROVISIONAL consumer of the ENG-11 contract: `ContractCorpusAdapter`
 * consumes the mirrored loaded-corpus shape (see types.ts). It maps, it
 * never validates: loading and validation are ENG-11's executable contract,
 * and a corpus with issues is refused, not repaired.
 *
 * At the gated integration turn this adapter consumes the real
 * `@engram/core/corpus` loadCorpus output unchanged (structural typing);
 * only the import site moves.
 */
import { effectiveStatus, type Engram } from "../domain.js";
import { parseTimestamp } from "../util.js";
import { byIdAsc } from "./metrics.js";
import type { CorpusMeta, LoadedCorpusMirror, QueryCase, RunInput } from "./types.js";

/** A corpus source for the benchmark runner. */
export interface CorpusAdapter {
  /** Return the loaded corpus payload the adapter was built with. */
  load(): LoadedCorpusMirror;
  /** Map the payload into canonical runner input; refuses when the corpus
   * is not evaluable. */
  toRunInput(loaded?: LoadedCorpusMirror): RunInput;
}

function fail(message: string): never {
  throw new Error(`benchmark corpus: ${message}`);
}

/** Refusal detail listing every issue, sorted by (file, message), no
 * truncation (ruling Q2): a corpus with issues is not evaluable. */
function issuesDetail(issues: LoadedCorpusMirror["issues"]): string {
  const sorted = [...issues].sort(
    (a, b) => byIdAsc(a.file, b.file) || byIdAsc(a.message, b.message),
  );
  return `${issues.length} issue(s); refusing evaluation: ${sorted
    .map((i) => `${i.file}: ${i.message}`)
    .join("; ")}`;
}

function resolveNowMs(
  c: LoadedCorpusMirror["cases"][number],
  defaultNowMs: number | undefined,
): number {
  const fromCase = c.now !== undefined ? parseTimestamp(c.now) : undefined;
  const nowMs = fromCase ?? defaultNowMs;
  if (nowMs === undefined) {
    fail(`case ${c.id} has no fixed timestamp; refusing to read the wall clock`);
  }
  return nowMs;
}

/**
 * Adapter over an already-loaded contract corpus (the mirrored
 * LoadedCorpus shape). Holds the payload; there is deliberately no I/O and
 * no validation here.
 */
export class ContractCorpusAdapter implements CorpusAdapter {
  private readonly loaded: LoadedCorpusMirror;

  constructor(loaded: LoadedCorpusMirror) {
    this.loaded = loaded;
  }

  load(): LoadedCorpusMirror {
    return this.loaded;
  }

  toRunInput(loaded: LoadedCorpusMirror = this.loaded): RunInput {
    if (loaded.issues.length > 0) fail(issuesDetail(loaded.issues));
    const manifest = loaded.manifest;
    if (manifest === undefined) {
      fail("the corpus has no manifest; refusing evaluation");
    }
    if (manifest.defaultNow !== undefined && parseTimestamp(manifest.defaultNow) === undefined) {
      fail(`manifest defaultNow is not a valid ISO 8601 timestamp: ${manifest.defaultNow}`);
    }
    const defaultNowMs =
      manifest.defaultNow !== undefined ? parseTimestamp(manifest.defaultNow) : undefined;
    const meta: CorpusMeta = {
      name: manifest.name,
      corpusVersion: manifest.corpusVersion,
      schemaVersion: manifest.schemaVersion,
    };

    const seenEntry = new Set<string>();
    for (const record of loaded.engrams) {
      if (seenEntry.has(record.engram.id)) {
        fail(`duplicate entry id ${record.engram.id}`);
      }
      seenEntry.add(record.engram.id);
    }
    const entries = [...loaded.engrams].map((r) => r.engram).sort((a, b) => byIdAsc(a.id, b.id));

    const queries: QueryCase[] = loaded.cases.map((c) => ({
      id: c.id,
      query: c.query,
      category: c.category,
      scope: c.scope,
      relevantIds: c.requiredIds,
      supportingIds: c.supportingIds,
      forbiddenIds: c.forbiddenIds,
      expectAbstain: c.expectEmpty,
      nowMs: resolveNowMs(c, defaultNowMs),
      source: c,
    }));
    const seenCase = new Set<string>();
    for (const q of queries) {
      if (seenCase.has(q.id)) fail(`duplicate case id ${q.id}`);
      seenCase.add(q.id);
    }
    queries.sort((a, b) => byIdAsc(a.id, b.id));

    return { meta, defaultNowMs, entries, queries };
  }
}

/**
 * Rendered-character rule, benchmark-owned consumer side (ruling Q7):
 * title, body, and tags joined by newlines (tags single-space separated).
 * Counts are UTF-16 code units (String.length). ENG-11 defines no render
 * rule; if one lands, only this function changes.
 */
export function renderEntry(entry: Engram): string {
  return [entry.title, entry.body, entry.tags.join(" ")].join("\n");
}

/** Re-exported for tests and future consumers: the lifecycle predicate that
 * backs the stale rate (effectiveStatus at the case's fixed instant). */
export const isStaleAt = (entry: Engram, nowMs: number): boolean =>
  effectiveStatus(entry, nowMs) !== "active";
