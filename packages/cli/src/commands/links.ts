/** `engram links <id>` — the link graph around one entry (ENG-45).
 *
 * Mirrors the shared `linksOp` contract through `@engram/core` only: exact
 * ids, one scope (explicit flag wins, else project in a project / personal
 * outside), exactly one scan feeding `computeLinkAdjacency`, missing and
 * ambiguous targets as structured states, and private pagination over the
 * flattened outgoing-then-incoming row stream with the same hard cap. No
 * prefix lookup, no cross-scope fallback, no writes. */
import { Effect } from "effect";
import {
  EngramStore,
  computeLinkAdjacency,
  incompleteMemoryWarning,
  isValidScopeArg,
  renderLinks,
  resolveScope,
  type LinksRow,
} from "@engram/core";
import { out } from "../io.js";

/** Keep in sync with MAX_RESULT_CHARS in packages/harnesses/src/shared/pagination.ts. */
const MAX_RESULT_CHARS = 8192;
/** Keep in sync with DEFAULT_SEARCH_LIMIT in packages/harnesses/src/shared/ops.ts. */
const DEFAULT_SEARCH_LIMIT = 10;
/** ENG-45 R8: keep in sync with MAX_LINKS_LIMIT in
 * packages/harnesses/src/shared/pagination.ts (no harness import here, so the
 * bound is mirrored; process tests pin both surfaces to the same value). */
export const MAX_LINKS_LIMIT = 100;

const LINKS_TRUNCATION_MARKER = "(list truncated to fit the size cap)";

/** F1: marker for the capped no-footer branch, reserved the same way the
 * footer branch reserves the footer (keep in sync with linksOp's marker). */
const RESULT_MARKER = "(result truncated)";

/** Same contract as the shared capText: pass text through at or below `max`,
 * slice and flag when it overflows. */
const capTo = (text: string, max: number): { text: string; truncated: boolean } =>
  text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };

export const linksCommand = (
  id: string,
  opts: { scope?: string; offset?: number; limit?: number } = {},
) =>
  Effect.gen(function* () {
    // Validation happens before any store access, with the same bounds the
    // commander flag validators and the Pi links parser enforce.
    if (opts.scope !== undefined && !isValidScopeArg(opts.scope)) {
      return yield* Effect.fail(new Error('scope must be "project" or "personal"'));
    }
    const offset = Math.floor(opts.offset ?? 0);
    const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      return yield* Effect.fail(new Error("offset must be a nonnegative safe integer"));
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      return yield* Effect.fail(new Error("limit must be a positive safe integer"));
    }
    if (limit > MAX_LINKS_LIMIT) {
      return yield* Effect.fail(new Error(`limit must be at most ${MAX_LINKS_LIMIT}`));
    }

    const store = yield* EngramStore;
    const projectRoot = yield* store.projectRoot();
    // Exact-id graph semantics: no prefix lookup. An explicit project scope
    // outside a project fails the scan with ProjectNotInitializedError, which
    // the run() path renders uniformly like every other domain error.
    const scope = resolveScope(opts.scope, projectRoot);

    // One scan per query; the same StoreScan feeds adjacency.
    const scanned = yield* store.scan(scope);
    const adjacency = computeLinkAdjacency(scanned, id);

    // Private pagination over the flattened outgoing-then-incoming stream
    // (same math as the shared paginate helper).
    const rows: LinksRow[] = [
      ...adjacency.outgoing.map((resolution) => ({
        direction: "outgoing" as const,
        resolution,
      })),
      ...adjacency.incoming.map((entry) => ({ direction: "incoming" as const, entry })),
    ];
    const total = rows.length;
    const start = Math.max(0, offset);
    const pageRows = rows.slice(start, start + limit);

    const warnings: string[] = [];
    if (scanned.omittedFiles > 0) {
      warnings.push(incompleteMemoryWarning(scanned.omittedFiles));
    }
    if (scanned.diagnostics.length > 0) {
      const n = scanned.diagnostics.length;
      warnings.push(
        `${n} store diagnostic${n === 1 ? "" : "s"} on sibling files; valid links above. ` +
          "Run `engram check --scope all` for exact paths.",
      );
    }

    // P1a: the continuation points at the first row NOT fully emitted. The
    // footer and offset derive from `emitted`, not from the requested window.
    const footerFor = (emitted: number): string | null => {
      const next = start + emitted;
      if (emitted === 0 || next >= total) return null;
      // CLI form in the continuation (R9): this command has no LLM tool.
      const parts = [`engram links ${id}`];
      if (opts.scope !== undefined) parts.push(`--scope ${opts.scope}`);
      parts.push(`--offset ${next}`);
      if (opts.limit !== undefined) parts.push(`--limit ${opts.limit}`);
      return `(showing ${start + 1}-${next} of ${total} - call ${parts.join(" ")} for more)`;
    };
    const joinedFor = (emitted: number): string => {
      const body = renderLinks(adjacency, {
        offset: start,
        total,
        rows: pageRows.slice(0, emitted),
      });
      return warnings.length > 0 ? [body, ...warnings].join("\n\n") : body;
    };
    const assemble = (emitted: number): { text: string; truncated: boolean } => {
      const footer = footerFor(emitted);
      const joined = joinedFor(emitted);
      if (footer === null) {
        const capped = capTo(joined, MAX_RESULT_CHARS - RESULT_MARKER.length - 1);
        return {
          text: capped.truncated ? `${capped.text}\n${RESULT_MARKER}` : capped.text,
          truncated: capped.truncated,
        };
      }
      const capped = capTo(
        joined,
        MAX_RESULT_CHARS - footer.length - LINKS_TRUNCATION_MARKER.length - 2,
      );
      return {
        text: capped.truncated
          ? `${capped.text}\n${footer}\n${LINKS_TRUNCATION_MARKER}`
          : `${joined}\n${footer}`,
        truncated: capped.truncated,
      };
    };

    // Trim while the cap cuts content so cut rows are never skipped; if even
    // one row overflows the page alone, assemble(1) is already bounded and
    // the advance is exactly one row - deterministic, never zero.
    let emitted = pageRows.length;
    let assembled = assemble(emitted);
    while (assembled.truncated && emitted > 1) {
      emitted -= 1;
      assembled = assemble(emitted);
    }

    yield* out(assembled.text);
  });
