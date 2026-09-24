/**
 * ENG-34 host-neutral installer core: shared primitives for previewable,
 * bounded, reversible installation, update, detection, and uninstall of
 * harness integration assets (ENG-34). Host-specific installers (ENG-37,
 * ENG-58) declare WHAT to manage as data (`AssetSpec`); this module owns HOW:
 *
 * - `scanAssets` reads the current tree and classifies every asset
 *   (`absent | current | drift | blocked | corrupt`). This is the detect
 *   operation.
 * - `planInstall` / `planUninstall` are PURE functions from scan state to an
 *   exact `InstallPlan` (every write carries before/after bytes), so preview
 *   cannot mutate anything and ENG-37/58 can render diffs from the same value.
 * - `applyPlan` interprets a plan with one atomic publish step per file
 *   (temp file in the target directory plus rename). Interruptions leave
 *   either the old or the new bytes, never partial content, and leftover
 *   `.engram-tmp` files are reported by the next scan with exact paths.
 *
 * Ownership models (all keyed by a stable, unversioned asset id):
 * - `text`: one managed block delimited by host-supplied BEGIN/END marker
 *   lines. Content outside the markers is preserved byte-for-byte; uninstall
 *   never deletes the file.
 * - `json`: one owned key subtree inside a strict-JSON document. Unknown keys
 *   and their order survive install, update, and uninstall. Invalid JSON is
 *   never forced. (JSONC comments are out of scope for the core.)
 * - `jsonEntries` (ENG-58): entry-level ownership inside a JSON hook config.
 *   Engram-owned group objects carry a per-entry marker key (value = stable
 *   identity) and one root key lists all owned identities. Unmarked entries
 *   referencing engram are foreign and left alone; user entries, their
 *   order, and unknown root keys survive install and uninstall. Invalid
 *   JSON is never forced.
 * - `file`: a wholly owned file. Optional markers enable drift detection and
 *   markered updates; without them any differing content counts as a foreign
 *   file that only `force` may overwrite.
 *
 * Bounded semantics, chosen conservative and previewable:
 * - One planned write per path: specs that point two assets at the same file
 *   are rejected up front, so the preview can never promise a composition
 *   that apply would not produce.
 * - applyPlan stages each write as `<target>.engram-tmp` in the target
 *   directory and renames it over the target. Any pre-existing file at the
 *   exact staged path is overwritten and consumed by the rename; scan
 *   reports such files as leftovers first so nothing is lost silently.
 * - Plans never contain no-op writes: an uninstall whose computed result
 *   equals the current content (possible under force on foreign or markerless
 *   content) is omitted instead of previewed as a change.
 * - A markered wholly-owned file stripped of its trailing newline still
 *   installs as current, but uninstall without force refuses it as extra
 *   unmanaged content; `force` removes it.
 *
 * Host neutrality: no imports from harness adapters, no host names, no new
 * runtime dependencies (Effect platform services only). Hosts decide marker
 * comment syntax by supplying full marker lines.
 */
