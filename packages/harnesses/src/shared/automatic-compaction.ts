import process from "node:process";
import type { Engram } from "@engram/core";
import { HOOK_DEBUG_ENV } from "../installer/constants.js";
import { CONTEXT_TOKEN_METHOD, countContextTokens } from "./context-budget.js";
import type { OpResult } from "./types.js";
import { frameRecall, recallData } from "./recall-frame.js";

export interface AutomaticMemory extends Pick<Engram, "id" | "scope" | "type" | "title"> {
  readonly snippet: string | null;
  readonly titleTruncated?: boolean;
}

export interface AutomaticContext {
  readonly rows: readonly AutomaticMemory[];
  readonly maxChars: number;
  readonly maxEntries?: number;
  readonly outsideCandidateWindow?: number;
  readonly omittedFiles?: number;
  readonly personalOnly?: boolean;
}

export type AutomaticContextResult = OpResult & { readonly automatic?: AutomaticContext };

const POLICIES = {
  pi: { separator: "\n\n", envelope: 0, unknownWindowAllowance: 2048 },
  // OpenCode sends system parts separately or joins them, depending on the
  // provider. Charge both the join and a per-injection message envelope.
  opencode: { separator: "\n\n", envelope: 16, unknownWindowAllowance: 2048 },
} as const;
const DEFAULT_OUTPUT_RESERVE = 256;
const MAX_TITLE_CHARS = 256;
export const AUTOMATIC_CANDIDATE_LIMIT = 100;
// OpenCode can combine its scoped recall and bootstrap candidate windows.
const MAX_AUTOMATIC_ROWS = 2 * AUTOMATIC_CANDIDATE_LIMIT;
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });

interface PromptBudget {
  readonly harness: keyof typeof POLICIES;
  readonly system: readonly string[];
  readonly prompt: string;
  readonly contextWindow?: number;
  readonly inputLimit?: number;
  readonly output?: number;
  readonly priorUsage?: number | null;
}

const positive = (n: number | undefined): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;

const provenance = ({ id, scope }: Pick<AutomaticMemory, "id" | "scope">) => ({ id, scope });
const quoted = (text: string) =>
  recallData(JSON.stringify(text.replace(/[\uD800-\uDFFF]/gu, "\uFFFD")));

export function automaticMemory(entry: Engram, snippet: string | null): AutomaticMemory {
  const titleTruncated = entry.title.length > MAX_TITLE_CHARS;
  let title = entry.title;
  if (titleTruncated) {
    let end = 0;
    for (const { index, segment } of graphemes.segment(title.slice(0, MAX_TITLE_CHARS))) {
      // Leave a position for the marker. The final segment of the slice
      // could be incomplete, so only keep earlier complete segments.
      if (index + segment.length >= MAX_TITLE_CHARS) break;
      end = index + segment.length;
    }
    title = title.slice(0, end) + "…";
  }
  return { ...provenance(entry), type: entry.type, title, snippet, titleTruncated };
}

function renderRow(row: AutomaticMemory, title: string, snippet: string | null) {
  return `${row.scope}/${row.id} ${row.type} ${quoted(title)}${snippet ? ` — ${quoted(snippet)}` : ""}`;
}

function safePrefix(text: string, fits: (prefix: string) => boolean): string {
  const points = Array.from(graphemes.segment(text), ({ segment }) => segment);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(points.slice(0, mid).join("") + "…")) low = mid;
    else high = mid - 1;
  }
  return points.slice(0, low).join("") + "…";
}

