/**
 * engram_* tool definitions for opencode.
 *
 * Thin adapters over @engram/harnesses/shared ops: zod arg shapes with
 * per-field descriptions and bounds, mirroring the Pi typebox schemas.
 * Keep descriptions in sync with src/pi/tools.ts.
 */
import { z } from "zod";
import {
  ENGRAM_STATUSES,
  ENGRAM_TYPES,
  SOURCE_TYPES,
  type EngramType,
  type SourceType,
  type Status,
} from "@engram/core";
import {
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  addOp,
  contextDigest,
  editOp,
  searchOp,
  showOp,
} from "../shared/ops.js";
import { runOpAtDirectory } from "../shared/run.js";
import type { ScopeFilter } from "../shared/types.js";
import { toOpencodeResult } from "./result.js";

const scopeFilter = (description: string) =>
  z.enum(["project", "personal", "both"]).optional().describe(description);

const engramTypes = ENGRAM_TYPES as [EngramType, ...EngramType[]];
const engramStatuses = ENGRAM_STATUSES as [Status, ...Status[]];
const sourceTypes = SOURCE_TYPES as [SourceType, ...SourceType[]];

interface OpenCodeToolContext {
  readonly directory: string;
}

export const engramContextTool = {
  description:
    `Refresh the recorded memory digest for this workspace: decisions, pinned notes, gotchas, conventions. ` +
    `A compact project digest is loaded into your context automatically at session start (experimental, ` +
    `best-effort in OpenCode), so do not call this to duplicate that. Use it to refresh after entries ` +
    `change, to page deeper, to recover when the automatic load failed or was disabled, or to load ` +
    `context before starting feature work. ` +
    `Returns compact one-line entries (id, type, title, tags) with decisions and pinned entries first; ` +
    `read a full entry with engram_show. Results are paginated - when truncated, the footer names the exact next call.`,
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
  async execute(
    args: { scope?: ScopeFilter; limit?: number; offset?: number },
    context: OpenCodeToolContext,
  ) {
    return toOpencodeResult(
      "Engram Context",
      await runOpAtDirectory(context.directory, contextDigest(args)),
    );
  },
};

