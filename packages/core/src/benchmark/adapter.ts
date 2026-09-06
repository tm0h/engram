/**
 * Corpus adapter for the ENG-8 benchmark.
 *
 * Binds the benchmark to the real ENG-11 contract: `load()` runs the real
 * `loadCorpus` over the in-repo `corpus/` directory (path derived from this
 * module's URL, never from cwd), and `toRunInput` maps the loaded corpus
 * into canonical runner input. The adapter validates nothing: loading and
 * validation are the contract's executable job (`loadCorpus` reports every
 * defect as an issue), and a corpus with issues is refused here, not
 * repaired.
 *
 * Test support: the constructor accepts an already-loaded corpus so unit
 * tests can drive the adapter over the benchmark-internal fixture without
 * touching the on-disk corpus.
 */
import { fileURLToPath } from "node:url";
import { loadCorpus } from "@engram/core/corpus";
import { effectiveStatus, type Engram } from "../domain.js";
import { parseTimestamp } from "../util.js";
import { byIdAsc } from "./metrics.js";
import type { CorpusMeta, QueryCase, RunInput } from "./types.js";
import type { CorpusCase, LoadedCorpus } from "@engram/core/corpus";

/** The in-repo corpus directory, resolved from this module's location:
 * <checkout>/packages/core/src/benchmark/ -> <checkout>/corpus/. Never
 * cwd-dependent, never a /tmp or sibling-worktree path. */
export const DEFAULT_CORPUS_DIR = fileURLToPath(new URL("../../../../corpus/", import.meta.url));

function fail(message: string): never {
  throw new Error(`benchmark corpus: ${message}`);
}

/** Refusal detail listing every issue, sorted by (file, message), no
 * truncation: a corpus with issues is not evaluable. */
function issuesDetail(issues: LoadedCorpus["issues"]): string {
  const sorted = [...issues].sort(
    (a, b) => byIdAsc(a.file, b.file) || byIdAsc(a.message, b.message),
  );
  return `${issues.length} issue(s); refusing evaluation: ${sorted
    .map((i) => `${i.file}: ${i.message}`)
    .join("; ")}`;
}

function resolveNowMs(c: CorpusCase, defaultNowMs: number | undefined): number {
  const fromCase = c.now !== undefined ? parseTimestamp(c.now) : undefined;
  const nowMs = fromCase ?? defaultNowMs;
  if (nowMs === undefined) {
    fail(`case ${c.id} has no fixed timestamp; refusing to read the wall clock`);
  }
  return nowMs;
}

/** Adapter over a loaded contract corpus. Constructed bare, it reads the
 * in-repo `corpus/` directory through the real `loadCorpus` on `load()`;
 * constructed with a loaded corpus (tests), it uses exactly that payload. */
export class ContractCorpusAdapter {
  private readonly injected: LoadedCorpus | undefined;
  private readonly dir: string;

  constructor(loaded?: LoadedCorpus) {
    this.injected = loaded;
    this.dir = DEFAULT_CORPUS_DIR;
  }

  load(): LoadedCorpus {
    return this.injected ?? loadCorpus(this.dir);
  }

  toRunInput(loaded: LoadedCorpus = this.load()): RunInput {
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
    queries.sort((a, b) => byIdAsc(a.id, b.id));

    return { meta, defaultNowMs, entries, queries };
  }
}

/**
 * Rendered-character rule, benchmark-owned consumer side: title, body, and
 * tags joined by newlines (tags single-space separated). Counts are UTF-16
 * code units (String.length). The contract defines no render rule; if one
 * lands, only this function changes.
 */
export function renderEntry(entry: Engram): string {
  return [entry.title, entry.body, entry.tags.join(" ")].join("\n");
}

/** The lifecycle predicate that backs the stale rate (effectiveStatus at
 * the case's fixed instant). */
export const isStaleAt = (entry: Engram, nowMs: number): boolean =>
  effectiveStatus(entry, nowMs) !== "active";
