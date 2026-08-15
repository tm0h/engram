/**
 * Minimal YAML frontmatter parse/stringify — the engram file format.
 *
 * Format:
 *   ---
 *   <yaml>
 *   ---
 *   <markdown body>
 *
 * Rules:
 *   - The opening delimiter must be a bare `---` on the first line
 *     (a UTF-8 BOM is tolerated). Language tags (`---json`, …) are not
 *     part of the format and are treated as plain content.
 *   - The block closes with `---` or `...` on its own line, or at EOF.
 *   - Unterminated blocks are treated as plain content, not an error.
 *   - YAML resolves under js-yaml's `JSON_SCHEMA`: no YAML 1.1 booleans,
 *     no timestamps, no octals — strings stay strings in both directions.
 */
import { Result } from "effect";
import yaml from "js-yaml";

export interface ParsedFrontmatter {
  /** Whatever the YAML block resolved to; validating it is the caller's job. */
  readonly data: unknown;
  /** The markdown body below the closing delimiter. */
  readonly content: string;
}

/** Opening delimiter: `---` + optional trailing spaces at byte 0, then a
 * newline (or EOF). */
const OPEN = /^---[ \t]*(\r?\n|$)/;
/** Closing delimiter: `---` or `...` + optional trailing spaces on its own
 * line (or at EOF). */
const CLOSE = /^(?:---|\.\.\.)[ \t]*(\r?\n|$)/m;

/** Parse a raw engram file. Fails only when the YAML block itself is
 * malformed; anything else is data or content. */
export const parseFrontmatter = (raw: string): Result.Result<ParsedFrontmatter, string> => {
  const src = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const open = OPEN.exec(src);
  if (!open) return Result.succeed({ data: {}, content: src });

  const afterOpen = src.slice(open[0].length);
  const close = CLOSE.exec(afterOpen);
  if (!close) return Result.succeed({ data: {}, content: src });

  const yamlText = afterOpen.slice(0, close.index);
  const content = afterOpen.slice(close.index + close[0].length);
  try {
    const data = yaml.load(yamlText, { schema: yaml.JSON_SCHEMA });
    return Result.succeed({ data: data ?? {}, content });
  } catch (e) {
    return Result.fail(`invalid YAML: ${(e as Error).message}`);
  }
};

/** Render a file: YAML frontmatter above the body. Inverse of parse. */
export const stringifyFrontmatter = (
  content: string,
  data: Readonly<Record<string, unknown>>,
): string => {
  const y = yaml.dump(data, { schema: yaml.JSON_SCHEMA, quotingType: '"' });
  return `---\n${y}---\n${content}`;
};