export const engramSearchTool = {
  description:
    `Keyword-search recorded engrams (tags score highest, then titles, types, bodies). ` +
    `Use when you need specifics beyond the digest - "auth", "migrations", the name of a library. ` +
    `Returns matching one-line entries and structured score summaries; read one with engram_show. Results are paginated. ` +
    `Set explain to include matched fields and score contributions in metadata.`,
  args: {
    query: z.string().describe("Search keywords (matched against tags, titles, bodies)."),
    explain: z
      .boolean()
      .optional()
      .describe(
        "Include matched fields, normalized query tokens, and score contributions in metadata. Default false.",
      ),
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
  async execute(
    args: {
      query: string;
      scope?: ScopeFilter;
      limit?: number;
      offset?: number;
      explain?: boolean;
    },
    context: OpenCodeToolContext,
  ) {
    return toOpencodeResult(
      "Engram Search",
      await runOpAtDirectory(context.directory, searchOp(args)),
    );
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
  async execute(
    args: {
      id: string;
      scope?: "project" | "personal";
      offset?: number;
      limit?: number;
    },
    context: OpenCodeToolContext,
  ) {
    return toOpencodeResult("Engram Show", await runOpAtDirectory(context.directory, showOp(args)));
  },
};

export const engramAddTool = {
  description:
    `Record a durable fact, decision, gotcha, or convention to shared memory. Use type "decision" for ` +
    `important choices (state the rationale and alternatives in the body), and record gotchas that cost ` +
    `debugging time. Do not record transient state, secrets, or anything the user says not to store. ` +
    `Project scope is committed to git and shared with the team; pass scope "personal" only for notes ` +
    `that must stay on this machine. Optional lifecycle/provenance metadata (status, supersedes, ` +
    `reviewAfter, expires, sourceType, sourceRef) is an unauthenticated claim, not a verified truth. ` +
    `Optional related links exact same-scope entry ids as directional metadata: the whole list is ` +
    `stored as given, and missing targets only dangle as a warning.`,
  args: {
    title: z.string().describe("Short, descriptive title (one line)."),
    body: z.string().describe("Full content: rationale, context, details."),
    type: z
      .enum(engramTypes)
      .optional()
      .describe(`Entry kind. Default: the project config defaultType ("note" unless configured).`),
    scope: z
      .enum(["project", "personal"])
      .optional()
      .describe('Default "project" (team-shared, git-committed).'),
    tags: z.array(z.string()).optional().describe('Searchable tags, e.g. ["auth", "deps"].'),
    pinned: z.boolean().optional().describe("Pin to the top of the digest for high-value entries."),
    status: z
      .enum(engramStatuses)
      .optional()
      .describe(
        "Lifecycle status: active | superseded | archived. Optional; not set unless passed.",
      ),
    supersedes: z
      .string()
      .optional()
      .describe("Id of the older entry this one replaces. Optional; validated when saved."),
    reviewAfter: z
      .string()
      .optional()
      .describe(
        "ISO 8601 timestamp with an explicit zone, e.g. 2026-01-01T00:00:00.000Z. Optional; validated when saved.",
      ),
    expires: z
      .string()
      .optional()
      .describe(
        "ISO 8601 timestamp with an explicit zone, e.g. 2026-06-01T00:00:00.000Z. Optional; validated when saved.",
      ),
    sourceType: z
      .enum(sourceTypes)
      .optional()
      .describe("Provenance shape: conversation | file | url | command | other. Optional."),
    sourceRef: z
      .string()
      .optional()
      .describe(
        "Source reference: path, URL, command, or conversation note. Optional; validated when saved.",
      ),
    related: z
      .array(z.string())
      .optional()
      .describe(
        'Exact engram ids in the same scope, e.g. ["0002"]. Replaces the whole list in this order; duplicates are rejected. Missing targets are advisory (a warning on check, not an error). Optional.',
      ),
    allowSecrets: z
      .boolean()
      .optional()
      .describe(
        "Write even if the secret scanner flags this content (project writes block by default). Optional.",
      ),
  },
  async execute(
    args: {
      title: string;
      body: string;
      type?: EngramType;
      scope?: "project" | "personal";
      tags?: string[];
      pinned?: boolean;
      status?: Status;
      supersedes?: string;
      reviewAfter?: string;
      expires?: string;
      sourceType?: SourceType;
      sourceRef?: string;
      related?: string[];
      allowSecrets?: boolean;
    },
    context: OpenCodeToolContext,
  ) {
    return toOpencodeResult("Engram Add", await runOpAtDirectory(context.directory, addOp(args)));
  },
};

export const engramEditTool = {
  description:
    `Update an existing engram by id (unique prefixes work). Ordinary fields (title, type, tags, body, ` +
    `pinned, author) are replaced when passed and preserved when omitted. The six lifecycle fields ` +
    `(status, supersedes, reviewAfter, expires, sourceType, sourceRef) are three-state: a concrete ` +
    `value replaces, null clears, omission preserves. related is three-state the same way: an array ` +
    `replaces the whole list with exact same-scope ids, null clears it, omission preserves; links are ` +
    `directional and may dangle with a warning. Use this to correct a title or tags, change a ` +
    `type, pin or unpin, or clear a lifecycle field after acting on it. Scope defaults to project ` +
    `inside a project and personal outside one.`,
  args: {
    id: z.string().describe('Engram id or unique prefix, e.g. "0012" or "12". Required.'),
    scope: z
      .enum(["project", "personal"])
      .optional()
      .describe("Where to edit. Default: project inside a project, personal otherwise."),
    title: z.string().optional().describe("New title. Omit to preserve."),
    type: z.enum(engramTypes).optional().describe("Replace entry kind. Omit to preserve."),
    tags: z
      .array(z.string())
      .optional()
      .describe('Replace the whole tag set, e.g. ["auth", "deps"]. Omit to preserve.'),
    body: z.string().optional().describe("New body content. Omit to preserve."),
    pinned: z.boolean().optional().describe("True pins, false unpins. Omit to preserve."),
    author: z.string().optional().describe("Replace author. Omit to preserve."),
    status: z
      .enum(engramStatuses)
      .nullable()
      .optional()
      .describe("Lifecycle status: active | superseded | archived. Null clears; omit to preserve."),
    supersedes: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Id of the older entry this one replaces. Null clears; omit to preserve. Validated when saved.",
      ),
    reviewAfter: z
      .string()
      .nullable()
      .optional()
      .describe(
        "ISO 8601 timestamp with an explicit zone, e.g. 2027-01-01T00:00:00.000Z. Null clears; omit to preserve. Validated when saved.",
      ),
    expires: z
      .string()
      .nullable()
      .optional()
      .describe(
        "ISO 8601 timestamp with an explicit zone, e.g. 2027-06-01T00:00:00.000Z. Null clears; omit to preserve. Validated when saved.",
      ),
    sourceType: z
      .enum(sourceTypes)
      .nullable()
      .optional()
      .describe(
        "Provenance shape: conversation | file | url | command | other. Null clears; omit to preserve.",
      ),
    sourceRef: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Source reference: path, URL, command, or conversation note. Null clears; omit to preserve. Validated when saved.",
      ),
    related: z
      .array(z.string())
      .nullable()
      .optional()
      .describe(
        "Replace the whole related list with exact same-scope ids in this order. Null clears; omit to preserve. Missing targets are advisory (a warning on check, not an error).",
      ),
    allowSecrets: z
      .boolean()
      .optional()
      .describe(
        "Write even if the secret scanner flags the resulting entry (project writes block by default). Optional.",
      ),
  },
  async execute(
    args: {
      id: string;
      scope?: "project" | "personal";
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
      related?: string[] | null;
      allowSecrets?: boolean;
    },
    context: OpenCodeToolContext,
  ) {
    return toOpencodeResult("Engram Edit", await runOpAtDirectory(context.directory, editOp(args)));
  },
};
