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
    // P2 efficiency: render each row of the window exactly once (see the
    // linksOp comment in packages/harnesses/src/shared/ops.ts for the join
    // structure the composer mirrors). The empty-window path (offset past
    // total, R13 note) still renders through renderLinks directly.
    const emptyPage = renderLinks(adjacency, { offset: start, total, rows: [] });
    const headerBlock = emptyPage.slice(0, emptyPage.indexOf("\n\n"));
    const rendered = pageRows.map((row) => {
      const single = renderLinks(adjacency, { offset: start, total, rows: [row] });
      const section = row.direction === "outgoing" ? "Outgoing" : "Incoming";
      return {
        direction: row.direction,
        text: single.slice(headerBlock.length + 2 + section.length + 1),
      };
    });
    const compose = (emitted: number): string => {
      const parts: string[] = [headerBlock];
      let prev: LinksRow["direction"] | null = null;
      for (const row of rendered.slice(0, emitted)) {
        if (row.direction !== prev) {
          parts.push("", row.direction === "outgoing" ? "Outgoing" : "Incoming");
          prev = row.direction;
        }
        parts.push(row.text);
      }
      return parts.join("\n");
    };
    // cum[k] = length of compose(k); exact join arithmetic, computed once.
    const cum: number[] = [headerBlock.length];
    {
      let acc = headerBlock.length;
      let prev: LinksRow["direction"] | null = null;
      for (const row of rendered) {
        acc += row.direction === prev ? 1 + row.text.length : 11 + row.text.length;
        prev = row.direction;
        cum.push(acc);
      }
    }
    const budgetFor = (emitted: number): number => {
      const footer = footerFor(emitted);
      return footer === null
        ? MAX_RESULT_CHARS - RESULT_MARKER.length - 1
        : MAX_RESULT_CHARS - footer.length - LINKS_TRUNCATION_MARKER.length - 2;
    };
    const joinedFor = (emitted: number): string => {
      const body = emitted === 0 ? emptyPage : compose(emitted);
      return warnings.length > 0 ? [body, ...warnings].join("\n\n") : body;
    };

    // Empty window: no rows, no trim, no footer (R13 offset note).
    if (pageRows.length === 0) {
      const capped = capTo(joinedFor(0), MAX_RESULT_CHARS - RESULT_MARKER.length - 1);
      yield* out(capped.truncated ? `${capped.text}\n${RESULT_MARKER}` : capped.text);
      return;
    }

    // Largest fully-emitted prefix: scan down from the full window while the
    // composed page overflows its budget. If even one row overflows the page
    // alone, the forced branch caps compose(1) with the bounded marker and
    // advances exactly one row - deterministic, never zero.
    let emitted = pageRows.length;
    while (emitted > 1 && cum[emitted]! > budgetFor(emitted)) emitted -= 1;
    const footer = footerFor(emitted);
    let text: string;
    if (cum[emitted]! <= budgetFor(emitted)) {
      const joined = joinedFor(emitted);
      text = footer === null ? joined : `${joined}\n${footer}`;
    } else {
      // emitted === 1 and it alone overflows the page.
      const joined = joinedFor(1);
      if (footer === null) {
        const capped = capTo(joined, MAX_RESULT_CHARS - RESULT_MARKER.length - 1);
        text = `${capped.text}\n${RESULT_MARKER}`;
      } else {
        const capped = capTo(
          joined,
          MAX_RESULT_CHARS - footer.length - LINKS_TRUNCATION_MARKER.length - 2,
        );
        text = `${capped.text}\n${footer}\n${LINKS_TRUNCATION_MARKER}`;
      }
    }

    yield* out(text);
  });
