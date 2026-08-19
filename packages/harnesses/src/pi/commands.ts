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
import type { EngramType, Scope } from "@engram/core";
import { ENGRAM_TYPES } from "@engram/core";
import { addOp, contextDigest, initOp, searchOp, showOp } from "../shared/ops.js";
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
  "  /engram init [tracked|untracked]  initialize .engram/ here",
  "",
  "Agents: prefer the engram_context / engram_search / engram_show / engram_add tools.",
].join("\n");

interface ParsedAdd {
  title: string;
  body: string;
  type?: EngramType;
  scope?: Scope;
  tags?: string[];
  pinned?: boolean;
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

async function dispatch(args: string, ctx: ExtensionCommandContext): Promise<void> {
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

export function registerEngramCommand(pi: ExtensionAPI): void {
  pi.registerCommand("engram", {
    description: "engram memory: context | search | show | add | init | help",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await dispatch(args, ctx);
    },
  });
}