import { Data, Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";

/** Suffix of the staging file used for the atomic publish step. */
export const TEMP_SUFFIX = ".engram-tmp";

/* ------------------------------- types ------------------------------- */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

/** One managed asset. `path` is relative to the install root, POSIX-style. */
export type AssetSpec =
  | {
      readonly kind: "text";
      readonly id: string;
      readonly path: string;
      /** Full marker lines (host chooses comment syntax). Both must contain `id`. */
      readonly beginMarker: string;
      readonly endMarker: string;
      readonly content: string;
    }
  | {
      readonly kind: "file";
      readonly id: string;
      readonly path: string;
      readonly content: string;
      /** Optional markers enable drift detection and markered updates. */
      readonly markers?: { readonly begin: string; readonly end: string };
    }
  | {
      readonly kind: "json";
      readonly id: string;
      readonly path: string;
      /** Owned key subtree, e.g. ["integrations", "engram"]. */
      readonly keyPath: ReadonlyArray<string>;
      readonly value: JsonValue;
    }
  | {
      readonly kind: "jsonEntries";
      readonly id: string;
      readonly path: string;
      /** Document path to the event -> group-entries map, e.g. ["hooks"]. */
      readonly mapPath: ReadonlyArray<string>;
      /**
       * Marker mode (A3 in-file marking): root key listing the identities of
       * all engram-owned entries. Omit BOTH this and entryMarker for hosts
       * whose hook schema rejects unknown keys: ownership then falls to
       * canonical content equality with the spec groups, and the ownership
       * ledger lives in a separate wholly-owned sidecar asset.
       */
      readonly registryKey?: string;
      /** Marker mode: marker key written onto each engram-owned entry. */
      readonly entryMarker?: string;
      /** Event key -> engram-owned entries. Groups must not pre-set the marker. */
      readonly entries: ReadonlyArray<{
        readonly key: string;
        readonly groups: ReadonlyArray<{
          readonly identity: string;
          readonly group: { readonly [key: string]: JsonValue };
        }>;
      }>;
    };

export interface InstallSpec {
  readonly assets: ReadonlyArray<AssetSpec>;
}

/** Lifecycle of one asset against the current tree. */
export type AssetStatus =
  | "absent" /* nothing installed */
  | "current" /* installed, byte-identical to the spec */
  | "drift" /* owned content found but differs from the spec */
  | "blocked" /* unmanaged content or invalid JSON is in the way */
  | "corrupt"; /* unbalanced or duplicated markers */
/* detect: AssetState.status is the detection result per asset. */

export interface AssetState {
  readonly spec: AssetSpec;
  readonly status: AssetStatus;
  /** Current file bytes, null when the file does not exist. */
  readonly current: string | null;
  readonly reasons: ReadonlyArray<string>;
}

export interface ScanResult {
  readonly root: string;
  readonly states: ReadonlyArray<AssetState>;
  /** Staging files left by interrupted applies, relative to root. */
  readonly leftovers: ReadonlyArray<string>;
}

export type PlannedAction =
  | { readonly op: "mkdir"; readonly path: string }
  | {
      readonly op: "write";
      readonly path: string;
      readonly before: string | null;
      readonly after: string;
    }
  | { readonly op: "remove"; readonly path: string; readonly before: string };

export interface BlockedAsset {
  readonly id: string;
  readonly status: AssetStatus;
  readonly reasons: ReadonlyArray<string>;
}

export interface InstallPlan {
  /** Exact intended changes, in apply order: mkdirs, writes, removes. */
  readonly actions: ReadonlyArray<PlannedAction>;
  /** Assets this plan refuses to touch (with reasons), with or without force. */
  readonly blocked: ReadonlyArray<BlockedAsset>;
}

export interface ApplyReport {
  readonly applied: ReadonlyArray<PlannedAction>;
}

export class InstallerError extends Data.TaggedError("InstallerError")<{
  readonly code: "invalid_spec" | "io";
  readonly message: string;
  readonly path?: string;
  readonly stage?: "scan" | "apply";
  /** Relative paths applied before an apply failed (actionable diagnostics). */
  readonly completed?: ReadonlyArray<string>;
  readonly pending?: ReadonlyArray<string>;
}> {}

/* ---------------------------- tiny helpers ---------------------------- */

const ensureNL = (content: string): string =>
  content === "" || content.endsWith("\n") ? content : `${content}\n`;

const splitLines = (content: string): ReadonlyArray<string> => content.split("\n");

const isMarkerLine = (line: string, marker: string): boolean => line.trim() === marker.trim();

const jsonEqual = (a: JsonValue, b: JsonValue): boolean => JSON.stringify(a) === JSON.stringify(b);

const isJsonObject = (v: JsonValue | undefined): v is Record<string, JsonValue> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Entry with its marker injected, in the exact shape the installer writes. */
const markEntry = (
  group: { readonly [key: string]: JsonValue },
  marker: string,
  identity: string,
): Record<string, JsonValue> => ({ ...group, [marker]: identity });

/** Flat list of (event key, identity, group) for a jsonEntries asset. */
interface EntriesRef {
  readonly key: string;
  readonly identity: string;
  readonly group: { readonly [key: string]: JsonValue };
}

const entriesRefs = (
  spec: Extract<AssetSpec, { kind: "jsonEntries" }>,
): ReadonlyArray<EntriesRef> =>
  spec.entries.flatMap((entry) =>
    entry.groups.map((g) => ({ key: entry.key, identity: g.identity, group: g.group })),
  );

/** Identities listed in the registry key; empty when absent or invalid. */
const registryIdentities = (doc: Record<string, JsonValue>, registryKey: string): Array<string> => {
  const reg = doc[registryKey];
  if (!Array.isArray(reg)) return [];
  return reg.filter((x): x is string => typeof x === "string");
};

/** Canonical JSON text of a value (sorted keys) for content-addressing. */
export const canonical = (v: JsonValue): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isJsonObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
};

/** Key-order-insensitive equality for jsonEntries matching (review P1c). */
const canonicalEqual = (a: JsonValue, b: JsonValue): boolean => canonical(a) === canonical(b);

/** Remove entries matched by `matches` from every event array. */
const stripEntries = (
  map: Record<string, JsonValue>,
  matches: (group: Record<string, JsonValue>) => boolean,
): boolean => {
  let removed = false;
  for (const key of Object.keys(map)) {
    const arr = map[key];
    if (!Array.isArray(arr)) continue;
    const kept = arr.filter((g) => !(isJsonObject(g) && matches(g)));
    if (kept.length !== arr.length) {
      removed = true;
      if (kept.length > 0) map[key] = kept;
      else delete map[key];
    }
  }
  return removed;
};

