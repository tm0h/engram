/**
 * Small standalone utilities.
 */
import { Effect } from "effect";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";

/** Crockford base32, lowercase (filesystem-safe, no i/l/o/u). */
const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";

let lastTime = -1;
let lastRandom = "";

const encodeTime = (t: number): string => {
  let s = "";
  for (let i = 0; i < 10; i++) {
    s = BASE32[t % 32] + s;
    t = Math.floor(t / 32);
  }
  return s;
};

/** Increment a base32 string by one (big-endian, with carry). */
const incrementBase32 = (s: string): string => {
  const chars = s.split("");
  for (let i = chars.length - 1; i >= 0; i--) {
    const v = BASE32.indexOf(chars[i]);
    if (v < 31) {
      chars[i] = BASE32[v + 1];
      return chars.join("");
    }
    chars[i] = "0";
  }
  return "0".repeat(s.length);
};

/**
 * A ULID-style identifier: 10 chars of millisecond timestamp + 16 chars of
 * randomness, lowercase base32.
 *
 * Properties that matter here:
 * - **Globally unique without coordination** — any machine, session, or CI
 *   run can mint ids concurrently; merged branches can never collide on id.
 * - **Lexicographically sortable** — sort order equals creation order, so
 *   listing needs no shared counter. Within one process ids are strictly
 *   monotonic (same-millisecond draws increment the random part).
 *
 * Legacy stores use 4-digit numeric ids ("0001"); both formats coexist.
 */
export const newId = (): string => {
  // A backwards clock step (NTP correction, VM resume) must not produce a
  // smaller id than the last one issued — clamp to the high-water mark.
  const t = Math.max(Date.now(), lastTime);
  if (t === lastTime && lastRandom) {
    lastRandom = incrementBase32(lastRandom);
    return encodeTime(t) + lastRandom;
  }
  lastTime = t;
  let n = 0n;
  for (const b of randomBytes(10)) n = (n << 8n) | BigInt(b);
  let s = "";
  for (let i = 0; i < 16; i++) {
    s = BASE32[Number(n & 31n)] + s;
    n >>= 5n;
  }
  lastRandom = s;
  return encodeTime(t) + s;
};

export const nowISO = (): string => new Date().toISOString();

export const slugify = (input: string): string => {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "engram";
};

