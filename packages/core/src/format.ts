/**
 * Output formatting helpers. All return plain strings; chalk handles TTY vs
 * piped automatically (colors are stripped when output is not a TTY).
 */
import chalk from "chalk";
import type { Engram, EngramType } from "./domain.js";
import type { SearchResult } from "./search.js";
import { truncate } from "./util.js";

function typeColor(type: EngramType): string {
  switch (type) {
    case "decision":
      return chalk.magenta(type);
    case "fact":
      return chalk.cyan(type);
    case "preference":
      return chalk.blue(type);
    case "issue":
      return chalk.red(type);
    case "context":
      return chalk.green(type);
    default:
      return chalk.gray(type);
  }
}

function dateShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function tagsStr(tags: ReadonlyArray<string>): string {
  if (!tags.length) return "";
  return " " + tags.map((t) => chalk.gray(`#${t}`)).join(" ");
}

/** One-line summary used by `list` and `context` digests. */
export function summaryLine(m: Engram): string {
  const pin = m.pinned ? chalk.yellow("★ ") : "  ";
  return `${pin}${chalk.bold(m.id)} ${typeColor(m.type)} ${m.title}${tagsStr(m.tags)}`;
}

/** Render the `list` view. */
export function renderList(engrams: ReadonlyArray<Engram>): string {
  if (!engrams.length) return chalk.gray("(no engrams)");
  return engrams
    .map((m) => {
      const line = summaryLine(m);
      const meta = chalk.gray(`      ${dateShort(m.updated)}${m.author ? ` · ${m.author}` : ""}`);
      const preview = m.body ? chalk.gray(`      ${truncate(m.body, 90)}`) : "";
      return `${line}\n${meta}${preview ? "\n" + preview : ""}`;
    })
    .join("\n");
}

/** Render a single engram in full (the `show` view). */
export function renderFull(m: Engram): string {
  // Lifecycle/provenance block: only defined values get labels, so old
  // entries render exactly as before. reviewAfter/expires are shown as the
  // exact stored instants, never date-shortened: the boundary is the
  // timestamp, not the day.
  const lifecycle: string[] = [];
  if (m.status !== undefined) lifecycle.push(`status: ${m.status}`);
  if (m.supersedes !== undefined) lifecycle.push(`supersedes: ${m.supersedes}`);
  /* ENG-42: one ordered line when the list is defined and non-empty; absent
   * and empty lists print nothing (an empty list is a stored value, but it
   * has nothing to show). */
  if (m.related !== undefined && m.related.length > 0) {
    lifecycle.push(`related: ${m.related.join(", ")}`);
  }
  if (m.reviewAfter !== undefined) lifecycle.push(`review-after: ${m.reviewAfter}`);
  if (m.expires !== undefined) lifecycle.push(`expires: ${m.expires}`);
  const source = [m.sourceType, m.sourceRef].filter((p) => p !== undefined).join(" · ");
  if (source !== "") lifecycle.push(`source: ${source}`);
  const block =
    lifecycle.length > 0 ? "\n" + chalk.gray(lifecycle.map((l) => `  ${l}`).join("\n")) : "";

  const head = [
    `${chalk.bold(m.id)} ${chalk.bold(m.title)}`,
    `${typeColor(m.type)}${tagsStr(m.tags)}${m.pinned ? " " + chalk.yellow("★ pinned") : ""}`,
    chalk.gray(
      `${dateShort(m.created)}${m.updated !== m.created ? ` (updated ${dateShort(m.updated)})` : ""}${m.author ? ` · ${m.author}` : ""}`,
    ),
  ].join("\n");
  return `${head}${block}\n\n${m.body || chalk.gray("(no body)")}`;
}

/** Render search results with scores. */
export function renderSearch(results: ReadonlyArray<SearchResult>): string {
  if (!results.length) return chalk.gray("(no matches)");
  return results
    .map(({ engram: m, score }) => {
      const line = summaryLine(m);
      const meta = chalk.gray(
        `      ${dateShort(m.updated)} · score ${score}${m.author ? ` · ${m.author}` : ""}`,
      );
      const preview = m.body ? chalk.gray(`      ${truncate(m.body, 100)}`) : "";
      return `${line}\n${meta}${preview ? "\n" + preview : ""}`;
    })
    .join("\n");
}

export interface ContextOpts {
  readonly query?: string;
  readonly full?: boolean;
  readonly scope: string;
  readonly root?: string | null;
}

/** Render an agent-ready context digest (the `context` command). */
export function renderContext(engrams: ReadonlyArray<Engram>, opts: ContextOpts): string {
  if (!engrams.length) {
    return chalk.gray(`No engrams in scope "${opts.scope}".`);
  }

  // Query mode: dump full bodies of matches.
  if (opts.query) {
    const header = `# Engram search: "${opts.query}" (${engrams.length})\n`;
    return (
      header +
      engrams
        .map(
          (m) =>
            `## [${m.id}] ${m.title}\n${m.type} · ${dateShort(m.updated)}${m.author ? ` · ${m.author}` : ""}${tagsStr(m.tags)}\n\n${m.body || "_(no body)_"}`,
        )
        .join("\n\n---\n\n")
    );
  }

  // Digest / full mode.
  const where =
    opts.scope === "personal"
      ? "personal engram (~/.engram)"
      : `project engram${opts.root ? ` (${opts.root})` : ""}`;
  const header = `# ${where}\n${engrams.length} engram${engrams.length === 1 ? "" : "s"}.`;

  if (opts.full) {
    return (
      header +
      "\n\n" +
      engrams
        .map(
          (m) =>
            `## [${m.id}] ${m.title}\n${m.type}${tagsStr(m.tags)} · ${dateShort(m.updated)}\n\n${m.body || "_(no body)_"}`,
        )
        .join("\n\n---\n\n")
    );
  }

  // Compact digest: group decisions/pinned first, then the rest.
  const decisions = engrams.filter((m) => m.type === "decision" || m.pinned);
  const rest = engrams.filter((m) => !(m.type === "decision" || m.pinned));
  const blocks: string[] = [];
  if (decisions.length) {
    blocks.push(`## Decisions & pinned\n${decisions.map(summaryLine).join("\n")}`);
  }
  if (rest.length) {
    blocks.push(`## Other\n${rest.map(summaryLine).join("\n")}`);
  }
  return `${header}\n\n${blocks.join("\n\n")}`;
}
