import type { Engram, Scope } from "@engram/core";
import { bootstrapCandidates } from "./bootstrap.js";

export const CONTEXT_TOKEN_METHOD = "utf8-nfkd-bytes-v1";
// Leaves room for maximum-width counters, a continuation call and the first entry's identity.
export const MIN_CONTEXT_TOKENS = 512;

export function contextTokenError(value: number): string | undefined {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return "tokens must be a positive safe integer, for example 4000";
  }
  if (value < MIN_CONTEXT_TOKENS) {
    return `tokens must be at least ${MIN_CONTEXT_TOKENS} to fit the context header and diagnostics`;
  }
}

/** Reuse bootstrap priority among eligible manual results, then keep retrieval order. */
export function prioritizeContext(entries: ReadonlyArray<Engram>): Engram[] {
  const { candidates } = bootstrapCandidates(entries, {
    now: 0, // Eligibility has already been resolved by the caller.
    includeInactive: true,
    includeScoped: true,
  });
  const curated = new Set(candidates.map(({ entry }) => entry));
  return [...curated, ...entries.filter((entry) => !curated.has(entry))];
}

function pointCost(point: string): number {
  if (point.charCodeAt(0) < 128) return 1;
  return Math.max(Buffer.byteLength(point), Buffer.byteLength(point.normalize("NFKD")));
}

export function countContextTokens(text: string): number {
  let cost = 0;
  for (const point of text) cost += pointCost(point);
  return cost;
}

/** The longest prefix within the allowance, measured on Unicode scalar boundaries. */
function fitPrefix(text: string, allowance: number): { end: number; cost: number } {
  let end = 0;
  let cost = 0;
  for (const point of text) {
    const next = cost + pointCost(point);
    if (next > allowance) break;
    cost = next;
    end += point.length;
  }
  return { end, cost };
}

interface ContextBudgetOptions {
  readonly tokens: number;
  readonly maxTokens?: number;
  readonly scopes: ReadonlyArray<Scope>;
  readonly query?: boolean;
  readonly full?: boolean;
  readonly personalOnly?: boolean;
  readonly omittedFiles: number;
  readonly duplicateIds: number;
  readonly limited?: number;
  readonly trailingNewline?: boolean;
  readonly pagination?: {
    offset: number;
    total: number;
    nextCall: (offset: number) => string;
  };
}

const ENTRY_SEPARATOR = "\n\n";
const TRUNCATION_MARKER = " … [truncated]";

export function renderBudgetedContext(entries: ReadonlyArray<Engram>, opts: ContextBudgetOptions) {
  const effective = Math.min(opts.tokens, opts.maxTokens ?? opts.tokens);
  // Keep required headers independent of user-controlled query and path lengths.
  const heading = `# Engram context (${opts.scopes.join(" + ")}${opts.query ? "; query matches" : ""})`;
  const preamble = [heading];
  if (opts.personalOnly) preamble.push("No project found; showing personal memory.");
  if (opts.omittedFiles || opts.duplicateIds) {
    preamble.push(
      `WARNING: skipped files: ${opts.omittedFiles}; duplicate ids: ${opts.duplicateIds}. Run engram check --scope all.`,
    );
  }
  const header = preamble.join("\n");
  const diagnostics = (shown: number, omitted: number, truncated: number) =>
    `Shown: ${shown}; budget omissions: ${omitted}; truncated: ${truncated}` +
    (opts.limited ? `; excluded by limit: ${opts.limited}` : "") +
    ".";
  const page = opts.pagination;
  const continuation = (offset: number) => (page ? `\nMore: ${page.nextCall(offset)}` : "");
  const lastNextOffset = page ? Math.min(page.total - 1, page.offset + entries.length) : 0;
  // Reserve the largest possible counts and continuation offset before fitting any entry.
  const reservedFooter =
    diagnostics(entries.length, entries.length, 1) +
    (page && lastNextOffset > page.offset ? continuation(lastNextOffset) : "");
  let remaining =
    effective -
    countContextTokens(header + ENTRY_SEPARATOR + reservedFooter) -
    (opts.trailingNewline ? 1 : 0);

  const rendered: string[] = [];
  let truncated = 0;
  const markerCost = countContextTokens(TRUNCATION_MARKER);
  for (const entry of entries) {
    const identity = `${entry.pinned ? "★ " : ""}[${entry.id}] ${entry.scope} ${entry.type}`;
    const tags = entry.tags.map((tag) => ` #${tag}`).join("");
    const summary = ` ${entry.title}${tags}`;
    const content =
      opts.full || opts.query
        ? `${summary}\n${entry.updated.slice(0, 10)}${entry.author ? ` · ${entry.author}` : ""}\n\n${entry.body || "_(no body)_"}`
        : summary;
    // With the Unicode flag this only replaces unpaired UTF-16 surrogates.
    const body = content.replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
    const available = remaining - countContextTokens(ENTRY_SEPARATOR + identity);
    const fit = fitPrefix(body, available);
    if (fit.end === body.length) {
      rendered.push(identity + body);
      remaining = available - fit.cost;
      continue;
    }
    // A later entry can start the next tool page with its full allowance.
    // A CLI digest is a single result, so use its remaining space for a prefix.
    if ((!page || !rendered.length) && available >= markerCost) {
      const prefix = fitPrefix(body, available - markerCost);
      rendered.push(identity + body.slice(0, prefix.end) + TRUNCATION_MARKER);
      truncated = 1;
    }
    break;
  }

  const shown = rendered.length;
  const omitted = entries.length - shown;
  const nextOffset =
    page && shown > 0 && page.offset + shown < page.total ? page.offset + shown : null;
  const footer =
    diagnostics(shown, omitted, truncated) + (nextOffset === null ? "" : continuation(nextOffset));
  const text = [header, ...rendered, footer].join(ENTRY_SEPARATOR);
  return {
    text,
    nextOffset,
    budget: {
      method: CONTEXT_TOKEN_METHOD,
      requested: opts.tokens,
      effective,
      used: countContextTokens(text) + (opts.trailingNewline ? 1 : 0),
      shown,
      omitted,
      truncated,
    },
  };
}
