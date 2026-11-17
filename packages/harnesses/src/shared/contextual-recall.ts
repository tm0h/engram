import { Duration, Effect, Exit, Option } from "effect";
import {
  ConfigRepo,
  DEFAULT_AUTO_CONTEXT_SCOPE,
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
import { frameRecall, recallData } from "./recall-frame.js";
import { PERSONAL_ONLY_NOTE } from "./degraded.js";
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

const retrieve = (opts: ContextualRecallOptions) =>
  Effect.gen(function* () {
    if (!validInput(opts)) return empty("invalid-input");
    const query = contextualQuery(opts.prompt);
    // Do not turn empty/punctuation-only prompts into recency retrieval.
    if (!/[\p{L}\p{N}]/u.test(query)) return empty("empty-query");
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
    const ranked = searchEngrams(eligible, opts.prompt, undefined, {
      explain: true,
      literal: true,
    });
    const delivered =
      opts.bootstrap?.projectRoot === Option.getOrNull(root)
        ? new Set(opts.bootstrap.selected.map((m) => `${m.scope}:${m.id}`))
        : new Set<string>();
    const rows: string[] = [];
    const selected: { id: string; scope: Scope }[] = [];
    const ranking: Record<string, unknown>[] = [];
    let duplicateCount = 0;
    let confidentCount = 0;
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
      if (selected.length >= CONTEXTUAL_RECALL_LIMITS.results) continue;
      const row = recallData(
        JSON.stringify({
          id: m.id,
          scope: m.scope,
          type: m.type,
          title: m.title.slice(0, 256),
          snippet: matchingSnippet(m.body, query) ?? openingSnippet(m.body),
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
      intent: opts.intent,
    };
    return selected.length
      ? {
          text: frameRecall(header + rows.join("\n")),
          isError: false,
          details: { ...details, reason: "selected", selected },
        }
      : empty(confidentCount ? "excluded" : "weak", details);
  });

/** Automatic recall fails open on ordinary failures and internal timeout, while
 * caller interruption propagates. The deadline surrounds config AND store reads.
 * A final monotonic-clock check also discards synchronous ranking overruns. */
export const contextualRecallOp = (
  opts: ContextualRecallOptions,
): Effect.Effect<OpResult, never, EngramStore | ConfigRepo> =>
  Effect.gen(function* () {
    const started = performance.now();
    const exit = yield* Effect.exit(
      retrieve(opts).pipe(
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
    return { ...result, details: { schemaVersion: 1, ...result.details, elapsedMs } };
  });
