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
}

/** Open $EDITOR on a temp file pre-filled with frontmatter; parse on save. */
export const openEditor = (initial: {
  title?: string;
  type?: string;
  tags?: ReadonlyArray<string>;
  body?: string;
}): Effect.Effect<EditedEngram | null> =>
  Effect.sync(() => {
    const editor = process.env.EDITOR || process.env.VISUAL || "nano";
    const tmpl = [
      "---",
      `title: ${initial.title ?? ""}`,
      `type: ${initial.type ?? "note"}`,
      `tags: ${(initial.tags ?? []).join(", ")}`,
      "---",
      "",
      initial.body ?? "Write what should be remembered here.",
      "",
    ].join("\n");

    const file = path.join(os.tmpdir(), `engram-${Date.now()}.md`);
    fs.writeFileSync(file, tmpl, "utf8");
    const result = spawnSync(editor, [file], { stdio: "inherit" });
    if (result.status !== 0) {
      fs.unlinkSync(file);
      return null;
    }
    const raw = fs.readFileSync(file, "utf8");
    fs.unlinkSync(file);

    const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) return { title: "", type: undefined, tags: [], body: raw.trim() };
    const data: Record<string, string> = {};
    for (const line of m[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx > -1) data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return {
      title: data.title ?? "",
      type: data.type || undefined,
      tags: (data.tags ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      body: m[2].trim(),
    };
  });