/** Lines of the managed block between (excluding) the markers. */
const managedLines = (content: string): ReadonlyArray<string> => {
  const lines = ensureNL(content).split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

const blockLines = (begin: string, content: string, end: string): ReadonlyArray<string> => [
  begin,
  ...managedLines(content),
  end,
];

const renderBlock = (begin: string, content: string, end: string): string =>
  `${blockLines(begin, content, end).join("\n")}\n`;

const serializeJson = (doc: JsonValue): string => `${JSON.stringify(doc, null, 2)}\n`;

/* -------------------------- spec validation -------------------------- */

const invalid = (message: string): InstallerError =>
  new InstallerError({ code: "invalid_spec", message });

const validRelPath = (rel: string): boolean => {
  if (rel === "" || rel.startsWith("/") || rel.includes("\\")) return false;
  const segments = rel.split("/");
  return segments.every((s) => s !== "" && s !== "." && s !== "..");
};

const validMarkers = (id: string, begin: string, end: string): boolean =>
  begin !== "" &&
  end !== "" &&
  begin !== end &&
  !begin.includes("\n") &&
  !end.includes("\n") &&
  begin.includes(id) &&
  end.includes(id);

/** Pure spec check; returns the first defect or null. Also run by `scanAssets`. */
export const validateSpec = (spec: InstallSpec): InstallerError | null => {
  const seen = new Set<string>();
  const seenPaths = new Map<string, string>();
  for (const asset of spec.assets) {
    if (asset.id === "") return invalid(`asset id must not be empty`);
    if (seen.has(asset.id)) return invalid(`duplicate asset id "${asset.id}"`);
    seen.add(asset.id);
    if (!validRelPath(asset.path)) return invalid(`invalid path "${asset.path}" for "${asset.id}"`);
    if (asset.path.endsWith(TEMP_SUFFIX)) {
      return invalid(
        `asset path must not end in ${TEMP_SUFFIX} ("${asset.path}" for "${asset.id}")`,
      );
    }
    const priorId = seenPaths.get(asset.path);
    if (priorId !== undefined) {
      // one planned write per path: two assets on one path would make the
      // preview promise both changes while apply keeps only the last
      return invalid(`assets "${priorId}" and "${asset.id}" share target path "${asset.path}"`);
    }
    seenPaths.set(asset.path, asset.id);
    if (asset.kind === "text" && !validMarkers(asset.id, asset.beginMarker, asset.endMarker)) {
      return invalid(`invalid markers for "${asset.id}"`);
    }
    if (asset.kind === "file" && asset.markers) {
      const { begin, end } = asset.markers;
      if (!validMarkers(asset.id, begin, end)) return invalid(`invalid markers for "${asset.id}"`);
    }
    if (asset.kind === "json") {
      if (asset.keyPath.length === 0) return invalid(`empty keyPath for "${asset.id}"`);
      if (asset.keyPath.some((k) => typeof k !== "string" || k === "")) {
        return invalid(`invalid keyPath for "${asset.id}"`);
      }
    }
    if (asset.kind === "jsonEntries") {
      if (asset.mapPath.length === 0) return invalid(`empty mapPath for "${asset.id}"`);
      if (asset.mapPath.some((k) => typeof k !== "string" || k === "")) {
        return invalid(`invalid mapPath for "${asset.id}"`);
      }
      if ((asset.entryMarker === undefined) !== (asset.registryKey === undefined)) {
        return invalid(`entryMarker and registryKey must be set together for "${asset.id}"`);
      }
      if (asset.entryMarker !== undefined && asset.registryKey !== undefined) {
        if (asset.mapPath[0] === asset.registryKey) {
          return invalid(
            `registry key "${asset.registryKey}" must not be the managed map root for "${asset.id}"`,
          );
        }
        if (asset.registryKey === "" || asset.registryKey.includes("\n")) {
          return invalid(`invalid registry key for "${asset.id}"`);
        }
        if (asset.entryMarker === "" || asset.entryMarker.includes("\n")) {
          return invalid(`invalid entry marker for "${asset.id}"`);
        }
      }
      const identities = new Set<string>();
      const seenGroups = new Set<string>();
      for (const entry of asset.entries) {
        if (entry.key === "") return invalid(`invalid event key for "${asset.id}"`);
        for (const g of entry.groups) {
          if (identities.has(g.identity)) {
            return invalid(`duplicate entry identity "${g.identity}" for "${asset.id}"`);
          }
          identities.add(g.identity);
          if (!isJsonObject(g.group)) {
            return invalid(`group for "${g.identity}" must be a JSON object`);
          }
          if (asset.entryMarker !== undefined) {
            if (g.group[asset.entryMarker] !== undefined) {
              return invalid(`group for "${g.identity}" must not pre-set the marker key`);
            }
          } else if (seenGroups.has(canonical(g.group))) {
            // content-addressed ownership cannot distinguish identical groups
            return invalid(`duplicate group content for "${g.identity}" in "${asset.id}"`);
          }
          seenGroups.add(canonical(g.group));
        }
      }
    }
  }
  return null;
};

/* ------------------------------ scanning ------------------------------ */

const parentOf = (rel: string): string => {
  const idx = rel.lastIndexOf("/");
  return idx === -1 ? "." : rel.slice(0, idx);
};

/** Classify one asset against its current file content (install direction). */
const classifyInstall = (spec: AssetSpec, current: string | null): AssetState => {
  if (current === null) return { spec, status: "absent", current, reasons: [] };

  const markerInfo = (): { begin: string; end: string } =>
    spec.kind === "text"
      ? { begin: spec.beginMarker, end: spec.endMarker }
      : spec.kind === "file" && spec.markers
        ? { begin: spec.markers.begin, end: spec.markers.end }
        : { begin: "", end: "" };

  if (spec.kind === "text" || (spec.kind === "file" && spec.markers)) {
    const { begin, end } = markerInfo();
    const lines = splitLines(current);
    const begins = lines.map((l, i) => (isMarkerLine(l, begin) ? i : -1)).filter((i) => i >= 0);
    const ends = lines.map((l, i) => (isMarkerLine(l, end) ? i : -1)).filter((i) => i >= 0);
    if (begins.length === 0 && ends.length === 0) {
      // no ownership yet: text files get a fresh block appended; a markered
      // file target that already holds other content stays blocked
      return spec.kind === "text"
        ? { spec, status: "absent", current, reasons: [] }
        : {
            spec,
            status: "blocked",
            current,
            reasons: ["unmanaged file exists at target path (use force to overwrite)"],
          };
    }
    if (begins.length !== 1 || ends.length !== 1 || begins[0] >= ends[0]) {
      return { spec, status: "corrupt", current, reasons: ["unbalanced or duplicated markers"] };
    }
    const inner = lines.slice(begins[0] + 1, ends[0]).join("\n");
    if (inner !== managedLines(spec.content).join("\n")) {
      return { spec, status: "drift", current, reasons: ["managed content differs from spec"] };
    }
    if (spec.kind === "file") {
      // wholly-owned file: content outside the block makes it drifted
      const outside = [...lines.slice(0, begins[0]), ...lines.slice(ends[0] + 1)]
        .join("\n")
        .replace(/^\n+/, "")
        .trim();
      if (outside !== "") {
        return {
          spec,
          status: "drift",
          current,
          reasons: ["unmanaged content outside managed block"],
        };
      }
    }
    return { spec, status: "current", current, reasons: [] };
  }

  if (spec.kind === "file") {
    return current === spec.content
      ? { spec, status: "current", current, reasons: [] }
      : {
          spec,
          status: "blocked",
          current,
          reasons: ["unmanaged file exists at target path (use force to overwrite)"],
        };
  }

  if (spec.kind === "jsonEntries") {
    let doc: JsonValue;
    try {
      doc = JSON.parse(current) as JsonValue;
    } catch {
      return { spec, status: "blocked", current, reasons: ["target file is not valid JSON"] };
    }
    if (!isJsonObject(doc)) {
      return {
        spec,
        status: "blocked",
        current,
        reasons: ["target document is not a JSON object"],
      };
    }
    const entryMarker = spec.entryMarker;
    const registryKey = spec.registryKey;
    const markerMode = entryMarker !== undefined && registryKey !== undefined;
    const reg = markerMode ? doc[registryKey] : undefined;
    if (
      markerMode &&
      reg !== undefined &&
      (!Array.isArray(reg) || reg.some((x) => typeof x !== "string"))
    ) {
      return {
        spec,
        status: "blocked",
        current,
        reasons: [`registry key "${registryKey}" is not a list of identities`],
      };
    }
    let node: JsonValue = doc;
    for (const key of spec.mapPath) {
      if (!isJsonObject(node)) {
        return {
          spec,
          status: "blocked",
          current,
          reasons: [`key path conflicts with a non-object value at "${key}"`],
        };
      }
      const next: JsonValue | undefined = node[key];
      if (next === undefined) return { spec, status: "absent", current, reasons: [] };
      node = next;
    }
    if (!isJsonObject(node)) {
      return { spec, status: "blocked", current, reasons: ["managed map is not a JSON object"] };
    }
    for (const entry of spec.entries) {
      const arr: JsonValue | undefined = node[entry.key];
      if (arr !== undefined && !Array.isArray(arr)) {
        return {
          spec,
          status: "blocked",
          current,
          reasons: [`event "${entry.key}" is not a list`],
        };
      }
    }
    const refs = entriesRefs(spec);

    if (!markerMode) {
      // Content-addressed ownership: entries are recognized by canonical
      // equality with the spec groups; the ownership ledger lives in a
      // separate sidecar asset, never inside the host document.
      const counts = refs.map(() => 0);
      let matched = 0;
      for (const entry of spec.entries) {
        const arr = (node[entry.key] ?? []) as ReadonlyArray<JsonValue>;
        for (const g of arr) {
          if (!isJsonObject(g)) continue;
          refs.forEach((ref, i) => {
            if (canonicalEqual(g, ref.group)) {
              counts[i]! += 1;
              matched += 1;
            }
          });
        }
      }
      if (matched === 0) return { spec, status: "absent", current, reasons: [] };
      const ok = counts.every((c) => c === 1);
      return {
        spec,
        status: ok ? "current" : "drift",
        current,
        reasons: ok ? [] : ["owned entries differ from spec"],
      };
    }

    const identities = new Set(refs.map((r) => r.identity));
    const found = new Map<string, Array<Record<string, JsonValue>>>();
    for (const entry of spec.entries) {
      const arr = (node[entry.key] ?? []) as ReadonlyArray<JsonValue>;
      for (const g of arr) {
        if (!isJsonObject(g)) continue;
        const id = g[entryMarker];
        if (typeof id === "string" && identities.has(id)) {
          const list = found.get(id) ?? [];
          list.push(g);
          found.set(id, list);
        }
      }
    }
    if (found.size === 0) return { spec, status: "absent", current, reasons: [] };
    const entriesOk = refs.every((ref) => {
      const matches = found.get(ref.identity) ?? [];
      return (
        matches.length === 1 &&
        canonicalEqual(matches[0]!, markEntry(ref.group, entryMarker, ref.identity))
      );
    });
    const registryOk =
      Array.isArray(reg) &&
      canonicalEqual([...reg] as JsonValue, refs.map((r) => r.identity).sort());
    const ok = entriesOk && registryOk;
    return {
      spec,
      status: ok ? "current" : "drift",
      current,
      reasons: ok ? [] : ["owned entries differ from spec"],
    };
  }

  // json
  let doc: JsonValue;
  try {
    doc = JSON.parse(current) as JsonValue;
  } catch {
    return { spec, status: "blocked", current, reasons: ["target file is not valid JSON"] };
  }
  let node: JsonValue = doc;
  for (const key of spec.keyPath.slice(0, -1)) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      return {
        spec,
        status: "blocked",
        current,
        reasons: [`key path conflicts with a non-object value at "${key}"`],
      };
    }
    const next: JsonValue | undefined = (node as Record<string, JsonValue>)[key];
    if (next === undefined) {
      return { spec, status: "absent", current, reasons: [] };
    }
    node = next;
  }
  const last = spec.keyPath[spec.keyPath.length - 1];
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    return {
      spec,
      status: "blocked",
      current,
      reasons: [`key path conflicts with a non-object value at "${last}"`],
    };
  }
  const existing = (node as Record<string, JsonValue>)[last];
  if (existing === undefined) return { spec, status: "absent", current, reasons: [] };
  return jsonEqual(existing, spec.value)
    ? { spec, status: "current", current, reasons: [] }
    : { spec, status: "drift", current, reasons: ["owned value differs from spec"] };
};

