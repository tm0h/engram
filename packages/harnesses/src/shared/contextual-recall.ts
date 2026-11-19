import { Duration, Effect, Exit, Option } from "effect";
import {
  ConfigRepo,
  DEFAULT_AUTO_CONTEXT_SCOPE,
  DEFAULT_AUTO_CONTEXT_MAX_CHARS,
  DEFAULT_AUTO_CONTEXT_LIMIT,
  effectiveStatus,
  EngramStore,
  contextualQuery,
  prepareContextualEvidence,
  searchEngrams,
  matchingSnippet,
  openingSnippet,
  pathApplies,
  validRetrievalPath,
  type Engram,
  type Scope,
} from "@engram/core";
import {
  AUTOMATIC_CANDIDATE_LIMIT,
  automaticMemory,
  type AutomaticContextResult,
} from "./automatic-compaction.js";
import { frameRecall, recallData } from "./recall-frame.js";
import { PERSONAL_ONLY_NOTE } from "./degraded.js";
import { recordRecallUsage } from "./stats.js";
import type { ContextualRecallOptions, OpResult } from "./types.js";

export const CONTEXTUAL_RECALL_LIMITS = {
  promptChars: 4096,
  activePaths: 16,
  pathChars: 256,
  bootstrapEntries: 100,
  rootChars: 4096,
  results: 5,
  diagnosticResults: 20,
  outputChars: 4096,
  outputBytes: 8192,
  timeoutMs: 500,
} as const;

const validInput = (opts: ContextualRecallOptions): boolean => {
  if (opts === null || typeof opts !== "object") return false;
  const cap = CONTEXTUAL_RECALL_LIMITS;
  return (
    typeof opts.prompt === "string" &&
    opts.prompt.length <= cap.promptChars &&
    ["task", "question"].includes(opts.intent) &&
    (opts.activePaths === undefined ||
      (Array.isArray(opts.activePaths) &&
        opts.activePaths.length <= cap.activePaths &&
        opts.activePaths.every(
          (p) => typeof p === "string" && p.length <= cap.pathChars && validRetrievalPath(p),
        ))) &&
    (opts.bootstrap === undefined ||
      (opts.bootstrap !== null &&
        (opts.bootstrap.projectRoot === null ||
          (typeof opts.bootstrap.projectRoot === "string" &&
            opts.bootstrap.projectRoot.length <= cap.rootChars)) &&
        Array.isArray(opts.bootstrap.selected) &&
        opts.bootstrap.selected.length <= cap.bootstrapEntries &&
        opts.bootstrap.selected.every(
          (m) =>
            m !== null &&
            typeof m === "object" &&
            typeof m.id === "string" &&
            /^(?:[0-9]{4}|[0-9a-hjkmnp-tv-z]{26})$/.test(m.id) &&
            ["project", "personal"].includes(m.scope),
        )))
  );
};
const empty = (reason: string, details: Record<string, unknown> = {}): OpResult => ({
  text: "",
  isError: false,
  details: { ...details, reason, selected: [] },
});

