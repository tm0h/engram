/**
 * The `/engram` slash command — a single dispatcher over the shared ops.
 *
 *   /engram                      digest (context)
 *   /engram context [scope]
 *   /engram search <query>
 *   /engram show <id>
 *   /engram add <title> -- <body> [--type X] [--scope Y] [--tags a,b] [--pinned]
 *   /engram init [tracked|untracked]
 *   /engram help
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { EngramType, Scope, SourceType, Status } from "@engram/core";
import { ENGRAM_STATUSES, ENGRAM_TYPES, SOURCE_TYPES } from "@engram/core";
import { addOp, contextDigest, editOp, initOp, searchOp, showOp } from "../shared/ops.js";
import { runOp } from "./run.js";

const HELP = [
  "engram - git-native memory for you and your team",
  "",
  "  /engram                  show the context digest (decisions & pinned first)",
  "  /engram context [scope]  digest for scope: project | personal | both",
  "  /engram search <query>   keyword search across recorded engrams",
  "  /engram show <id>        read one full entry (unique prefixes work)",
  "  /engram add <title> -- <body>   record an entry",
  "      flags: --type decision|fact|preference|note|issue|context",
  "             --scope project|personal   --tags a,b   --pinned",
  "             --status active|superseded|archived   --supersedes <id>",
  "             --review-after <ts>   --expires <ts>",
  "             --source-type conversation|file|url|command|other",
  "             --source-ref <ref>   quote it if it contains spaces",
  "  /engram edit <id> [flags] [-- <body>]   edit an entry (unique prefixes work)",
  "      flags: --title <title>   --type decision|fact|preference|note|issue|context",
  "             --tags a,b   --scope project|personal   --pinned | --no-pinned",
  "             --author <name>",
  "             --status active|superseded|archived   --supersedes <id>",
  "             --review-after <ts>   --expires <ts>",
  "             --source-type conversation|file|url|command|other",
  '             --source-ref <ref>   quote multiword values: --title "Two words"',
  "             clear a field: --clear-status   --clear-supersedes",
  "             --clear-review-after   --clear-expires   --clear-source-type",
  "             --clear-source-ref",
  "  /engram init [tracked|untracked]  initialize .engram/ here",
  "",
  "Agents: prefer the engram_context / engram_search / engram_show / engram_add / engram_edit tools.",
].join("\n");

interface ParsedAdd {
  title: string;
  body: string;
  type?: EngramType;
  scope?: Scope;
  tags?: string[];
  pinned?: boolean;
  status?: Status;
  supersedes?: string;
  reviewAfter?: string;
  expires?: string;
  sourceType?: SourceType;
  sourceRef?: string;
}

const parseAddError = (error: string): { ok: false; error: string } => ({ ok: false, error });

function parseAdd(rest: string): ParsedAdd | { ok: false; error: string } {
  const parsed: ParsedAdd = { title: "", body: "" };
  let work = ` ${rest} `;
  const flag = (name: string): string | null => {
    const m = work.match(new RegExp(`\\s${name}\\s+([^\\s]+)`));
    if (!m) return null;
    work = work.replace(m[0], " ");
    return m[1];
  };
  const type = flag("--type");
  if (type !== null) {
    if (!(ENGRAM_TYPES as readonly string[]).includes(type)) {
      return parseAddError(`Invalid --type "${type}". Valid: ${ENGRAM_TYPES.join(" | ")}`);
    }
    parsed.type = type as EngramType;
  }
  const scope = flag("--scope");
  if (scope !== null) {
    if (scope !== "project" && scope !== "personal") {
      return parseAddError(`Invalid --scope "${scope}". Valid: project | personal`);
    }
    parsed.scope = scope;
  }
  const status = flag("--status");
  if (status !== null) {
    if (!(ENGRAM_STATUSES as readonly string[]).includes(status)) {
      return parseAddError(`Invalid --status "${status}". Valid: ${ENGRAM_STATUSES.join(" | ")}`);
    }
    parsed.status = status as Status;
  }
  const sourceType = flag("--source-type");
  if (sourceType !== null) {
    if (!(SOURCE_TYPES as readonly string[]).includes(sourceType)) {
      return parseAddError(
        `Invalid --source-type "${sourceType}". Valid: ${SOURCE_TYPES.join(" | ")}`,
      );
    }
    parsed.sourceType = sourceType as SourceType;
  }
  const supersedes = flag("--supersedes");
  if (supersedes !== null) parsed.supersedes = supersedes;
  const reviewAfter = flag("--review-after");
  if (reviewAfter !== null) parsed.reviewAfter = reviewAfter;
  const expires = flag("--expires");
  if (expires !== null) parsed.expires = expires;
  // Explicit grammar: a quoted reference (any content) or a single token.
  // Anything else would silently truncate, so quoting is the disclosed rule.
  const sourceRef = work.match(/\s--source-ref\s+(?:"([^"]*)"|'([^']*)'|([^\s]+))/);
  if (sourceRef) {
    work = work.replace(sourceRef[0], " ");
    parsed.sourceRef = sourceRef[1] ?? sourceRef[2] ?? sourceRef[3];
  }
  const tags = flag("--tags");
  if (tags)
    parsed.tags = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  if (/\s--pinned\b/.test(work)) {
    parsed.pinned = true;
    work = work.replace(/\s--pinned\b/, " ");
  }
  const [title, ...bodyParts] = work.trim().split(/\s+--\s+/);
  parsed.title = (title ?? "").trim();
  parsed.body = bodyParts.join(" -- ").trim();
  return parsed;
}

/* --------------------------- edit parsing --------------------------- */

