import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Engram } from "../../src/domain.js";
import { searchEngrams, type SearchResult } from "../../src/search.js";
import { parseTimestamp } from "../../src/util.js";
import type {
  CorpusCaseMirror,
  EvaluateFn,
  LoadedCorpusMirror,
  QueryCase,
  RunConfig,
} from "../../src/benchmark/types.js";

/** Fixed benchmark configuration. `abstainThreshold` is deliberately
 * exercised at two values in runner tests to prove it is inert in the
 * id-only path (turn-1 ruling Q1, still in force). */
export const TEST_CONFIG: RunConfig = {
  kValues: [1, 3, 5],
  abstainThreshold: 0,
};

/** The manifest default instant, as epoch ms (adapter resolves the same
 * value via util.parseTimestamp). */
export const DEFAULT_NOW_MS = Date.parse("2026-06-01T00:00:00.000Z");

/** Load the benchmark-internal fixture JSON from disk as an untyped value,
 * the way an adapter receives data before mapping. */
export function loadFixtureRaw(): unknown {
  const path = fileURLToPath(
    new URL("../fixtures/benchmark/benchmark-eval-fixture.json", import.meta.url),
  );
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** The fixture as a LoadedCorpusMirror: the raw object is
 * { manifest, engrams, cases } by design (loading, including issue
 * collection, is ENG-11's job), so the empty issues list is attached here. */
export function loadFixtureLoaded(): LoadedCorpusMirror {
  const raw = loadFixtureRaw() as Omit<LoadedCorpusMirror, "issues">;
  return { ...raw, issues: [] };
}

/** Test-only evaluate fn implementing the pinned procedure over the real
 * searchEngrams (scope filter, one search call, case.now else
 * defaultNowMs). Mirrors ENG-11's evaluateCase so fixture tests exercise
 * the same semantics; src/ never contains this. */
export const pinnedEvaluate: EvaluateFn = (engrams, c, defaultNowMs) => {
  const scoped = engrams.filter((e) => e.scope === c.scope);
  const nowMs = (c.now !== undefined ? parseTimestamp(c.now) : undefined) ?? defaultNowMs;
  if (nowMs === undefined) {
    throw new Error(`case ${c.id} has no fixed timestamp; refusing to read the wall clock`);
  }
  return searchEngrams(scoped, c.query, c.limit, {
    includeInactive: c.includeInactive ?? false,
    now: nowMs,
  }) as SearchResult[];
};

/** Injected clock stepping `step` ns per call. Two calls per query (t0, t1)
 * mean every query's latencyNs is exactly `step`: deterministic. */
export function steppingClock(step = 10): () => bigint {
  let i = 0;
  return () => {
    i += 1;
    return BigInt(i) * BigInt(step);
  };
}

/** Constant clock: every latency measures as 0ns. */
export function constantClock(): () => bigint {
  return () => 5n;
}

/** Domain Engram builder for metric tests (content is irrelevant to the
 * math; lifecycle fields are what matter). */
export function engram(over: Partial<Engram> & { id: string }): Engram {
  return {
    title: `Engram ${over.id}`,
    type: "note",
    tags: [],
    scope: "project",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    author: undefined,
    pinned: false,
    body: "",
    path: `engrams/${over.id}.md`,
    ...over,
  };
}

/** Benchmark QueryCase builder with defaults so tests spell out only what
 * matters. The source mirror is synthesized from the same fields. */
export function queryCase(over: Partial<QueryCase> & { id: string }): QueryCase {
  const merged: QueryCase = {
    query: over.id,
    category: "exact-facts",
    scope: "project",
    relevantIds: [],
    supportingIds: [],
    forbiddenIds: [],
    expectAbstain: false,
    nowMs: DEFAULT_NOW_MS,
    source: {
      id: over.id,
      query: over.query ?? over.id,
      category: over.category ?? "exact-facts",
      requiredIds: [],
      supportingIds: [],
      forbiddenIds: [],
      scope: over.scope ?? "project",
      expectEmpty: false,
    },
    ...over,
  };
  return merged;
}

/** Convenience: a mirror case carrying the ground truth a test needs. */
export function mirrorCase(over: Partial<CorpusCaseMirror> & { id: string }): CorpusCaseMirror {
  return {
    query: over.id,
    category: "exact-facts",
    requiredIds: [],
    supportingIds: [],
    forbiddenIds: [],
    scope: "project",
    expectEmpty: false,
    ...over,
  };
}
