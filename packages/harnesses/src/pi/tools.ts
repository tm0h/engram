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
  editOp,
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
    `Returns matching one-line entries and structured score summaries; read one with engram_show. Results are paginated. ` +
    `Set explain to include matched fields and score contributions in metadata.`,
  promptSnippet: "Use to pull specific recorded knowledge by keyword instead of re-deriving it.",
  parameters: Type.Object({
    query: Type.String({ description: "Search keywords (matched against tags, titles, bodies)." }),
    explain: Type.Optional(
      Type.Boolean({
        description:
          "Include matched fields, normalized query tokens, and score contributions in metadata. Default false.",
      }),
    ),
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
          explain: params.explain,
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
    `reviewAfter, expires, sourceType, sourceRef) is an unauthenticated claim, not a verified truth. ` +
    `Optional related links exact same-scope entry ids as directional metadata: the whole list is ` +
    `stored as given, and missing targets only dangle as a warning.`,
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
    related: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'Exact engram ids in the same scope, e.g. ["0002"]. Replaces the whole list in this order; duplicates are rejected. Missing targets are advisory (a warning on check, not an error). Optional.',
      }),
    ),
    allowSecrets: Type.Optional(
      Type.Boolean({
        description:
          "Write even if the secret scanner flags this content (project writes block by default). Optional.",
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
          related: params.related,
          allowSecrets: params.allowSecrets,
        }),
      ),
    );
  },
};

export const engramEditTool = {
  name: "engram_edit",
  label: "Engram Edit",
  description:
    `Update an existing engram by id (unique prefixes work). Ordinary fields (title, type, tags, body, ` +
    `pinned, author) are replaced when passed and preserved when omitted. The six lifecycle fields ` +
    `(status, supersedes, reviewAfter, expires, sourceType, sourceRef) are three-state: a concrete ` +
    `value replaces, null clears, omission preserves. related is three-state the same way: an array ` +
    `replaces the whole list with exact same-scope ids, null clears it, omission preserves; links are ` +
    `directional and may dangle with a warning. Use this to correct a title or tags, change a ` +
    `type, pin or unpin, or clear a lifecycle field after acting on it. Scope defaults to project ` +
    `inside a project and personal outside one.`,
  promptSnippet:
    "Update an existing entry: ordinary fields replace when passed, lifecycle fields are three-state (null clears, omission preserves).",
  parameters: Type.Object({
    id: Type.String({
      description: 'Engram id or unique prefix, e.g. "0012" or "12". Required.',
    }),
    scope: Type.Optional(
      StringEnum(["project", "personal"], {
        description: "Where to edit. Default: project inside a project, personal otherwise.",
      }),
    ),
    title: Type.Optional(Type.String({ description: "New title. Omit to preserve." })),
    type: Type.Optional(
      StringEnum([...ENGRAM_TYPES], {
        description: "Replace entry kind. Omit to preserve.",
      }),
    ),
    tags: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Replace the whole tag set, e.g. ["auth", "deps"]. Omit to preserve.',
      }),
    ),
    body: Type.Optional(Type.String({ description: "New body content. Omit to preserve." })),
    pinned: Type.Optional(
      Type.Boolean({ description: "True pins, false unpins. Omit to preserve." }),
    ),
    author: Type.Optional(Type.String({ description: "Replace author. Omit to preserve." })),
    status: Type.Optional(
      Type.Union([StringEnum([...ENGRAM_STATUSES]), Type.Null()], {
        description:
          "Lifecycle status: active | superseded | archived. Null clears; omit to preserve.",
      }),
    ),
    supersedes: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description:
          "Id of the older entry this one replaces. Null clears; omit to preserve. Validated when saved.",
      }),
    ),
    reviewAfter: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description:
          "ISO 8601 timestamp with an explicit zone, e.g. 2027-01-01T00:00:00.000Z. Null clears; omit to preserve. Validated when saved.",
      }),
    ),
    expires: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description:
          "ISO 8601 timestamp with an explicit zone, e.g. 2027-06-01T00:00:00.000Z. Null clears; omit to preserve. Validated when saved.",
      }),
    ),
    sourceType: Type.Optional(
      Type.Union([StringEnum([...SOURCE_TYPES]), Type.Null()], {
        description:
          "Provenance shape: conversation | file | url | command | other. Null clears; omit to preserve.",
      }),
    ),
    sourceRef: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description:
          "Source reference: path, URL, command, or conversation note. Null clears; omit to preserve. Validated when saved.",
      }),
    ),
    related: Type.Optional(
      Type.Union([Type.Array(Type.String()), Type.Null()], {
        description:
          'Replace the whole related list with exact same-scope ids in this order. Null clears; omit to preserve. Missing targets are advisory (a warning on check, not an error).',
      }),
    ),
    allowSecrets: Type.Optional(
      Type.Boolean({
        description:
          "Write even if the secret scanner flags the resulting entry (project writes block by default). Optional.",
      }),
    ),
  }),
  async execute(_id: string, params: any) {
    return toToolResult(
      await runOp(
        editOp({
          id: params.id,
          scope: params.scope,
          title: params.title,
          type: params.type,
          tags: params.tags,
          body: params.body,
          pinned: params.pinned,
          author: params.author,
          status: params.status,
          supersedes: params.supersedes,
          reviewAfter: params.reviewAfter,
          expires: params.expires,
          sourceType: params.sourceType,
          sourceRef: params.sourceRef,
          related: params.related,
          allowSecrets: params.allowSecrets,
        }),
      ),
    );
  },
};

export const engramTools = [
  engramContextTool,
  engramSearchTool,
  engramShowTool,
  engramAddTool,
  engramEditTool,
];

export interface RegisterToolsOptions {
  /** Called after a successful engram_add or engram_edit (e.g. to refresh
   * the auto context). Success only: errors must not invalidate a cache. */
  readonly onWriteSuccess?: () => void;
}

/** Wrap a write tool so `onWriteSuccess` fires only on non-error results.
 * Keeps the base tool's shape; the 2-arg execute satisfies Pi's
 * ToolDefinition contract (fewer parameters than the declared 5-arg
 * signature is fine, and the base tool registers the same way), so no casts
 * are needed anywhere. */
const toolWithRefresh = <
  T extends {
    name: string;
    execute: (
      id: string,
      params: any,
    ) => Promise<{
      isError: boolean;
    }>;
  },
>(
  base: T,
  onWriteSuccess: () => void,
): T => ({
  ...base,
  async execute(id: string, params: any) {
    const result = await base.execute(id, params);
    if (!result.isError) onWriteSuccess();
    return result;
  },
});

export function registerEngramTools(pi: ExtensionAPI, opts: RegisterToolsOptions = {}): void {
  pi.registerTool(engramContextTool);
  pi.registerTool(engramSearchTool);
  pi.registerTool(engramShowTool);
  const notify = opts.onWriteSuccess;
  pi.registerTool(notify ? toolWithRefresh(engramAddTool, notify) : engramAddTool);
  pi.registerTool(notify ? toolWithRefresh(engramEditTool, notify) : engramEditTool);
}