/** Scan the tree, classify every asset, and report stale staging files. */
export const scanAssets = (
  root: string,
  spec: InstallSpec,
): Effect.Effect<ScanResult, InstallerError, FileSystem | Path> =>
  Effect.gen(function* () {
    const defect = validateSpec(spec);
    if (defect !== null) return yield* Effect.fail(defect);
    const fs = yield* FileSystem;
    const path = yield* Path;

    const states: Array<AssetState> = [];
    for (const asset of spec.assets) {
      const abs = path.join(root, asset.path);
      const exists = yield* fs
        .exists(abs)
        .pipe(Effect.mapError((e) => ioError(asset.path, e, "scan")));
      const current = exists
        ? yield* fs.readFileString(abs).pipe(Effect.mapError((e) => ioError(asset.path, e, "scan")))
        : null;
      states.push(classifyInstall(asset, current));
    }

    const leftovers: Array<string> = [];
    const parents = [...new Set(spec.assets.map((a) => parentOf(a.path)))];
    for (const parent of parents) {
      const abs = path.join(root, parent);
      if (!(yield* fs.exists(abs).pipe(Effect.mapError((e) => ioError(parent, e, "scan"))))) {
        continue;
      }
      const entries = yield* fs
        .readDirectory(abs)
        .pipe(Effect.mapError((e) => ioError(parent, e, "scan")));
      for (const entry of entries) {
        if (entry.endsWith(TEMP_SUFFIX)) {
          leftovers.push(parent === "." ? entry : path.join(parent, entry));
        }
      }
    }
    leftovers.sort();
    return { root, states, leftovers };
  });

