/**
 * engram_* tool definitions for the Pi coding agent.
 *
 * Thin adapters over @engram/harnesses/shared ops: typebox schemas with
 * per-field descriptions and bounds, rich descriptions + promptSnippets.
 */
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENGRAM_STATUSES, ENGRAM_TYPES, SOURCE_TYPES } from "@engram/core";
import {
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  addOp,
  contextDigest,
  searchOp,
  showOp,
} from "../shared/ops.js";
import { runOp, toToolResult } from "./run.js";

const scopeFilter = (description: string) =>
  Type.Optional(
    StringEnum(["project", "personal", "both"], {
      description,
    }),
  );

/* eslint-disable @typescript-eslint/no-explicit-any -- pi tool results are deliberately loose */

export const engramContextTool = {
  name: "engram_context",
  label: "Engram Context",
  description:
    `Refresh the recorded memory digest for this workspace: decisions, pinned notes, gotchas, conventions. ` +
    `A compact project digest is loaded into your context automatically at session start, so do not call ` +
    `this to duplicate that. Use it to refresh after entries change, to page deeper, to recover when the ` +
    `automatic load failed or was disabled, or to load context before starting feature work. ` +
    `Returns compact one-line entries (id, type, title, tags) with decisions and pinned entries first; ` +
    `read a full entry with engram_show. Results are paginated - when truncated, the footer names the exact next call.`,
  promptSnippet:
    "A compact digest loads automatically; call to refresh after changes, page deeper, or recover when automatic loading failed.",
  parameters: Type.Object({
    scope: scopeFilter(
      `Which memory scope to read. Default "both" (falls back to personal-only with a note outside a project).`,
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        description: `Max entries per page. Default ${DEFAULT_CONTEXT_LIMIT}.`,
      }),
    ),
    offset: Type.Optional(
      Type.Integer({ minimum: 0, description: "0-based page offset for pagination." }),
    ),
  }),
  async execute(_id: string, params: any) {
    return toToolResult(
      await runOp(
        contextDigest({
          scope: params.scope,
          limit: params.limit,
          offset: params.offset,
        }),
      ),
    );
  },
};

export const engramSearchTool = {
  name: "engram_search",
  label: "Engram Search",
  description:
    `Keyword-search recorded engrams (tags score highest, then titles, types, bodies). ` +
    `Use when you need specifics beyond the digest - "auth", "migrations", the name of a library. ` +
    `Returns matching one-line entries; read one with engram_show. Results are paginated.`,
  promptSnippet: "Use to pull specific recorded knowledge by keyword instead of re-deriving it.",
  parameters: Type.Object({
    query: Type.String({ description: "Search keywords (matched against tags, titles, bodies)." }),
    scope: scopeFilter('Which memory scope to search. Default "both".'),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 50,
        description: `Max matches per page. Default ${DEFAULT_SEARCH_LIMIT}.`,
      }),
    ),
    offset: Type.Optional(
      Type.Integer({ minimum: 0, description: "0-based page offset for pagination." }),
    ),
  }),
  async execute(_id: string, params: any) {
    return toToolResult(
      await runOp(
        searchOp({
          query: params.query,
          scope: params.scope,
          limit: params.limit,
          offset: params.offset,
        }),
      ),
    );
  },
};

export const engramShowTool = {
  name: "engram_show",
  label: "Engram Show",
  description:
    `Read one full engram by id (unique prefixes work, e.g. "12" for "0012"): frontmatter (type, tags, ` +
    `dates, author, scope) plus the complete body. Use after engram_context or engram_search picked an ` +
    `entry worth reading. Very long bodies are sliced - the footer names the exact next call.`,
  promptSnippet: "Read full recorded entries by id after spotting them in context or search.",
  parameters: Type.Object({
    id: Type.String({ description: 'Engram id or unique prefix, e.g. "0012" or "12".' }),
    scope: Type.Optional(
      StringEnum(["project", "personal"], {
        description: "Where to look. Default: project inside a project, personal otherwise.",
      }),
    ),
    offset: Type.Optional(
      Type.Integer({ minimum: 0, description: "0-based char offset into the body." }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, description: "Max body chars to return." })),
  }),
  async execute(_id: string, params: any) {
    return toToolResult(
      await runOp(
        showOp({
          id: params.id,
          scope: params.scope,
          offset: params.offset,
          limit: params.limit,
        }),
      ),
    );
  },
};

