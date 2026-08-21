/**
 * engram_* tool definitions for opencode.
 *
 * Thin adapters over @engram/harnesses/shared ops: zod arg shapes with
 * per-field descriptions and bounds, mirroring the Pi typebox schemas.
 * Keep descriptions in sync with src/pi/tools.ts.
 */
import { z } from "zod";
import { ENGRAM_TYPES, type EngramType } from "@engram/core";
import {
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  addOp,
  contextDigest,
  searchOp,
  showOp,
} from "../shared/ops.js";
import { runOp } from "../shared/run.js";
import type { ScopeFilter } from "../shared/types.js";
import { toOpencodeResult } from "./result.js";

const scopeFilter = (description: string) =>
  z.enum(["project", "personal", "both"]).optional().describe(description);

const engramTypes = ENGRAM_TYPES as [EngramType, ...EngramType[]];

export const engramContextTool = {
  description:
    `Load the recorded memory digest for this workspace: decisions, pinned notes, gotchas, conventions. ` +
    `Returns compact one-line entries (id, type, title, tags) with decisions and pinned entries first; ` +
    `read a full entry with engram_show. Call this at the start of a session and before starting feature ` +
    `work. Results are paginated - when truncated, the footer names the exact next call.`,
  args: {
    scope: scopeFilter(
      `Which memory scope to read. Default "both" (falls back to personal-only with a note outside a project).`,
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(`Max entries per page. Default ${DEFAULT_CONTEXT_LIMIT}.`),
    offset: z.number().int().min(0).optional().describe("0-based page offset for pagination."),
  },
  async execute(args: { scope?: ScopeFilter; limit?: number; offset?: number }) {
    return toOpencodeResult("Engram Context", await runOp(contextDigest(args)));
  },
};

export const engramSearchTool = {
  description:
    `Keyword-search recorded engrams (tags score highest, then titles, types, bodies). ` +
    `Use when you need specifics beyond the digest - "auth", "migrations", the name of a library. ` +
    `Returns matching one-line entries; read one with engram_show. Results are paginated.`,
  args: {
    query: z.string().describe("Search keywords (matched against tags, titles, bodies)."),
    scope: scopeFilter('Which memory scope to search. Default "both".'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(`Max matches per page. Default ${DEFAULT_SEARCH_LIMIT}.`),
    offset: z.number().int().min(0).optional().describe("0-based page offset for pagination."),
  },
  async execute(args: { query: string; scope?: ScopeFilter; limit?: number; offset?: number }) {
    return toOpencodeResult("Engram Search", await runOp(searchOp(args)));
  },
};

export const engramShowTool = {
  description:
    `Read one full engram by id (unique prefixes work, e.g. "12" for "0012"): frontmatter (type, tags, ` +
    `dates, author, scope) plus the complete body. Use after engram_context or engram_search picked an ` +
    `entry worth reading. Very long bodies are sliced - the footer names the exact next call.`,
  args: {
    id: z.string().describe('Engram id or unique prefix, e.g. "0012" or "12".'),
    scope: z
      .enum(["project", "personal"])
      .optional()
      .describe("Where to look. Default: project inside a project, personal otherwise."),
    offset: z.number().int().min(0).optional().describe("0-based char offset into the body."),
    limit: z.number().int().min(1).optional().describe("Max body chars to return."),
  },
  async execute(args: {
    id: string;
    scope?: "project" | "personal";
    offset?: number;
    limit?: number;
  }) {
    return toOpencodeResult("Engram Show", await runOp(showOp(args)));
  },
};

export const engramAddTool = {
  description:
    `Record a durable fact, decision, gotcha, or convention to shared memory. Use type "decision" for ` +
    `important choices (state the rationale and alternatives in the body), and record gotchas that cost ` +
    `debugging time. Do not record transient state, secrets, or anything the user says not to store. ` +
    `Project scope is committed to git and shared with the team; pass scope "personal" only for notes ` +
    `that must stay on this machine.`,
  args: {
    title: z.string().describe("Short, descriptive title (one line)."),
    body: z.string().describe("Full content: rationale, context, details."),
    type: z
      .enum(engramTypes)
      .optional()
      .describe(`Entry kind. Default: the project config defaultType ("note" unless configured).`),
    scope: z.enum(["project", "personal"]).optional().describe('Default "project" (team-shared, git-committed).'),
    tags: z.array(z.string()).optional().describe('Searchable tags, e.g. ["auth", "deps"].'),
    pinned: z.boolean().optional().describe("Pin to the top of the digest for high-value entries."),
  },
  async execute(args: {
    title: string;
    body: string;
    type?: EngramType;
    scope?: "project" | "personal";
    tags?: string[];
    pinned?: boolean;
  }) {
    return toOpencodeResult("Engram Add", await runOp(addOp(args)));
  },
};