const ioError = (rel: string, e: unknown, stage: "scan" | "apply"): InstallerError =>
  new InstallerError({
    code: "io",
    path: rel,
    stage,
    message: e instanceof Error ? e.message : String(e),
  });

/* ------------------------------ planning ------------------------------ */

const markersOf = (spec: AssetSpec): { begin: string; end: string } | null => {
  if (spec.kind === "text") return { begin: spec.beginMarker, end: spec.endMarker };
  if (spec.kind === "file" && spec.markers)
    return { begin: spec.markers.begin, end: spec.markers.end };
  return null;
};

/** Region a force repair/clear covers when markers are unbalanced. */
const forceClearRange = (
  lines: ReadonlyArray<string>,
  begin: string,
  end: string,
): { start: number; stop: number } | null => {
  const beginIdx = lines.findIndex((l) => isMarkerLine(l, begin));
  const endIdx = lines.findIndex((l) => isMarkerLine(l, end));
  if (beginIdx >= 0 && endIdx >= 0 && beginIdx <= endIdx) return { start: beginIdx, stop: endIdx };
  if (beginIdx >= 0) return { start: beginIdx, stop: lines.length - 1 };
  if (endIdx >= 0) return { start: 0, stop: endIdx };
  return null;
};

const spliceOut = (
  lines: ReadonlyArray<string>,
  range: { start: number; stop: number },
): string => {
  const kept = [...lines.slice(0, range.start), ...lines.slice(range.stop + 1)];
  const joined = kept.join("\n");
  // keep the original trailing newline when the removed region swallowed it
  if (
    joined !== "" &&
    !joined.endsWith("\n") &&
    lines[lines.length - 1] === "" &&
    range.stop >= lines.length - 1
  ) {
    return `${joined}\n`;
  }
  return joined;
};

