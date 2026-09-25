/**
 * Interactive helpers built on the platform Terminal service, plus the
 * $EDITOR flow for rich `engram add`. Every command also works fully
 * non-interactively (flags / stdin), so agents and CI are first-class.
 */
import { Effect } from "effect";
import { Terminal } from "effect/Terminal";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ValidationError } from "@engram/core";
import { parseRelatedIds } from "./related.js";

/** True when stdin is a TTY (i.e. a human is at the keyboard). */
export const isInteractive = (): Effect.Effect<boolean> =>
  Effect.sync(() => Boolean(process.stdin.isTTY));

export const promptText = (message: string, def?: string) =>
  Effect.gen(function* () {
    const t = yield* Terminal;
    const suffix = def ? ` [${def}]` : "";
    yield* t.display(`${message}${suffix}: `);
    const line = (yield* t.readLine).trim();
    return line || (def ?? "");
  });

export const promptConfirm = (message: string, def = false) =>
  Effect.gen(function* () {
    const t = yield* Terminal;
    const hint = def ? "Y/n" : "y/N";
    yield* t.display(`${message} (${hint}): `);
    const answer = (yield* t.readLine).trim().toLowerCase();
    if (!answer) return def;
    return /^[yt1]/.test(answer);
  });

export interface EditedEngram {
  readonly title: string;
  readonly type: string | undefined;
  readonly tags: ReadonlyArray<string>;
  readonly body: string;
  /* ENG-13 lifecycle fields; undefined means the line was absent or blank
   * (add: unset, edit: explicit clear via the command's diff). */
  readonly status?: string | undefined;
  readonly supersedes?: string | undefined;
  readonly reviewAfter?: string | undefined;
  readonly expires?: string | undefined;
  readonly sourceType?: string | undefined;
  readonly sourceRef?: string | undefined;
  /* ENG-42 same-scope related ids; undefined means the line was absent or
   * blank (add: no list, edit: explicit clear via the command's diff). */
  readonly related?: ReadonlyArray<string> | undefined;
  /* ENG-42 (turn 3): true only when the document had frontmatter but the
   * related line itself is missing. The renderer always writes the line, so
   * a missing line is an explicit user deletion, while a blank line is what
   * an unchanged save of a stored empty list looks like. */
  readonly relatedDeleted?: boolean | undefined;
}

/** Canonical camelCase lifecycle keys, matching the serialized file format
 * and the flag names' option properties. */
const LIFECYCLE_KEYS = [
  "status",
  "supersedes",
  "reviewAfter",
  "expires",
  "sourceType",
  "sourceRef",
] as const;

const BODY_PLACEHOLDER = "Write what should be remembered here.";

/** Render the editor document: a flat `key: value` frontmatter block above
 * the body. Lifecycle lines are always present (empty when unset) so the
 * key names are discoverable and blanking one is an explicit edit. The
 * ENG-42 `related` line follows the same rule: comma-separated ids, blank
 * means absent. Pure: `openEditor` wraps this with the temp file and editor
 * process. */
export const renderEditorDocument = (initial: Partial<EditedEngram> = {}): string => {
  const lifecycle = LIFECYCLE_KEYS.map((key) => {
    const value = initial[key];
    return `${key}:${value ? " " + value : ""}`;
  });
  const related = initial.related;
  return [
    "---",
    `title: ${initial.title ?? ""}`,
    `type: ${initial.type ?? "note"}`,
    `tags: ${(initial.tags ?? []).join(", ")}`,
    ...lifecycle,
    `related:${related !== undefined && related.length > 0 ? " " + related.join(", ") : ""}`,
    "---",
    "",
    initial.body ?? BODY_PLACEHOLDER,
    "",
  ].join("\n");
};

/** Parse a saved editor document back into fields. Splits each header line
 * at the FIRST colon, so timestamp offsets, URLs, and references containing
 * colons survive. Blank or missing lifecycle lines parse as undefined;
 * commands turn that into unset (add) or an explicit clear (edit). The
 * ENG-42 related line goes through the same parser as the CLI flags, so the
 * empty-token rule is identical (Q2): a blank line is absent and a non-blank
 * line with empty tokens throws a usage error before anything is written.
 * Pure. */
export const parseEditorDocument = (raw: string): EditedEngram => {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { title: "", type: undefined, tags: [], body: raw.trim() };
  const data: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > -1) data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const lifecycle = (key: (typeof LIFECYCLE_KEYS)[number]): string | undefined =>
    data[key] || undefined;
  const related = parseRelatedIds(data.related);
  if (related.kind === "invalid") {
    throw new ValidationError({ message: `invalid related line in the editor: ${related.reason}` });
  }
  return {
    title: data.title ?? "",
    type: data.type || undefined,
    tags: (data.tags ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    status: lifecycle("status"),
    supersedes: lifecycle("supersedes"),
    reviewAfter: lifecycle("reviewAfter"),
    expires: lifecycle("expires"),
    sourceType: lifecycle("sourceType"),
    sourceRef: lifecycle("sourceRef"),
    related: related.kind === "ids" ? related.ids : undefined,
    relatedDeleted: !("related" in data) || undefined,
    body: m[2].trim(),
  };
};

/** Open $EDITOR on a temp file pre-filled with frontmatter; parse on save. */
export const openEditor = (
  initial: Partial<EditedEngram> = {},
): Effect.Effect<EditedEngram | null> =>
  Effect.sync(() => {
    const editor = process.env.EDITOR || process.env.VISUAL || "nano";
    const file = path.join(os.tmpdir(), `engram-${Date.now()}.md`);
    fs.writeFileSync(file, renderEditorDocument(initial), "utf8");
    const result = spawnSync(editor, [file], { stdio: "inherit" });
    if (result.status !== 0) {
      fs.unlinkSync(file);
      return null;
    }
    const raw = fs.readFileSync(file, "utf8");
    fs.unlinkSync(file);
    return parseEditorDocument(raw);
  });