export const engramAddTool = {
  name: "engram_add",
  label: "Engram Add",
  description:
    `Record a durable fact, decision, gotcha, or convention to shared memory. Use type "decision" for ` +
    `important choices (state the rationale and alternatives in the body), and record gotchas that cost ` +
    `debugging time. Do not record transient state, secrets, or anything the user says not to store. ` +
    `Project scope is committed to git and shared with the team; pass scope "personal" only for notes ` +
    `that must stay on this machine. Optional lifecycle/provenance metadata (status, supersedes, ` +
    `reviewAfter, expires, sourceType, sourceRef) is an unauthenticated claim, not a verified truth.`,
  promptSnippet:
    "Record durable decisions (with rationale), gotchas, and conventions as you discover them; ask scope personal only for machine-private notes.",
  parameters: Type.Object({
    title: Type.String({ description: "Short, descriptive title (one line)." }),
    body: Type.String({ description: "Full content: rationale, context, details." }),
    type: Type.Optional(
      StringEnum([...ENGRAM_TYPES], {
        description: `Entry kind. Default: the project config defaultType ("note" unless configured).`,
      }),
    ),
    scope: Type.Optional(
      StringEnum(["project", "personal"], {
        description: 'Default "project" (team-shared, git-committed).',
      }),
    ),
    tags: Type.Optional(
      Type.Array(Type.String(), { description: 'Searchable tags, e.g. ["auth", "deps"].' }),
    ),
    pinned: Type.Optional(
      Type.Boolean({ description: "Pin to the top of the digest for high-value entries." }),
    ),
    status: Type.Optional(
      StringEnum([...ENGRAM_STATUSES], {
        description:
          "Lifecycle status: active | superseded | archived. Optional; not set unless passed.",
      }),
    ),
    supersedes: Type.Optional(
      Type.String({
        description: "Id of the older entry this one replaces. Optional; validated when saved.",
      }),
    ),
    reviewAfter: Type.Optional(
      Type.String({
        description:
          "ISO 8601 timestamp with an explicit zone, e.g. 2026-01-01T00:00:00.000Z. Optional; validated when saved.",
      }),
    ),
    expires: Type.Optional(
      Type.String({
        description:
          "ISO 8601 timestamp with an explicit zone, e.g. 2026-06-01T00:00:00.000Z. Optional; validated when saved.",
      }),
    ),
    sourceType: Type.Optional(
      StringEnum([...SOURCE_TYPES], {
        description: "Provenance shape: conversation | file | url | command | other. Optional.",
      }),
    ),
    sourceRef: Type.Optional(
      Type.String({
        description:
          "Source reference: path, URL, command, or conversation note. Optional; validated when saved.",
      }),
    ),
  }),
  async execute(_id: string, params: any) {
    return toToolResult(
      await runOp(
        addOp({
          title: params.title,
          body: params.body,
          type: params.type,
          scope: params.scope,
          tags: params.tags,
          pinned: params.pinned,
          status: params.status,
          supersedes: params.supersedes,
          reviewAfter: params.reviewAfter,
          expires: params.expires,
          sourceType: params.sourceType,
          sourceRef: params.sourceRef,
        }),
      ),
    );
  },
};

export const engramTools = [engramContextTool, engramSearchTool, engramShowTool, engramAddTool];

export interface RegisterToolsOptions {
  /** Called after a successful engram_add (e.g. to refresh the auto context). */
  readonly onAddSuccess?: () => void;
}

/**
 * engram_add wrapped to notify on success. Keeps the base tool's shape; the
 * 2-arg execute satisfies Pi's ToolDefinition contract (fewer parameters than
 * the declared 5-arg signature is fine, and the base tool registers the same
 * way), so no casts are needed anywhere.
 */
const addToolWithRefresh = (onAddSuccess: () => void) => ({
  ...engramAddTool,
  async execute(id: string, params: any) {
    const result = await engramAddTool.execute(id, params);
    if (!result.isError) onAddSuccess();
    return result;
  },
});

export function registerEngramTools(pi: ExtensionAPI, opts: RegisterToolsOptions = {}): void {
  pi.registerTool(engramContextTool);
  pi.registerTool(engramSearchTool);
  pi.registerTool(engramShowTool);
  pi.registerTool(opts.onAddSuccess ? addToolWithRefresh(opts.onAddSuccess) : engramAddTool);
}