/** Install actions for one writable asset (status absent or drift). */
const installActionFor = (spec: AssetSpec, current: string | null): string => {
  if (spec.kind === "json") {
    const doc = current === null ? {} : (JSON.parse(current) as Record<string, JsonValue>);
    let node = doc;
    for (const key of spec.keyPath.slice(0, -1)) {
      let next = (node as Record<string, JsonValue>)[key] as Record<string, JsonValue> | undefined;
      if (next === undefined || typeof next !== "object" || Array.isArray(next)) {
        next = {};
        (node as Record<string, JsonValue>)[key] = next;
      }
      node = next;
    }
    (node as Record<string, JsonValue>)[spec.keyPath[spec.keyPath.length - 1]] = spec.value;
    return serializeJson(doc);
  }
  if (spec.kind === "jsonEntries") {
    const doc: Record<string, JsonValue> =
      current === null ? {} : (JSON.parse(current) as Record<string, JsonValue>);
    let node = doc;
    for (const key of spec.mapPath.slice(0, -1)) {
      let next = node[key] as Record<string, JsonValue> | undefined;
      if (!isJsonObject(next)) {
        next = {};
        node[key] = next;
      }
      node = next;
    }
    const lastKey = spec.mapPath[spec.mapPath.length - 1];
    let map = node[lastKey] as Record<string, JsonValue> | undefined;
    if (!isJsonObject(map)) {
      map = {};
      node[lastKey] = map;
    }
    // Remove every entry we own (marker mode: by identity, markerless: by
    // canonical content), wherever it sits, then append the spec entries fresh.
    const refs = entriesRefs(spec);
    const entryMarker = spec.entryMarker;
    const registryKey = spec.registryKey;
    if (entryMarker === undefined || registryKey === undefined) {
      const specGroups = refs.map((r) => r.group);
      stripEntries(map, (g) => specGroups.some((s) => canonicalEqual(g, s)));
      for (const entry of spec.entries) {
        const existing = map[entry.key];
        const arr = Array.isArray(existing) ? existing : [];
        map[entry.key] = [...arr, ...entry.groups.map((g) => g.group)];
      }
      return serializeJson(doc);
    }
    const owned = new Set<string>([
      ...refs.map((r) => r.identity),
      ...registryIdentities(doc, registryKey),
    ]);
    stripEntries(map, (g) => {
      const id = g[entryMarker];
      return typeof id === "string" && owned.has(id);
    });
    for (const entry of spec.entries) {
      const existing = map[entry.key];
      const arr = Array.isArray(existing) ? existing : [];
      map[entry.key] = [
        ...arr,
        ...entry.groups.map((g) => markEntry(g.group, entryMarker, g.identity)),
      ];
    }
    doc[registryKey] = refs.map((r) => r.identity).sort();
    return serializeJson(doc);
  }
  if (spec.kind === "file" && !spec.markers) return spec.content;
  const m = markersOf(spec);
  if (m === null) return spec.content; // unreachable for validated specs
  if (current === null) return renderBlock(m.begin, spec.content, m.end);
  // drift: rebuild the managed region in place
  const lines = splitLines(current);
  const begins = lines.map((l, i) => (isMarkerLine(l, m.begin) ? i : -1)).filter((i) => i >= 0);
  const ends = lines.map((l, i) => (isMarkerLine(l, m.end) ? i : -1)).filter((i) => i >= 0);
  if (spec.kind === "file") {
    // wholly-owned markered file: any drift repair rewrites the exact block
    if (begins.length === 1 && ends.length === 1 && begins[0] < ends[0]) {
      return renderBlock(m.begin, spec.content, m.end);
    }
  } else if (begins.length === 1 && ends.length === 1 && begins[0] < ends[0]) {
    const rebuilt = [
      ...lines.slice(0, begins[0]),
      ...blockLines(m.begin, spec.content, m.end),
      ...lines.slice(ends[0] + 1),
    ];
    const joined = rebuilt.join("\n");
    return joined.endsWith("\n") ? joined : `${joined}\n`;
  }
  // unbalanced markers reached only via force: content from the first
  // unmatched marker is presumed managed and replaced by a fresh block
  const range = forceClearRange(lines, m.begin, m.end);
  if (range === null) return `${ensureNL(current)}${renderBlock(m.begin, spec.content, m.end)}`;
  return `${spliceOut(lines, range).replace(/\n$/, "")}\n${renderBlock(m.begin, spec.content, m.end)}`;
};

