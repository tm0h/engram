import { isDeepStrictEqual } from "node:util";
import {
  isValidId,
  parseEntryFilename,
  scanContent,
  validateEntry,
  type Frontmatter,
  type StoreDiagnosticCode,
} from "@engram/core";
import { decodeMemory, memorySnapshots, type SnapshotSource } from "./memory-snapshots.js";

export const maxDiffDetails = 100;

type Side = "from" | "to";
interface Diagnostic {
  readonly side: Side;
  readonly path: string | null;
  readonly code: StoreDiagnosticCode | "snapshot_unreadable";
  readonly severity: "error" | "warning";
}

interface Entry {
  readonly path: string;
  readonly body: string;
  readonly frontmatter: Frontmatter;
  readonly metadata: Readonly<Record<string, unknown>>;
}

interface Claim {
  readonly path: string | null;
  readonly entry?: Entry;
  readonly decoded: boolean;
}

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const bounded = (value: string) => (value.length > 256 ? value.slice(0, 255) + "…" : value);

function displayPath(value: string | null): string | null {
  return value === null || scanContent(value).length > 0 ? null : bounded(value);
}

async function readSnapshot(source: SnapshotSource, side: Side) {
  const claims = new Map<string, Claim[]>();
  const unreadablePaths = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  let unknownIdentity = false;
  function diagnose(code: Diagnostic["code"], path: string | null) {
    diagnostics.push({
      side,
      path,
      code,
      severity: code === "schema_version_unsupported" ? "warning" : "error",
    });
  }

  let files;
  try {
    files = await source.list();
  } catch {
    diagnose("snapshot_unreadable", source.directory);
    return { claims, unreadablePaths, diagnostics, unknownIdentity: true };
  }

  for (const file of files) {
    let parsed;
    try {
      parsed = validateEntry(decodeMemory(await file.read()));
    } catch {
      diagnose("file_unreadable", file.path);
    }
    for (const issue of parsed?.issues ?? []) diagnose(issue.code, file.path);
    const fm = parsed?.frontmatter;
    if (parsed?.partial.scope === "personal") diagnose("scope_mismatch", file.path);
    const entry =
      parsed && fm?.scope === "project" && file.path !== null
        ? {
            path: file.path,
            body: parsed.content.trim(),
            frontmatter: fm,
            metadata: parsed.metadata,
          }
        : undefined;
    const claimedId = parsed?.partial.id;
    const id = claimedId && isValidId(claimedId) ? claimedId : undefined;
    if (entry === undefined) {
      if (file.path !== null) unreadablePaths.add(file.path);
      // A canonical name can connect a known ID to this file. Only decoded
      // frontmatter establishes identity, so an unknown claim may also
      // hide a rename for any unmatched ID.
      if (id === undefined) unknownIdentity = true;
    }
    const name = file.path?.split("/").at(-1);
    const claimId = id ?? (name === undefined ? undefined : parseEntryFilename(name)?.id);
    if (claimId !== undefined) {
      const existing = claims.get(claimId) ?? [];
      existing.push({ path: file.path, entry, decoded: id !== undefined });
      claims.set(claimId, existing);
    }
  }

  for (const group of claims.values()) {
    const decoded = group.filter((claim) => claim.decoded);
    if (decoded.length < 2) continue;
    for (const claim of decoded) diagnose("duplicate_id", claim.path);
  }
  diagnostics.sort((a, b) => order(a.path ?? "", b.path ?? "") || order(a.code, b.code));
  return { claims, unreadablePaths, diagnostics, unknownIdentity };
}

type LifecycleField = "status" | "supersedes" | "reviewAfter" | "expires";
const lifecycleFields: readonly LifecycleField[] = [
  "status",
  "supersedes",
  "reviewAfter",
  "expires",
];

function lifecycleChanges(before?: Frontmatter, after?: Frontmatter) {
  const result: Partial<Record<LifecycleField, { before: string | null; after: string | null }>> =
    {};
  for (const field of lifecycleFields) {
    const oldValue = before?.[field] ?? null;
    const newValue = after?.[field] ?? null;
    if (oldValue === newValue) continue;
    result[field] = {
      before: oldValue === null ? null : bounded(oldValue),
      after: newValue === null ? null : bounded(newValue),
    };
  }
  return result;
}