interface ParsedEdit {
  id: string;
  scope?: Scope;
  title?: string;
  type?: EngramType;
  tags?: string[];
  body?: string;
  pinned?: boolean;
  author?: string;
  status?: Status | null;
  supersedes?: string | null;
  reviewAfter?: string | null;
  expires?: string | null;
  sourceType?: SourceType | null;
  sourceRef?: string | null;
}

const parseEditError = (error: string): { ok: false; error: string } => ({ ok: false, error });

interface CommandToken {
  /** Quote-stripped content. */
  readonly value: string;
  /** The exact raw slice this token came from (quotes included). */
  readonly raw: string;
  /** Index just past the token in the raw input. */
  readonly end: number;
}

/** Split a raw command tail into whitespace-separated tokens, treating
 * single- and double-quoted spans as literal content (quotes stripped,
 * usable anywhere inside a token). Unclosed quotes are an error: they would
 * silently mis-parse everything after them. Scoped to slash commands; the
 * parseAdd grammar above keeps its own long-standing behavior. */
const tokenizeCommand = (input: string): CommandToken[] | { error: string } => {
  const tokens: CommandToken[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i]!)) i += 1;
    if (i >= input.length) break;
    const start = i;
    let value = "";
    while (i < input.length && !/\s/.test(input[i]!)) {
      const ch = input[i]!;
      if (ch === '"' || ch === "'") {
        const close = input.indexOf(ch, i + 1);
        if (close === -1) {
          return {
            error: 'Unmatched quote. Quote multiword values like --title "Two words".',
          };
        }
        value += input.slice(i + 1, close);
        i = close + 1;
      } else {
        value += ch;
        i += 1;
      }
    }
    tokens.push({ value, raw: input.slice(start, i), end: i });
  }
  return tokens;
};

/** Lifecycle flags: the value flag and its paired clear flag. */
const LIFECYCLE_FLAG_PAIRS = [
  { value: "--status", clear: "--clear-status", field: "status" },
  { value: "--supersedes", clear: "--clear-supersedes", field: "supersedes" },
  { value: "--review-after", clear: "--clear-review-after", field: "reviewAfter" },
  { value: "--expires", clear: "--clear-expires", field: "expires" },
  { value: "--source-type", clear: "--clear-source-type", field: "sourceType" },
  { value: "--source-ref", clear: "--clear-source-ref", field: "sourceRef" },
] as const;