/** Uninstall actions for one asset (status current or drift). */
const uninstallAfterFor = (spec: AssetSpec, current: string): string => {
  if (spec.kind === "json") {
    const doc = JSON.parse(current) as Record<string, JsonValue>;
    let node: Record<string, JsonValue> = doc;
    // chain of (container, key) links so empty ancestors can be pruned
    const chain: Array<{ container: Record<string, JsonValue>; key: string }> = [];
    let conflict = false;
    for (const key of spec.keyPath.slice(0, -1)) {
      const next = node[key] as Record<string, JsonValue> | undefined;
      if (next === undefined || typeof next !== "object" || Array.isArray(next)) {
        conflict = next !== undefined;
        break;
      }
      chain.push({ container: node, key });
      node = next;
    }
    if (conflict) return current; // owned key unreachable; nothing to remove
    const last = spec.keyPath[spec.keyPath.length - 1];
    delete node[last];
    // prune ancestors we emptied: an empty object holds no user content
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const { container, key } = chain[i];
      const emptied = container[key] as Record<string, JsonValue> | undefined;
      if (
        typeof emptied === "object" &&
        emptied !== null &&
        !Array.isArray(emptied) &&
        Object.keys(emptied).length === 0
      ) {
        delete container[key];
      }
    }
    return serializeJson(doc);
  }
  if (spec.kind === "jsonEntries") {
    const doc = JSON.parse(current) as Record<string, JsonValue>;
    if (!isJsonObject(doc)) return current;
    const entryMarker = spec.entryMarker;
    let node: JsonValue = doc;
    for (const key of spec.mapPath) {
      if (!isJsonObject(node)) return current;
      const next: JsonValue | undefined = node[key];
      if (next === undefined) return current; // nothing installed there
      node = next;
    }
    if (!isJsonObject(node)) return current;
    const map = node as Record<string, JsonValue>;
    if (entryMarker === undefined || spec.registryKey === undefined) {
      // Content-addressed removal with ledger-counted ownership (review
      // P1b): at most ONE group per spec entry is engram's, so a foreign
      // hook identical to an engram hook survives uninstall. Matches are
      // scoped to the spec's event keys; anything else is left untouched.
      const pending = new Map<string, number>();
      for (const ref of entriesRefs(spec)) pending.set(canonical(ref.group), 1);
      let removed = false;
      for (const entry of spec.entries) {
        const arr = map[entry.key];
        if (!Array.isArray(arr)) continue;
        const kept: JsonValue[] = [];
        for (const g of arr) {
          const key = isJsonObject(g) ? canonical(g) : null;
          if (key !== null && (pending.get(key) ?? 0) > 0) {
            pending.set(key, (pending.get(key) ?? 0) - 1);
            removed = true;
            continue;
          }
          kept.push(g);
        }
        if (kept.length !== arr.length) {
          if (kept.length > 0) map[entry.key] = kept;
          else delete map[entry.key];
        }
      }
      if (!removed) return current;
    } else {
      const registry = registryIdentities(doc, spec.registryKey);
      // Registry absent: fall back to the spec identities so removal stays
      // deterministic. Nothing unmarked is ever removed.
      const owned = new Set<string>(
        registry.length > 0 ? registry : entriesRefs(spec).map((r) => r.identity),
      );
      if (
        !stripEntries(node, (g) => {
          const id = g[entryMarker];
          return typeof id === "string" && owned.has(id);
        })
      ) {
        return current;
      }
      delete doc[spec.registryKey];
    }
    // prune mapPath containers we emptied
    const chain: Array<{ container: Record<string, JsonValue>; key: string }> = [];
    let walker: JsonValue = doc;
    for (const key of spec.mapPath) {
      chain.push({ container: walker as Record<string, JsonValue>, key });
      walker = (walker as Record<string, JsonValue>)[key];
    }
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const { container, key } = chain[i];
      const emptied = container[key];
      if (isJsonObject(emptied) && Object.keys(emptied).length === 0) {
        delete container[key];
      }
    }
    return serializeJson(doc);
  }
  const m = markersOf(spec);
  if (m === null) return current; // markerless file assets uninstall by removal
  const lines = splitLines(current);
  const begins = lines.map((l, i) => (isMarkerLine(l, m.begin) ? i : -1)).filter((i) => i >= 0);
  const ends = lines.map((l, i) => (isMarkerLine(l, m.end) ? i : -1)).filter((i) => i >= 0);
  if (begins.length === 1 && ends.length === 1 && begins[0] < ends[0]) {
    return spliceOut(lines, { start: begins[0], stop: ends[0] });
  }
  // force path for corrupt markers: everything from the unmatched marker is
  // presumed managed
  const range = forceClearRange(lines, m.begin, m.end);
  return range === null ? current : spliceOut(lines, range);
};

