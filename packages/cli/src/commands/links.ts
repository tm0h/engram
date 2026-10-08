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
    const nextOffset =
      pageRows.length > 0 && start + limit < total ? start + limit : null;

    let body = renderLinks(adjacency, { offset: start, total, rows: pageRows });
    const warnings: string[] = [];
    if (scanned.omittedFiles > 0) {
      warnings.push(
        `WARNING: Engram memory is incomplete. Skipped ${scanned.omittedFiles} unreadable or invalid ${
          scanned.omittedFiles === 1 ? "file" : "files"
        }. Run \`engram check --scope all\` for exact paths and repair guidance.`,
      );
    }
    if (scanned.diagnostics.length > 0) {
      const n = scanned.diagnostics.length;
      warnings.push(
        `${n} store diagnostic${n === 1 ? "" : "s"} on sibling files; valid links above. ` +
          "Run `engram check --scope all` for exact paths.",
      );
    }

    let footer: string | null = null;
    if (nextOffset !== null && pageRows.length > 0) {
      // CLI form in the continuation (R9): this command has no LLM tool.
      const parts = [`engram links ${id}`];
      if (opts.scope !== undefined) parts.push(`--scope ${opts.scope}`);
      parts.push(`--offset ${nextOffset}`);
      if (opts.limit !== undefined) parts.push(`--limit ${opts.limit}`);
      footer =
        `(showing ${start + 1}-${start + pageRows.length} of ${total} - ` +
        `call ${parts.join(" ")} for more)`;
    }

    let text: string;
    if (footer === null) {
      const joined = [body, ...warnings].join("\n\n");
      text =
        joined.length > MAX_RESULT_CHARS
          ? `${joined.slice(0, MAX_RESULT_CHARS)}\n(result truncated)`
          : joined;
    } else {
      const joined = [body, ...warnings].join("\n\n");
      const max = MAX_RESULT_CHARS - footer.length - LINKS_TRUNCATION_MARKER.length - 2;
      text =
        joined.length > max
          ? `${joined.slice(0, max)}\n${footer}\n${LINKS_TRUNCATION_MARKER}`
          : `${joined}\n${footer}`;
    }

    yield* out(text);
  });