function editableFields({
  status: _status,
  supersedes: _supersedes,
  reviewAfter: _reviewAfter,
  expires: _expires,
  ...fields
}: Frontmatter) {
  return fields;
}

function compareEntry(id: string, before?: Entry, after?: Entry) {
  if (!before && !after) return undefined;
  const kind = !before ? "added" : !after ? "removed" : "modified";
  const renamed = Boolean(before && after && before.path !== after.path);
  const edited = Boolean(
    before &&
    after &&
    (before.body !== after.body ||
      !isDeepStrictEqual(editableFields(before.frontmatter), editableFields(after.frontmatter)) ||
      !isDeepStrictEqual(before.metadata, after.metadata)),
  );
  const lifecycle = lifecycleChanges(before?.frontmatter, after?.frontmatter);
  if (kind === "modified" && !renamed && !edited && Object.keys(lifecycle).length === 0)
    return undefined;
  return {
    id,
    kind,
    renamed,
    edited,
    beforePath: displayPath(before?.path ?? null),
    afterPath: displayPath(after?.path ?? null),
    lifecycle,
  } as const;
}

type Change = NonNullable<ReturnType<typeof compareEntry>>;

export async function compareProjectMemory(
  cwd: string,
  revision: string | undefined,
  limit: number,
) {
  const sources = await memorySnapshots(cwd, revision);
  let from: Awaited<ReturnType<typeof readSnapshot>>;
  let to: Awaited<ReturnType<typeof readSnapshot>>;
  try {
    [from, to] = await Promise.all([
      readSnapshot(sources.from, "from"),
      readSnapshot(sources.to, "to"),
    ]);
  } finally {
    await sources.close();
  }
  const diagnostics = [...from.diagnostics, ...to.diagnostics];
  const omitted = { changes: 0, diagnostics: Math.max(0, diagnostics.length - limit) };
  const changes: Change[] = [];
  const totals = {
    changed: 0,
    added: 0,
    removed: 0,
    modified: 0,
    edited: 0,
    renamed: 0,
    statusChanged: 0,
    supersessionChanged: 0,
    lifecycleChanged: 0,
    indeterminate: 0,
    diagnostics: diagnostics.length,
  };
  const ids = [...new Set([...from.claims.keys(), ...to.claims.keys()])].sort(order);
  for (const id of ids) {
    const left = from.claims.get(id) ?? [];
    const right = to.claims.get(id) ?? [];
    const before = left[0]?.entry;
    const after = right[0]?.entry;
    if (
      (left.length > 0 && (!before || left.length > 1)) ||
      (right.length > 0 && (!after || right.length > 1)) ||
      (before && !after && (to.unknownIdentity || to.unreadablePaths.has(before.path))) ||
      (after && !before && (from.unknownIdentity || from.unreadablePaths.has(after.path)))
    ) {
      totals.indeterminate++;
      continue;
    }

    const change = compareEntry(id, before, after);
    if (!change) continue;
    totals.changed++;
    totals[change.kind]++;
    if (change.renamed) totals.renamed++;
    if (change.edited) totals.edited++;
    if (change.lifecycle.status) totals.statusChanged++;
    if (change.lifecycle.supersedes) totals.supersessionChanged++;
    if (Object.keys(change.lifecycle).length > 0) totals.lifecycleChanged++;
    if (changes.length < limit) changes.push(change);
  }
  omitted.changes = totals.changed - changes.length;
  return {
    schemaVersion: 1,
    ...sources.comparison,
    project: displayPath(sources.project),
    complete: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    limit,
    totals,
    omitted,
    changes,
    diagnostics: diagnostics.slice(0, limit).map((diagnostic) => ({
      ...diagnostic,
      path: displayPath(diagnostic.path),
    })),
  };
}

export type MemoryDiff = Awaited<ReturnType<typeof compareProjectMemory>>;
