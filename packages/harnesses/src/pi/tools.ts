/**
 * engram_* tool definitions for the Pi coding agent.
 *
 * Thin adapters over @engram/harnesses/shared ops: typebox schemas with
 * per-field descriptions and bounds, rich descriptions + promptSnippets.
 */
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENGRAM_TYPES } from "@engram/core";
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
    `Load the recorded memory digest for this workspace: decisions, pinned notes, gotchas, conventions. ` +
    `Returns compact one-line entries (id, type, title, tags) with decisions and pinned entries first; ` +
    `read a full entry with engram_show. Call this at the start of a session and before starting feature ` +
    `work. Results are paginated - when truncated, the footer names the exact next call.`,
  promptSnippet:
    "Call at session start and before feature work to load recorded decisions and gotchas; drill into entries with engram_show.",
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
    `that must stay on this machine.`,
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
        }),
      ),
    );
  },
};

export const engramTools = [engramContextTool, engramSearchTool, engramShowTool, engramAddTool];

export function registerEngramTools(pi: ExtensionAPI): void {
  pi.registerTool(engramContextTool);
  pi.registerTool(engramSearchTool);
  pi.registerTool(engramShowTool);
  pi.registerTool(engramAddTool);
}