const withMkdirs = (actions: ReadonlyArray<PlannedAction>): ReadonlyArray<PlannedAction> => {
  const dirs: Array<string> = [];
  for (const action of actions) {
    if (action.op === "mkdir") continue;
    const parent = parentOf(action.path);
    if (parent !== "." && !dirs.includes(parent)) dirs.push(parent);
  }
  return [...dirs.map((dir) => ({ op: "mkdir" as const, path: dir })), ...actions];
};

const purePlan = (
  states: ScanResult,
  mode: "install" | "uninstall",
  options: { readonly force?: boolean } = {},
): InstallPlan => {
  const actions: Array<PlannedAction> = [];
  const blocked: Array<BlockedAsset> = [];

  for (const state of states.states) {
    const { spec, status, current } = state;
    const actionable =
      mode === "install"
        ? status === "absent" || status === "drift"
        : status === "current" || status === "drift";

    if (!actionable) {
      // nothing to do in either direction
      if (status === "absent" || status === "current") continue;

      const unforceable = spec.kind === "json" || spec.kind === "jsonEntries"; // invalid JSON is never forced
      if (options.force === true && !unforceable) {
        if (mode === "install") {
          actions.push({
            op: "write",
            path: spec.path,
            before: current,
            after: installActionFor(spec, current),
          });
        } else if (spec.kind === "file") {
          actions.push({ op: "remove", path: spec.path, before: current ?? "" });
        } else {
          const after = uninstallAfterFor(spec, current ?? "");
          if (after !== current) {
            // no-op writes are never previewed: before === after means no change
            actions.push({
              op: "write",
              path: spec.path,
              before: current,
              after,
            });
          }
        }
        continue;
      }
      blocked.push({ id: spec.id, status, reasons: state.reasons });
      continue;
    }

    if (mode === "install") {
      actions.push({
        op: "write",
        path: spec.path,
        before: current,
        after: installActionFor(spec, current),
      });
    } else if (spec.kind === "file" && !spec.markers) {
      actions.push({ op: "remove", path: spec.path, before: current ?? "" });
    } else if (spec.kind === "file") {
      // wholly-owned markered file: remove only when it is exactly the block
      const m = markersOf(spec);
      if (m !== null && current !== null && current === renderBlock(m.begin, spec.content, m.end)) {
        actions.push({ op: "remove", path: spec.path, before: current });
      } else if (options.force === true) {
        actions.push({ op: "remove", path: spec.path, before: current ?? "" });
      } else {
        blocked.push({
          id: spec.id,
          status,
          reasons: ["managed file has extra unmanaged content (use force to remove)"],
        });
      }
    } else {
      const after = uninstallAfterFor(spec, current ?? "");
      if (after !== current) {
        actions.push({
          op: "write",
          path: spec.path,
          before: current,
          after,
        });
      }
    }
  }

  return {
    actions: mode === "install" ? withMkdirs(actions) : actions,
    blocked,
  };
};

/** Pure: exact changes to install every installable asset. */
export const planInstall = (
  states: ScanResult,
  options: { readonly force?: boolean } = {},
): InstallPlan => purePlan(states, "install", options);

/** Pure: exact changes to remove only owned content. */
export const planUninstall = (
  states: ScanResult,
  options: { readonly force?: boolean } = {},
): InstallPlan => purePlan(states, "uninstall", options);

/* ------------------------------- apply ------------------------------- */

/** Interpret a plan. Every write publishes atomically: stage in the target
 * directory as `<name>.engram-tmp`, then rename over the target. A failure
 * reports what was completed and what remains (actionable diagnostics). */
export const applyPlan = (
  root: string,
  plan: InstallPlan,
): Effect.Effect<ApplyReport, InstallerError, FileSystem | Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    const completed: Array<string> = [];
    const pending = plan.actions.map((a) => a.path);

    for (const action of plan.actions) {
      const abs = path.join(root, action.path);
      const step = Effect.gen(function* () {
        if (action.op === "mkdir") {
          yield* fs.makeDirectory(abs, { recursive: true });
          return;
        }
        if (action.op === "remove") {
          yield* fs.remove(abs, { force: true });
          return;
        }
        const staged = `${abs}${TEMP_SUFFIX}`;
        yield* fs.writeFileString(staged, action.after);
        yield* fs.rename(staged, abs);
      });
      yield* step.pipe(
        Effect.mapError(
          (e) =>
            new InstallerError({
              code: "io",
              path: action.path,
              stage: "apply",
              message: e instanceof Error ? e.message : String(e),
              completed: [...completed],
              pending: pending.filter((p) => !completed.includes(p)),
            }),
        ),
      );
      completed.push(action.path);
    }
    return { applied: plan.actions };
  });