/** Fit structured, untrusted memory after the host has assembled its prompt. */
export function compactAutomaticContext(source: AutomaticContext, input: PromptBudget) {
  const policy = POLICIES[input.harness];
  const { system, prompt, contextWindow, inputLimit, output, priorUsage } = input;
  const promptCost = countContextTokens(prompt) + 16;
  const separatorCost = countContextTokens(policy.separator);
  const systemCost =
    system.reduce((sum, part) => sum + countContextTokens(part) + policy.envelope, 0) +
    Math.max(0, system.length - 1) * separatorCost;
  const existing =
    Math.max(systemCost, positive(priorUsage ?? undefined) ? (priorUsage ?? 0) : 0) + promptCost;
  const headroom = positive(contextWindow)
    ? contextWindow - (positive(output) ? output : DEFAULT_OUTPUT_RESERVE)
    : Infinity;
  const inputCeiling = Math.min(headroom, positive(inputLimit) ? inputLimit : Infinity);
  const hasWindow = Number.isFinite(inputCeiling);
  const effective = Math.max(
    0,
    Math.min(source.maxChars, hasWindow ? inputCeiling - existing : policy.unknownWindowAllowance),
  );
  const overhead = (system.length ? separatorCost : 0) + policy.envelope;
  const frameCost = countContextTokens(frameRecall(""));
  const selected: ReturnType<typeof provenance>[] = [];
  const omitted: (ReturnType<typeof provenance> & { reason: "budget" | "limit" })[] = [];
  const truncated: ReturnType<typeof provenance>[] = [];
  const deduplicated: ReturnType<typeof provenance>[] = [];
  const rows: string[] = [];
  const suppliedLines = new Set(
    [...system, prompt].flatMap((part) => part.split("\n").map((line) => line.trim())),
  );
  const suppliedPrefixes = [...suppliedLines]
    .filter((line) => /^(project|personal)\//.test(line) && line.endsWith('…"'))
    .map((line) => line.slice(0, -2));
  const maxEntries = source.maxEntries ?? AUTOMATIC_CANDIDATE_LIMIT;
  const seen = new Set<string>();
  let used = overhead + frameCost;
  for (const row of source.rows.slice(0, MAX_AUTOMATIC_ROWS)) {
    const identity = provenance(row);
    const key = `${row.scope}/${row.id}`;
    const title = row.title;
    const snippet = row.snippet;
    const complete = renderRow(row, title, snippet);
    const legacyRow = recallData(
      JSON.stringify({
        id: row.id,
        scope: row.scope,
        type: row.type,
        title: row.title.slice(0, 256),
        snippet,
      }),
    );
    const titleOnly = renderRow(row, title, null);
    // A bare id or a similar title never suppresses a different entry. A
    // complete verbatim excerpt can already be present in free-form text.
    if (
      seen.has(key) ||
      suppliedLines.has(complete) ||
      suppliedLines.has(legacyRow) ||
      suppliedPrefixes.some(
        (prefix) => prefix.startsWith(`${key} `) && complete.startsWith(prefix),
      ) ||
      (snippet && !snippet.startsWith("…") && !snippet.endsWith("…") && suppliedLines.has(snippet))
    ) {
      deduplicated.push(identity);
      continue;
    }
    seen.add(key);
    if (selected.length >= maxEntries) {
      omitted.push({ ...identity, reason: "limit" });
      continue;
    }
    const remaining = effective - used - Number(rows.length > 0);
    const fits = (text: string) => countContextTokens(text) <= remaining;
    let rendered = complete;
    if (!fits(complete)) {
      // Preserve provenance, then the original title and an extractive prefix.
      // Re-render after slicing so quoting and memory delimiters stay intact.
      if (snippet && fits(renderRow(row, title, "…"))) {
        rendered = renderRow(
          row,
          title,
          safePrefix(snippet, (prefix) => fits(renderRow(row, title, prefix))),
        );
      } else if (fits(titleOnly)) {
        rendered = titleOnly;
      } else if (fits(renderRow(row, "…", null))) {
        rendered = renderRow(
          row,
          safePrefix(title, (prefix) => fits(renderRow(row, prefix, null))),
          null,
        );
      } else {
        omitted.push({ ...identity, reason: "budget" });
        continue;
      }
    }
    if (suppliedLines.has(rendered)) {
      deduplicated.push(identity);
      continue;
    }
    if (rendered !== complete || row.titleTruncated) truncated.push(identity);
    used += countContextTokens(rendered) + Number(rows.length > 0);
    rows.push(rendered);
    selected.push(identity);
  }
  const text = rows.length ? frameRecall(rows.join("\n")) : "";
  return {
    text,
    diagnostics: {
      schemaVersion: 1,
      method: CONTEXT_TOKEN_METHOD,
      harness: input.harness,
      window: hasWindow ? "model" : "fallback",
      effective,
      used: text ? used : 0,
      selected,
      omitted,
      truncated,
      deduplicated,
      omittedFiles: source.omittedFiles ?? 0,
      personalOnly: source.personalOnly ?? false,
      candidateOverflow:
        (source.outsideCandidateWindow ?? 0) + Math.max(0, source.rows.length - MAX_AUTOMATIC_ROWS),
    },
  };
}

export type AutomaticContextDiagnostics = ReturnType<typeof compactAutomaticContext>["diagnostics"];

export function reportAutomaticContext(diagnostics: AutomaticContextDiagnostics): void {
  if (process.env[HOOK_DEBUG_ENV]) {
    process.stderr.write(
      JSON.stringify({ event: "engram.automatic-context", ...diagnostics }) + "\n",
    );
  }
}