const EDIT_USAGE = "Usage: /engram edit <id> [flags] [-- <body]>";

/** Parse `/engram edit` arguments: the first token is the id (or unique
 * prefix), then field flags, then an optional ` -- <body>` delimiter. The
 * body is everything after the first bare `--` token, verbatim, so
 * flag-looking text inside it is never parsed as flags. All conflicts and
 * unknown values are rejected here, before anything runs. */
function parseEdit(rest: string): ParsedEdit | { ok: false; error: string } {
  const tokens = tokenizeCommand(rest);
  if ("error" in tokens) return parseEditError(tokens.error);
  if (tokens.length === 0) return parseEditError(EDIT_USAGE);
  const head = tokens[0]!;
  if (head.raw.startsWith("--")) {
    return parseEditError(`Missing id. ${EDIT_USAGE}`);
  }

  const dashIndex = tokens.findIndex((t) => t.raw === "--");
  const flagTokens = tokens.slice(1, dashIndex === -1 ? tokens.length : dashIndex);
  const parsed: ParsedEdit = { id: head.value };
  const bodyPresent = dashIndex !== -1;
  if (bodyPresent) parsed.body = rest.slice(tokens[dashIndex]!.end).trim();

  const setFlags = new Set<string>();
  const clearFlags = new Set<string>();
  let fieldCount = 0;
  const nextValue = (): string | null => {
    const t = flagTokens[++k];
    return t === undefined ? null : t.value;
  };
  const assignLifecycle = (
    field: (typeof LIFECYCLE_FLAG_PAIRS)[number]["field"],
    value: string | null,
  ): void => {
    (parsed as unknown as Record<string, string | null>)[field] = value;
  };
  let k = 0;
  for (k = 0; k < flagTokens.length; k += 1) {
    const t = flagTokens[k]!;
    const lifecycle = LIFECYCLE_FLAG_PAIRS.find((p) => p.value === t.raw || p.clear === t.raw);
    if (lifecycle !== undefined) {
      if (t.raw === lifecycle.clear) {
        assignLifecycle(lifecycle.field, null);
        clearFlags.add(lifecycle.field);
      } else {
        const v = nextValue();
        if (v === null) return parseEditError(`Missing value for ${t.raw}.`);
        assignLifecycle(lifecycle.field, v);
        setFlags.add(lifecycle.field);
      }
      fieldCount += 1;
      continue;
    }
    switch (t.raw) {
      case "--title": {
        const v = nextValue();
        if (v === null) return parseEditError("Missing value for --title.");
        parsed.title = v;
        break;
      }
      case "--type": {
        const v = nextValue();
        if (v === null) return parseEditError("Missing value for --type.");
        if (!(ENGRAM_TYPES as readonly string[]).includes(v)) {
          return parseEditError(`Invalid --type "${v}". Valid: ${ENGRAM_TYPES.join(" | ")}`);
        }
        parsed.type = v as EngramType;
        break;
      }
      case "--tags": {
        const v = nextValue();
        if (v === null) return parseEditError("Missing value for --tags.");
        parsed.tags = v
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean);
        break;
      }
      case "--scope": {
        const v = nextValue();
        if (v === null) return parseEditError("Missing value for --scope.");
        if (v !== "project" && v !== "personal") {
          return parseEditError(`Invalid --scope "${v}". Valid: project | personal`);
        }
        parsed.scope = v;
        break;
      }
      case "--pinned":
      case "--no-pinned": {
        const pin = t.raw === "--pinned";
        if (parsed.pinned !== undefined && parsed.pinned !== pin) {
          return parseEditError("Use either --pinned or --no-pinned, not both.");
        }
        parsed.pinned = pin;
        break;
      }
      case "--author": {
        const v = nextValue();
        if (v === null) return parseEditError("Missing value for --author.");
        parsed.author = v;
        break;
      }
      default:
        return parseEditError(`Unknown flag "${t.raw}". ${EDIT_USAGE}`);
    }
    fieldCount += 1;
  }

  for (const pair of LIFECYCLE_FLAG_PAIRS) {
    if (setFlags.has(pair.field) && clearFlags.has(pair.field)) {
      return parseEditError(`Use either ${pair.value} or ${pair.clear}, not both.`);
    }
  }
  if (fieldCount === 0 && !bodyPresent) {
    return parseEditError(`Nothing to edit. Pass a field flag or a " -- " body. ${EDIT_USAGE}`);
  }
  return parsed;
}