const retrieve = (opts: ContextualRecallOptions, automatic: boolean) =>
  Effect.gen(function* () {
    if (!validInput(opts)) return empty("invalid-input");
    const query = contextualQuery(opts.prompt);
    // Do not turn empty/punctuation-only prompts into recency retrieval.
    const hasQuery = /[\p{L}\p{N}]/u.test(query);
    if (!hasQuery && !automatic) return empty("empty-query");
    const cfg = yield* ConfigRepo;
    const global = yield* cfg.loadGlobal();
    if (global.autoContext !== "on") return empty("disabled");
    const store = yield* EngramStore;
    const root = yield* store.projectRoot();
    const scope = global.autoContextScope ?? DEFAULT_AUTO_CONTEXT_SCOPE;
    const personalOnly = scope === "both" && Option.isNone(root);
    const scopes: Scope[] =
      scope === "personal"
        ? ["personal"]
        : Option.isSome(root)
          ? scope === "both"
            ? ["project", "personal"]
            : ["project"]
          : scope === "both"
            ? ["personal"]
            : [];
    const entries: Engram[] = [];
    let diagnosticCount = 0;
    let omittedFiles = 0;
    for (const s of scopes) {
      const scan = yield* store.scan(s);
      entries.push(...scan.entries);
      diagnosticCount += scan.diagnostics.length;
      omittedFiles += scan.omittedFiles;
    }
    const eligible = entries.filter(
      (m) =>
        !m.appliesTo?.length ||
        opts.activePaths?.some((p) => m.appliesTo!.some((pattern) => pathApplies(pattern, p))),
    );
    // One global ranking over the path union; never concatenate per-path rankings.
    const ranked = hasQuery
      ? searchEngrams(eligible, opts.prompt, undefined, {
          explain: true,
          literal: true,
        })
      : [];
    const delivered =
      opts.bootstrap?.projectRoot === Option.getOrNull(root)
        ? new Set(opts.bootstrap.selected.map((m) => `${m.scope}:${m.id}`))
        : new Set<string>();
    const rows: string[] = [];
    const relevant = new Map<Engram, ReturnType<typeof automaticMemory>>();
    const selected: { id: string; scope: Scope }[] = [];
    const ranking: Record<string, unknown>[] = [];
    let duplicateCount = 0;
    let confidentCount = 0;
    let limitedCount = 0;
    const header = personalOnly ? `(${PERSONAL_ONLY_NOTE})\n` : "";
    const evidenceFor = prepareContextualEvidence(query, opts.prompt);
    for (const result of ranked) {
      const m = result.engram;
      const evidence = evidenceFor(result);
      const duplicate = delivered.has(`${m.scope}:${m.id}`);
      if (ranking.length < CONTEXTUAL_RECALL_LIMITS.diagnosticResults)
        ranking.push({
          id: m.id,
          scope: m.scope,
          score: result.score,
          ...evidence,
          duplicate,
        });
      if (!evidence.confident) continue;
      confidentCount++;
      if (duplicate) {
        duplicateCount++;
        continue;
      }
      if (automatic) {
        if (relevant.size < CONTEXTUAL_RECALL_LIMITS.results) {
          relevant.set(
            m,
            automaticMemory(m, matchingSnippet(m.body, query) ?? openingSnippet(m.body)),
          );
        }
        continue;
      }
      if (selected.length >= CONTEXTUAL_RECALL_LIMITS.results) {
        limitedCount++;
        continue;
      }
      const snippet = matchingSnippet(m.body, query) ?? openingSnippet(m.body);
      const row = recallData(
        JSON.stringify({
          id: m.id,
          scope: m.scope,
          type: m.type,
          title: m.title.slice(0, 256),
          snippet,
        }),
      );
      const text = frameRecall(header + [...rows, row].join("\n"));
      if (
        text.length > CONTEXTUAL_RECALL_LIMITS.outputChars ||
        new TextEncoder().encode(text).length > CONTEXTUAL_RECALL_LIMITS.outputBytes
      )
        continue;
      rows.push(row);
      selected.push({ id: m.id, scope: m.scope });
    }
    const details = {
      personalOnly,
      diagnosticCount,
      omittedFiles,
      ranking,
      rankedCount: ranked.length,
      confidentCount,
      duplicateCount,
      limitedCount,
      intent: opts.intent,
    };
    const result = selected.length
      ? {
          text: frameRecall(header + rows.join("\n")),
          isError: false,
          details: { ...details, reason: "selected", selected },
        }
      : empty(
          relevant.size
            ? "selected"
            : !hasQuery
              ? "empty-query"
              : confidentCount
                ? "excluded"
                : "weak",
          details,
        );
    if (!automatic) return result;
    const now = Date.now();
    const critical = eligible
      .filter(
        (entry) =>
          (entry.pinned || (entry.importance ?? 0) >= 4) &&
          effectiveStatus(entry, now) === "active",
      )
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          (b.importance ?? 0) - (a.importance ?? 0) ||
          Number(relevant.has(b)) - Number(relevant.has(a)) ||
          (a.scope === b.scope ? 0 : a.scope === "project" ? -1 : 1) ||
          a.id.localeCompare(b.id),
      );
    const curated = new Set(critical);
    const limit = global.autoContextLimit ?? DEFAULT_AUTO_CONTEXT_LIMIT;
    return {
      ...result,
      automatic: {
        rows: [
          ...critical
            .slice(0, AUTOMATIC_CANDIDATE_LIMIT)
            .map(
              (entry) => relevant.get(entry) ?? automaticMemory(entry, openingSnippet(entry.body)),
            ),
          ...[...relevant].filter(([entry]) => !curated.has(entry)).map(([, row]) => row),
        ],
        maxEntries: limit,
        outsideCandidateWindow:
          Math.max(0, critical.length - AUTOMATIC_CANDIDATE_LIMIT) +
          Math.max(0, confidentCount - duplicateCount - relevant.size),
        maxChars: global.autoContextMaxChars ?? DEFAULT_AUTO_CONTEXT_MAX_CHARS,
        omittedFiles,
        personalOnly,
      },
    };
  });

/** Automatic recall fails open on ordinary failures and internal timeout, while
 * caller interruption propagates. The deadline surrounds config AND store reads.
 * A final monotonic-clock check also discards synchronous ranking overruns. */
export const contextualRecallOp = (
  opts: ContextualRecallOptions,
  automatic = false,
): Effect.Effect<AutomaticContextResult, never, EngramStore | ConfigRepo> =>
  Effect.gen(function* () {
    const started = performance.now();
    const exit = yield* Effect.exit(
      retrieve(opts, automatic).pipe(
        Effect.timeoutOption(Duration.millis(CONTEXTUAL_RECALL_LIMITS.timeoutMs)),
      ),
    );
    const elapsedMs = Math.max(0, performance.now() - started);
    if (Exit.isFailure(exit) && Exit.hasInterrupts(exit)) return yield* Effect.interrupt;
    const result = Exit.isFailure(exit)
      ? empty("unavailable")
      : Option.isNone(exit.value) || elapsedMs >= CONTEXTUAL_RECALL_LIMITS.timeoutMs
        ? empty("timeout")
        : exit.value.value;
    if (!automatic) yield* recordRecallUsage(Math.round(elapsedMs), result);
    return { ...result, details: { schemaVersion: 1, ...result.details, elapsedMs } };
  });