export const parseTags = (input?: string): ReadonlyArray<string> => {
  if (!input) return [];
  return Array.from(
    new Set(
      input
        .split(/[,\s]+/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
};

/* ------------------------------ aliases ------------------------------ */

/** ENG-46: the maximum number of unique aliases one entry may hold. */
export const MAX_ALIASES = 20;

/** ENG-46: the maximum length of one alias, counted in Unicode code points
 * AFTER trimming (via `Array.from(value).length`, never UTF-16 units). */
export const MAX_ALIAS_LENGTH = 80;

/** One rejected alias list: a stable, repair-focused message and hint.
 * Wording is generated only here, so the frontmatter scan, the store write
 * boundary, the CLI, slash commands, and the shared ops all show identical
 * text for the same defect. */
export interface AliasIssue {
  readonly message: string;
  readonly hint: string;
}

const aliasDescribe = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "a sequence" : `a ${typeof v}`;

const aliasQuote = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s === undefined ? aliasDescribe(v) : s;
};

const ALIAS_LIST_HINT = "Write aliases as a list of strings, e.g. aliases: [postgres, psql].";

/** ENG-46: normalize alias members — trim surrounding whitespace, lowercase,
 * deduplicate while keeping the first occurrence. Internal whitespace is
 * preserved and values are never split on spaces. Pure.
 *
 * This transform never drops a member, not even an empty one: emptiness and
 * the caps are validated separately by `validateAliases`, so nothing is ever
 * silently discarded. Callers validate first; the write boundary owns that
 * ordering. */
export const normalizeAliases = (values: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const alias = value.trim().toLowerCase();
    if (!seen.has(alias)) {
      seen.add(alias);
      out.push(alias);
    }
  }
  return out;
};

/** ENG-46: validate raw alias members against the one alias contract. Every
 * member must be a string that is non-empty after trimming, and its
 * NORMALIZED form (post-trim, post-lowercase) must be at most
 * `MAX_ALIAS_LENGTH` code points long — lowercasing can expand a value
 * (e.g. U+0130 doubles), so the cap measures what would actually be stored
 * (R17a). The list may hold at most `MAX_ALIASES` unique normalized values;
 * the count rule dedupes through `normalizeAliases` itself (R12), so read
 * and write sides share a single predicate and duplicates count once.
 * Member issues come back in list order, then the count issue. Pure. */
export const validateAliases = (values: ReadonlyArray<unknown>): ReadonlyArray<AliasIssue> => {
  const issues: AliasIssue[] = [];
  const valid: string[] = [];
  for (const [position, member] of values.entries()) {
    if (typeof member !== "string") {
      issues.push({
        message: `aliases (position ${position + 1}) must be a string, got ${aliasDescribe(member)}`,
        hint: ALIAS_LIST_HINT,
      });
      continue;
    }
    const trimmed = member.trim();
    if (trimmed === "") {
      issues.push({
        message: `aliases (position ${position + 1}) is empty after trimming`,
        hint: 'Aliases must be non-empty: remove the empty values, or remove the whole "aliases" line.',
      });
      continue;
    }
    const normalized = trimmed.toLowerCase();
    const length = Array.from(normalized).length;
    if (length > MAX_ALIAS_LENGTH) {
      issues.push({
        message: `aliases ${aliasQuote(normalized)} (position ${position + 1}) is longer than ${MAX_ALIAS_LENGTH} code points (${length})`,
        hint: `Shorten the alias to at most ${MAX_ALIAS_LENGTH} characters after lowercasing (Unicode code points, not bytes).`,
      });
      continue;
    }
    valid.push(trimmed);
  }
  const unique = normalizeAliases(valid);
  if (unique.length > MAX_ALIASES) {
    issues.push({
      message: `aliases lists ${unique.length} unique values; the maximum is ${MAX_ALIASES}`,
      hint: `Keep at most ${MAX_ALIASES} unique aliases; duplicates are counted once after lowercasing and trimming.`,
    });
  }
  return issues;
};

/** ENG-46: split one raw comma-separated alias value (a CLI flag, a slash
 * flag, or an interactive editor line) into members. This is NEW parsing,
 * deliberately unlike `parseTags` above: it cuts on commas ONLY (never on
 * whitespace, so multiword aliases survive) and PRESERVES empty members so
 * the core write boundary can reject them — an empty alias must fail, never
 * disappear. Members are trimmed so an editor round-trip parses back to the
 * exact stored values; emptiness and the caps stay the core boundary's job.
 * `undefined` (flag absent) stays `undefined`; a present value always yields
 * at least one member. Pure. */
export const splitAliasList = (raw: string | undefined): ReadonlyArray<string> | undefined =>
  raw === undefined ? undefined : raw.split(",").map((member) => member.trim());

export const padId = (n: number): string => String(n).padStart(4, "0");

/* ------------------------------ ids ------------------------------ */

/** Legacy ids are exactly four decimal digits; generated ids are exactly
 * 26 lowercase Crockford-base32 characters (see `newId`). */
const LEGACY_ID = /^\d{4}$/;
const ULID_ID = /^[0-9a-hjkmnp-tv-z]{26}$/;

export const isValidId = (id: string): boolean => LEGACY_ID.test(id) || ULID_ID.test(id);

/** Decompose a `<id>-<slug>.md` basename into its parts. Returns undefined
 * when the name does not follow the generated shape (a valid id part plus a
 * non-empty slug part). Pure string math; no filesystem access. */
export const parseEntryFilename = (
  basename: string,
): { readonly id: string; readonly slug: string } | undefined => {
  const m = /^([^-]+)-(.+)\.md$/.exec(basename);
  if (!m) return undefined;
  const [, idPart, slugPart] = m;
  return isValidId(idPart) ? { id: idPart, slug: slugPart } : undefined;
};

/* --------------------------- timestamps --------------------------- */

/** Accepted timestamp form: ISO 8601 date-time with an explicit zone,
 * `Z` (what `nowISO()` writes) or a numeric `±hh:mm` offset. Date-only and
 * zone-less strings are not accepted. */
const ISO_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
};

/** Epoch millis for an accepted ISO timestamp, or undefined when the value
 * is not in the accepted form or not a real date/time. `Date.parse` alone
 * silently normalizes impossible dates (Feb 30 becomes Mar 2), so the
 * calendar and clock components are validated explicitly. */
export const parseTimestamp = (value: string): number | undefined => {
  const m = ISO_TIME.exec(value);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return undefined;
  }
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  if (m[8] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
};

export const numericId = (id: string): number => {
  const n = parseInt(id, 10);
  return Number.isFinite(n) ? n : 0;
};

export const truncate = (s: string, n: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
};

/** Best-effort author detection via git config, falling back to env. */
export const detectAuthor = (): Effect.Effect<string> =>
  Effect.sync(() => {
    try {
      const name = execSync("git config user.name", {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      if (name) return name;
    } catch {
      /* ignore */
    }
    return process.env.USER || process.env.USERNAME || "unknown";
  });
