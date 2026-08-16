/** Pagination + size-capping helpers. Pure; no I/O, no services. */

/** Hard backstop for any single tool result (~8 kB). */
export const MAX_RESULT_CHARS = 8192;

export interface Page<T> {
  readonly items: ReadonlyArray<T>;
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly nextOffset: number | null;
}

/** Window `items` by 0-based `offset`/`limit`. */
export function paginate<T>(items: ReadonlyArray<T>, offset = 0, limit = items.length): Page<T> {
  const off = Math.max(0, Math.floor(offset));
  const lim = Math.max(0, Math.floor(limit));
  const page = items.slice(off, off + lim);
  const next = off + lim;
  return {
    items: page,
    total: items.length,
    offset: off,
    limit: lim,
    nextOffset: page.length > 0 && next < items.length ? next : null,
  };
}

/** Cap a rendered result; flags truncation so callers can add a pointer. */
export function capText(
  text: string,
  max = MAX_RESULT_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

export interface FooterArgs {
  /** 1-based index of the first shown item. */
  readonly from: number;
  /** 1-based index of the last shown item. */
  readonly to: number;
  readonly total: number;
  readonly nextOffset: number | null;
  /** Pre-rendered next call, e.g. `engram_context({"offset":25})`. */
  readonly nextCall?: string;
}

/** Render the "(showing X-Y of N …)" footer line. */
export function pageFooter(args: FooterArgs): string {
  const base = `(showing ${args.from}-${args.to} of ${args.total})`;
  if (args.nextOffset === null || !args.nextCall) return base;
  return `${base.slice(0, -1)} - call ${args.nextCall} for more)`;
}