async function dispatch(
  args: string,
  ctx: ExtensionCommandContext,
  onWriteSuccess?: () => void,
): Promise<void> {
  const rest = args.trim();
  const sub = rest.split(/\s+/)[0] ?? "";
  const remainder = sub ? rest.slice(sub.length).trim() : rest;
  const notify = (text: string, level: "info" | "error" = "info"): void => {
    if (ctx.hasUI) ctx.ui.notify(text, level);
  };

  if (sub === "help" || sub === "?") {
    notify(HELP);
    return;
  }

  if (sub === "init") {
    let tracked = true;
    if (remainder === "untracked") tracked = false;
    else if (remainder === "tracked") tracked = true;
    else if (ctx.hasUI)
      tracked = await ctx.ui.confirm(
        "engram init",
        "Track the team engram in git? (shared with your team; answer No to gitignore it)",
      );
    const r = await runOp(initOp({ tracked }));
    notify(r.text, r.isError ? "error" : "info");
    return;
  }

  if (sub === "search") {
    if (!remainder) {
      notify("Usage: /engram search <query>", "error");
      return;
    }
    const r = await runOp(searchOp({ query: remainder }));
    notify(r.text, r.isError ? "error" : "info");
    return;
  }

  if (sub === "show") {
    if (!remainder) {
      notify("Usage: /engram show <id>", "error");
      return;
    }
    const r = await runOp(showOp({ id: remainder }));
    notify(r.text, r.isError ? "error" : "info");
    return;
  }

  if (sub === "add") {
    const parsed = parseAdd(remainder);
    if ("error" in parsed) {
      notify(parsed.error, "error");
      return;
    }
    if (!parsed.title) {
      notify("Usage: /engram add <title> -- <body> [--type X] [--scope Y] [--tags a,b]", "error");
      return;
    }
    const r = await runOp(addOp(parsed));
    notify(r.text, r.isError ? "error" : "info");
    if (!r.isError) onWriteSuccess?.();
    return;
  }

  if (sub === "edit") {
    if (!remainder) {
      notify(EDIT_USAGE, "error");
      return;
    }
    const parsed = parseEdit(remainder);
    if ("error" in parsed) {
      notify(parsed.error, "error");
      return;
    }
    const r = await runOp(editOp(parsed));
    notify(r.text, r.isError ? "error" : "info");
    if (!r.isError) onWriteSuccess?.();
    return;
  }

  // default (and explicit "context"): optional scope arg
  const scope =
    remainder === "project" || remainder === "personal" || remainder === "both"
      ? remainder
      : undefined;
  const r = await runOp(contextDigest({ scope }));
  notify(r.text, r.isError ? "error" : "info");
}

export interface RegisterCommandOptions {
  /** Called after a successful /engram write (add today, edit with it)
   * e.g. to refresh the auto context. Success only. */
  readonly onWriteSuccess?: () => void;
}

export function registerEngramCommand(pi: ExtensionAPI, opts: RegisterCommandOptions = {}): void {
  pi.registerCommand("engram", {
    description: "engram memory: context | search | show | add | edit | init | help",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await dispatch(args, ctx, opts.onWriteSuccess);
    },
  });
}
