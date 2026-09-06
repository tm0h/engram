/**
 * Pure, dependency-free text normalization and query tokenization (ENG-21).
 *
 * `normalizeText` is the one shared Unicode fold for BOTH sides of matching:
 * queries are tokenized with it, and every indexed field (title, body, type,
 * tags) must be folded with it before token or substring comparison. The
 * fold is NFKD, then strip combining marks only directly after a Latin
 * letter, then NFC, then lowercase. It is identity-plus-lowercase for ASCII,
 * so ASCII matching behavior is unchanged.
 *
 * Caveats: (1) NFKD can change string length (e.g. accented letters
 * decompose, ligatures expand), so there is no index alignment between raw
 * input and folded output. (2) German sharp-s is not folded: "strasse"
 * never matches "Strasse", because NFKD does not decompose the character;
 * this is symmetric on query and document sides. (3) Diacritic marks are
 * only stripped directly after a Latin letter, so Cyrillic, Greek, Arabic,
 * Indic, and CJK text passes through without data loss.
 *
 * `tokenizeQuery` turns a free-form query into deterministic search tokens
 * for the retrieval integration (the ENG-8/ENG-11-gated consumer). It never
 * throws and never performs I/O; same input always yields the same output.
 *
 * Token contract:
 *   1. The query is split into raw terms on whitespace.
 *   2. Terms with no letter, digit, or mark after edge-trimming are dropped;
 *      empty, whitespace-only, and punctuation-only queries therefore
 *      yield [].
 *   3. Each term is edge-trimmed (leading and trailing non-letter characters
 *      removed, e.g. "@" in "@engram/core", "--" in "--save-dev") and emitted
 *      first as its exact whole form: internal separators (., /, _, -, :) are
 *      preserved, and letters are normalized with normalizeText.
 *   4. Expanded subtokens follow the exact form, in order:
 *        a. the term is split on separator runs (any run of characters that
 *           is not a letter, digit, or mark); each piece is case-split on
 *           camelCase/PascalCase boundaries (lowercase or digit followed by
 *           uppercase) and acronym runs, and each word is normalized with
 *           normalizeText;
 *        b. if the term's last "/" segment contains a dot, the normalized
 *           basename is also emitted, so search.ts stays a unit alongside
 *           its parts.
 *      Acronym-run rule: a split between two uppercase letters happens only
 *      when at least two lowercase letters follow (parseURLConfig ->
 *      parse | URL | Config, IDsTable -> ids | table, IPv4Address ->
 *      ipv4 | address), while URLs stays whole; digits end the run
 *      (URLs2Table -> urls2 | table).
 *   5. The output is deduplicated across the whole query, first occurrence
 *      winning; ordering is otherwise stable (query order, exact form before
 *      its subtokens).
 */

const LETTERISH = /[\p{L}\p{N}\p{M}]/u;
const UPPER = /\p{Lu}/u;
const LOWERISH = /[\p{Ll}\p{Lo}]/u;
const MARK = /\p{M}/u;
const LATIN = /\p{Script=Latin}/u;
const SEPARATOR_RUN = /[^\p{L}\p{N}\p{M}]+/u;
const WHITESPACE_RUN = /\s+/u;

const isUpper = (s: string | undefined): boolean => s !== undefined && UPPER.test(s);
const isLowerish = (s: string | undefined): boolean => s !== undefined && LOWERISH.test(s);
const isLetterish = (s: string | undefined): boolean => s !== undefined && LETTERISH.test(s);

/** The shared Unicode fold (query side and indexed-field side): NFKD,
 * fold Latin diacritics, NFC-recompose, lowercase. */
export function normalizeText(raw: string): string {
  const decomposed = raw.normalize("NFKD");
  let folded = "";
  let prevLatinLetter = false;
  for (const ch of decomposed) {
    if (MARK.test(ch) && prevLatinLetter) continue;
    folded += ch;
    prevLatinLetter = LATIN.test(ch);
  }
  return folded.normalize("NFC").toLowerCase();
}

/** Length of the lowercase-letter run starting at `from`; uppercase and
 * digits end the run. */
function lowerishRunLength(chars: ReadonlyArray<string>, from: number): number {
  let n = 0;
  while (from + n < chars.length && isLowerish(chars[from + n])) n++;
  return n;
}

/** Split one separator-free piece into words on case boundaries. */
function splitWords(component: string): string[] {
  const chars = Array.from(component);
  const words: string[] = [];
  let start = 0;
  for (let i = 1; i < chars.length; i++) {
    const camelBoundary = isUpper(chars[i]) && !isUpper(chars[i - 1]);
    const acronymBoundary =
      isUpper(chars[i]) && isUpper(chars[i - 1]) && lowerishRunLength(chars, i + 1) >= 2;
    if (camelBoundary || acronymBoundary) {
      words.push(chars.slice(start, i).join(""));
      start = i;
    }
  }
  if (start < chars.length) words.push(chars.slice(start).join(""));
  return words;
}

/**
 * Tokenize a query per the module contract: for every whitespace term, the
 * normalized exact whole form first, then its expanded subtokens; duplicates
 * removed across the whole output, first occurrence kept; [] for queries with
 * no usable terms. Never throws.
 */
export function tokenizeQuery(query: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const push = (token: string): void => {
    if (token !== "" && !seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  };
  for (const term of query.split(WHITESPACE_RUN)) {
    if (term === "") continue;
    const chars = Array.from(term);
    let start = 0;
    let end = chars.length;
    while (start < end && !isLetterish(chars[start])) start++;
    while (end > start && !isLetterish(chars[end - 1])) end--;
    if (start >= end) continue;
    const raw = chars.slice(start, end).join("");
    push(normalizeText(raw));
    for (const component of raw.split(SEPARATOR_RUN)) {
      if (component === "") continue;
      for (const word of splitWords(component)) push(normalizeText(word));
    }
    const lastSlash = raw.lastIndexOf("/");
    const basename = lastSlash === -1 ? raw : raw.slice(lastSlash + 1);
    if (basename.includes(".")) push(normalizeText(basename));
  }
  return tokens;
}
