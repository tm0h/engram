/**
 * ENG-11 golden retrieval corpus: contract types, validator, and loader.
 *
 * The corpus is a versioned, deterministic set of retrieval test cases for
 * coding memory. It lives in a plain directory (see `corpus/README.md` for
 * the full contract):
 *
 *   <corpusDir>/
 *     manifest.json      corpus-level versioning and defaults
 *     engrams/*.md       fixture engrams (same format as store entries)
 *     cases/*.json       labeled retrieval cases
 *
 * Design constraints:
 * - No dependencies beyond what core already uses. The case schema is a
 *   hand-rolled validator (single source of truth with the types; no JSON
 *   Schema file to drift). `corpus/README.md` documents every field.
 * - Deterministic: no clock reads, no randomness, no environment access.
 *   Temporal cases carry a fixed `now`; the manifest carries `defaultNow`.
 * - The loader takes an explicit corpus directory argument. No cwd
 *   dependence, no project-root discovery.
 * - Consumed through the `@engram/core/corpus` subpath export so nothing
 *   here can land in the CLI bundle.
 *
 * Evaluation is pinned by `evaluateCase`: filter fixture engrams to the
 * case scope, then call `searchEngrams` with the case's fixed parameters.
 * The README states the same procedure in prose; this function is the
 * executable form.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Engram, Scope } from "./domain.js";
import { validateEntry } from "./frontmatter.js";
import { searchEngrams, type SearchResult } from "./search.js";
import { isValidId, parseEntryFilename, parseTimestamp, slugify } from "./util.js";

/** The only corpus `schemaVersion` this loader understands. Manifests with
 * a different version load as data but produce an issue; tests reject
 * them. Bump on a breaking case-schema change. */
export const SUPPORTED_CORPUS_SCHEMA_VERSION = 1;

/** The fixed coverage categories. Every case declares exactly one. */
export const CORPUS_CATEGORIES = [
  "exact-facts",
  "paraphrase",
  "code-identifiers",
  "multi-token",
  "subsystem-paths",
  "superseded",
  "temporal",
  "ambiguity",
  "distractors",
  "abstention",
] as const;

export type CorpusCategory = (typeof CORPUS_CATEGORIES)[number];

/** Binding per-category case minimums (corpus contract, turn 2). A corpus
 * below quota in any category is incomplete. Enforcement lives in the
 * test layer, not the loader: minimal or work-in-progress corpora stay
 * clean for loader consumers. */
export const CORPUS_QUOTAS: Readonly<Record<CorpusCategory, number>> = {
  "exact-facts": 25,
  paraphrase: 20,
  "code-identifiers": 20,
  "multi-token": 20,
  "subsystem-paths": 15,
  superseded: 15,
  temporal: 15,
  ambiguity: 10,
  distractors: 10,
  abstention: 10,
};

/** Sum of the binding per-category quotas: the corpus total floor. */
export const CORPUS_QUOTA_TOTAL = CORPUS_CATEGORIES.reduce((sum, c) => sum + CORPUS_QUOTAS[c], 0);

/** Case scopes mirror engram scopes. */
export type CorpusScope = Scope;

/** Corpus-level versioning and defaults (see `corpus/manifest.json`). */
export interface CorpusManifest {
  /** Bump on a breaking case-schema change; see
   * `SUPPORTED_CORPUS_SCHEMA_VERSION`. */
  readonly schemaVersion: number;
  /** Semver of the corpus data itself (case and fixture set). */
  readonly corpusVersion: string;
  readonly name: string;
  readonly description: string;
  /** Fixed evaluation timestamp for cases without their own `now`.
   * ISO 8601 with explicit zone. Keeps evaluation clock-free. */
  readonly defaultNow?: string | undefined;
}

/** One labeled retrieval case (`corpus/cases/*.json`). Field semantics are
 * documented in `corpus/README.md`; the validator below is normative. */
export interface CorpusCase {
  /** Stable unique id, `case-<category>-<nn>`. */
  readonly id: string;
  /** Exact query string handed to the search function. */
  readonly query: string;
  readonly category: CorpusCategory;
  /** Memory ids that must appear in the results. */
  readonly requiredIds: ReadonlyArray<string>;
  /** Acceptable additional ids (not asserted, documented intent). */
  readonly supportingIds: ReadonlyArray<string>;
  /** Stale or contradictory ids that must not appear. */
  readonly forbiddenIds: ReadonlyArray<string>;
  /** Which store the query targets; evaluation filters fixtures to it. */
  readonly scope: CorpusScope;
  /** Subsystem path prefixes the query applies to. */
  readonly applicablePaths: ReadonlyArray<string>;
  /** True only for abstention cases; requires empty required and
   * supporting ids and empty results. */
  readonly expectEmpty: boolean;
  /** Pass/fail rationale. */
  readonly notes: string;
  /** Fixed evaluation timestamp for this case (temporal cases). */
  readonly now?: string | undefined;
  /** Fixed result limit for ranking-sensitive cases. */
  readonly limit?: number | undefined;
  /** Re-include inactive (superseded/archived/expired) fixtures. */
  readonly includeInactive?: boolean | undefined;
  /** Duplicate queries are allowed only here: an ambiguity case pointing
   * at the case it duplicates (same query, different information need). */
  readonly duplicateOf?: string | undefined;
}

/** One diagnostic from loading or validating the corpus. */
export interface CorpusIssue {
  /** File the issue came from (relative name, or "manifest.json"). */
  readonly file: string;
  readonly message: string;
}

/** A fixture engram plus the file it came from. */
export interface CorpusEngramRecord {
  readonly engram: Engram;
  /** Fixture file name relative to the corpus `engrams/` directory. */
  readonly file: string;
}

/** Everything one `loadCorpus` call produced. Always fully populated;
 * defects surface as `issues`, never as throws, so one bad file cannot
 * hide the state of the rest. */
export interface LoadedCorpus {
  /** Undefined only when manifest.json is missing or unparsable. */
  readonly manifest: CorpusManifest | undefined;
  /** Sorted by engram id. */
  readonly engrams: ReadonlyArray<CorpusEngramRecord>;
  /** Sorted by case id. */
  readonly cases: ReadonlyArray<CorpusCase>;
  /** Every defect found, in stable order. */
  readonly issues: ReadonlyArray<CorpusIssue>;
}

/* ------------------------------------------------------------------ */
/* Manifest validation                                                 */
/* ------------------------------------------------------------------ */

const MANIFEST_KEYS = ["schemaVersion", "corpusVersion", "name", "description", "defaultNow"];

/** Validate raw manifest data. Returns human-readable messages; empty
 * means valid. The `file` label is the caller's concern. */
export const validateCorpusManifest = (data: unknown): ReadonlyArray<string> => {
  const messages: string[] = [];
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return ["manifest must be a JSON object"];
  }
  const m = data as Record<string, unknown>;
  for (const key of Object.keys(m)) {
    if (!MANIFEST_KEYS.includes(key)) messages.push(`unknown manifest field "${key}"`);
  }
  const schemaVersion = m.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    messages.push(`"schemaVersion" must be an integer, got ${JSON.stringify(schemaVersion)}`);
  } else if (schemaVersion !== SUPPORTED_CORPUS_SCHEMA_VERSION) {
    messages.push(
      `unsupported schemaVersion ${schemaVersion}; this loader understands ${SUPPORTED_CORPUS_SCHEMA_VERSION}`,
    );
  }
  if (typeof m.corpusVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(m.corpusVersion)) {
    messages.push(
      `"corpusVersion" must be a semver string like "0.1.0", got ${JSON.stringify(m.corpusVersion)}`,
    );
  }
  for (const key of ["name", "description"] as const) {
    const v = m[key];
    if (typeof v !== "string" || v.trim() === "") {
      messages.push(`"${key}" must be a non-empty string`);
    }
  }
  if (
    m.defaultNow !== undefined &&
    (typeof m.defaultNow !== "string" || parseTimestamp(m.defaultNow) === undefined)
  ) {
    messages.push(
      `"defaultNow" must be an ISO 8601 timestamp with zone, e.g. "2026-06-01T00:00:00.000Z"`,
    );
  }
  return messages;
};

/* ------------------------------------------------------------------ */
/* Case validation                                                     */
/* ------------------------------------------------------------------ */

const CASE_KEYS = [
  "id",
  "query",
  "category",
  "requiredIds",
  "supportingIds",
  "forbiddenIds",
  "scope",
  "applicablePaths",
  "expectEmpty",
  "notes",
  "now",
  "limit",
  "includeInactive",
  "duplicateOf",
];

const ID_LIST_KEYS = ["requiredIds", "supportingIds", "forbiddenIds"] as const;

/** `case-<category>-<nn>`: the category spelled out in the id must be the
 * case's category. Built from CORPUS_CATEGORIES so a new category cannot
 * silently skip the convention. */
const caseIdPattern = new RegExp(`^case-(${CORPUS_CATEGORIES.join("|")})-[0-9]{2}$`);

/** Subsystem path prefixes: lowercase slash-delimited, no leading or
 * trailing slash, no empty segments. */
const PATH_PATTERN = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;

/** Validate one raw case object. Pure; returns human-readable messages,
 * empty means valid. Cross-case rules (unique ids, duplicateOf targets,
 * id resolution) are the loader's job because they need the whole corpus. */
export const validateCorpusCase = (data: unknown): ReadonlyArray<string> => {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return ["case must be a JSON object"];
  }
  const c = data as Record<string, unknown>;
  const messages: string[] = [];
  for (const key of Object.keys(c)) {
    if (!CASE_KEYS.includes(key)) messages.push(`unknown case field "${key}"`);
  }

  if (typeof c.id !== "string" || c.id === "") {
    messages.push(`"id" must be a non-empty string`);
  } else if (!caseIdPattern.test(c.id)) {
    messages.push(
      `"id" ${JSON.stringify(c.id)} must match case-<category>-<nn>, e.g. "case-exact-facts-01"`,
    );
  }

  const category = c.category;
  if (!CORPUS_CATEGORIES.includes(category as CorpusCategory)) {
    messages.push(`"category" must be one of: ${CORPUS_CATEGORIES.join(", ")}`);
  } else if (typeof c.id === "string" && !c.id.startsWith(`case-${String(category)}-`)) {
    messages.push(`"id" ${JSON.stringify(c.id)} must start with "case-${String(category)}-"`);
  }

  if (typeof c.query !== "string" || c.query.trim() === "") {
    messages.push(`"query" must be a non-empty string`);
  }

  const idLists: Partial<Record<(typeof ID_LIST_KEYS)[number], ReadonlyArray<string>>> = {};
  for (const key of ID_LIST_KEYS) {
    const v = c[key];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      messages.push(`"${key}" must be an array of strings`);
      continue;
    }
    const list = v as ReadonlyArray<string>;
    idLists[key] = list;
    const seen = new Set<string>();
    for (const id of list) {
      if (id === "") messages.push(`"${key}" contains an empty id`);
      if (seen.has(id)) messages.push(`"${key}" contains duplicate id ${JSON.stringify(id)}`);
      seen.add(id);
    }
  }
  const [required, supporting, forbidden] = [
    new Set(idLists.requiredIds ?? []),
    new Set(idLists.supportingIds ?? []),
    new Set(idLists.forbiddenIds ?? []),
  ];
  for (const id of required) {
    if (supporting.has(id)) messages.push(`id ${id} appears in both requiredIds and supportingIds`);
    if (forbidden.has(id)) messages.push(`id ${id} appears in both requiredIds and forbiddenIds`);
  }
  for (const id of supporting) {
    if (forbidden.has(id)) messages.push(`id ${id} appears in both supportingIds and forbiddenIds`);
  }

  if (c.scope !== "project" && c.scope !== "personal") {
    messages.push(`"scope" must be "project" or "personal", got ${JSON.stringify(c.scope)}`);
  }

  if (
    !Array.isArray(c.applicablePaths) ||
    c.applicablePaths.length === 0 ||
    c.applicablePaths.some((p) => typeof p !== "string" || !PATH_PATTERN.test(p))
  ) {
    messages.push(
      `"applicablePaths" must be a non-empty array of lowercase slash-delimited prefixes, e.g. ["core/parser"]`,
    );
  }

  if (typeof c.expectEmpty !== "boolean") {
    messages.push(`"expectEmpty" must be a boolean`);
  }
  const isAbstention = category === "abstention";
  if (c.expectEmpty === true && !isAbstention) {
    messages.push(`"expectEmpty: true" is only valid on abstention cases`);
  }
  if (isAbstention && c.expectEmpty === false) {
    messages.push(`abstention cases must set "expectEmpty: true"`);
  }
  if (c.expectEmpty === true) {
    if ((idLists.requiredIds?.length ?? 0) > 0) {
      messages.push(`abstention cases must have empty "requiredIds"`);
    }
    if ((idLists.supportingIds?.length ?? 0) > 0) {
      messages.push(`abstention cases must have empty "supportingIds"`);
    }
  } else if ((idLists.requiredIds?.length ?? 0) === 0) {
    messages.push(
      `"requiredIds" is empty exactly when "expectEmpty" is true; a case with expectations needs at least one required id`,
    );
  }

  if (typeof c.notes !== "string" || c.notes.trim() === "") {
    messages.push(`"notes" must be a non-empty string (pass/fail rationale)`);
  }

  if (c.now !== undefined && (typeof c.now !== "string" || parseTimestamp(c.now) === undefined)) {
    messages.push(`"now" must be an ISO 8601 timestamp with zone, e.g. "2026-06-01T00:00:00.000Z"`);
  }

  if (
    c.limit !== undefined &&
    (typeof c.limit !== "number" || !Number.isInteger(c.limit) || c.limit < 1)
  ) {
    messages.push(`"limit" must be a positive integer when present`);
  }

  if (c.includeInactive !== undefined && typeof c.includeInactive !== "boolean") {
    messages.push(`"includeInactive" must be a boolean when present`);
  }

  if (c.duplicateOf !== undefined) {
    if (category !== "ambiguity") {
      messages.push(`"duplicateOf" is only valid on ambiguity cases`);
    }
    if (typeof c.duplicateOf !== "string" || c.duplicateOf === "") {
      messages.push(`"duplicateOf" must be a non-empty case id when present`);
    } else if (c.duplicateOf === c.id) {
      messages.push(`"duplicateOf" must point at a different case`);
    }
  }

  return messages;
};

/* ------------------------------------------------------------------ */
/* Loader                                                             */
/* ------------------------------------------------------------------ */

const readJsonFile = (
  file: string,
): { ok: true; data: unknown } | { ok: false; message: string } => {
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
};

/** Deterministic directory listing: plain lexicographic sort of names.
 * I/O failures surface through `onError` instead of throwing, matching
 * the loader's never-throw contract for content and filesystem defects
 * alike. */
const sortedNames = (dir: string, ext: string, onError: (message: string) => void): string[] => {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(ext))
      .sort();
  } catch (e) {
    onError(
      (e as NodeJS.ErrnoException).code === "ENOENT"
        ? "directory is missing"
        : `unreadable: ${(e as Error).message}`,
    );
    return [];
  }
};

/**
 * Load and validate a corpus directory. Never throws for content defects:
 * every problem lands in `issues` so one bad file cannot hide the rest.
 * Filesystem failures for the corpus root itself also land in `issues`.
 */
export const loadCorpus = (corpusDir: string): LoadedCorpus => {
  const issues: CorpusIssue[] = [];
  const issue = (file: string, message: string): void => {
    issues.push({ file, message });
  };

  /* Manifest. */
  let manifest: CorpusManifest | undefined;
  const manifestFile = path.join(corpusDir, "manifest.json");
  if (!fs.existsSync(manifestFile)) {
    issue("manifest.json", "manifest.json is missing");
  } else {
    const parsed = readJsonFile(manifestFile);
    if (!parsed.ok) {
      issue("manifest.json", `invalid JSON: ${parsed.message}`);
    } else {
      const messages = validateCorpusManifest(parsed.data);
      for (const message of messages) issue("manifest.json", message);
      if (typeof parsed.data === "object" && parsed.data !== null && !Array.isArray(parsed.data)) {
        manifest = parsed.data as CorpusManifest;
      }
    }
  }

  /* Engram fixtures: same entry validation the store scan uses
   * (validateEntry), plus the store's cross-file checks: filename shape,
   * filename-id agreement, slug agreement, duplicate ids, dangling
   * supersedes. Per-file I/O errors land in `issues` like every other
   * defect instead of aborting the load. */
  const engramsDir = path.join(corpusDir, "engrams");
  const engramNames = sortedNames(engramsDir, ".md", (message) => issue("engrams/", message));
  const byId = new Map<string, CorpusEngramRecord[]>();
  const engrams: CorpusEngramRecord[] = [];
  for (const name of engramNames) {
    const file = path.join(engramsDir, name);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (e) {
      issue(name, `unreadable: ${(e as Error).message}`);
      continue;
    }
    const validated = validateEntry(raw);
    for (const i of validated.issues) issue(name, `${i.code}: ${i.message}`);

    const parsedName = parseEntryFilename(name);
    if (parsedName === undefined) {
      issue(name, `filename_invalid: filename "${name}" does not follow <id>-<slug>.md`);
    } else if (validated.frontmatter !== undefined) {
      if (parsedName.id !== validated.frontmatter.id) {
        issue(
          name,
          `filename_id_mismatch: filename id "${parsedName.id}" does not match frontmatter id "${validated.frontmatter.id}"`,
        );
      }
      const expectedSlug = slugify(validated.frontmatter.title);
      if (parsedName.slug !== expectedSlug) {
        issue(
          name,
          `filename_slug_mismatch: filename slug "${parsedName.slug}" does not match title (expected "${expectedSlug}")`,
        );
      }
    }

    if (validated.frontmatter === undefined) continue;
    const fm = validated.frontmatter;
    const engram: Engram = {
      id: fm.id,
      title: fm.title,
      type: fm.type,
      tags: fm.tags,
      scope: fm.scope,
      created: fm.created,
      updated: fm.updated,
      author: fm.author,
      pinned: fm.pinned ?? false,
      status: fm.status,
      supersedes: fm.supersedes,
      reviewAfter: fm.reviewAfter,
      expires: fm.expires,
      sourceType: fm.sourceType,
      sourceRef: fm.sourceRef,
      body: validated.content,
      path: file,
    };
    const record: CorpusEngramRecord = { engram, file: name };
    engrams.push(record);
    const claimants = byId.get(fm.id) ?? [];
    claimants.push(record);
    byId.set(fm.id, claimants);
  }
  for (const [id, claimants] of [...byId].sort(([a], [b]) => a.localeCompare(b))) {
    if (claimants.length > 1) {
      issue(
        claimants.map((c) => c.file).join(", "),
        `duplicate_id: duplicate id "${id}" claimed by ${claimants.map((c) => c.file).join(", ")}`,
      );
    }
  }
  for (const { engram } of engrams) {
    if (engram.supersedes !== undefined && !byId.has(engram.supersedes)) {
      issue(
        engram.id,
        `dangling_supersedes: ${engram.id} supersedes missing id ${engram.supersedes}`,
      );
    }
  }
  engrams.sort((a, b) => a.engram.id.localeCompare(b.engram.id));

  /* Cases. */
  const casesDir = path.join(corpusDir, "cases");
  const caseNames = sortedNames(casesDir, ".json", (message) => issue("cases/", message));
  const cases: CorpusCase[] = [];
  const caseFiles = new Map<CorpusCase, string>();
  for (const name of caseNames) {
    const parsed = readJsonFile(path.join(casesDir, name));
    if (!parsed.ok) {
      issue(name, `invalid JSON: ${parsed.message}`);
      continue;
    }
    const messages = validateCorpusCase(parsed.data);
    for (const message of messages) issue(name, message);
    if (messages.length === 0) {
      const c = parsed.data as CorpusCase;
      cases.push(c);
      caseFiles.set(c, name);
    }
  }
  cases.sort((a, b) => a.id.localeCompare(b.id));

  /* Cross-case rule: case ids are unique. Every claimant file is listed,
   * mirroring the duplicate-id rule for fixtures. */
  const idClaims = new Map<string, string[]>();
  for (const c of cases) {
    const file = caseFiles.get(c) as string;
    const claimants = idClaims.get(c.id) ?? [];
    claimants.push(file);
    idClaims.set(c.id, claimants);
  }
  for (const [id, files] of [...idClaims].sort(([a], [b]) => a.localeCompare(b))) {
    if (files.length > 1) {
      issue(files.join(", "), `duplicate_case_id: case id "${id}" claimed by ${files.join(", ")}`);
    }
  }

  /* Cross-case rule: duplicate queries only through duplicateOf. Each
   * duplicate must point at an existing ambiguity case with the same
   * query, and targets must not chain. */
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const queryCounts = new Map<string, number>();
  for (const c of cases) queryCounts.set(c.query, (queryCounts.get(c.query) ?? 0) + 1);
  for (const c of cases) {
    if (c.duplicateOf === undefined) continue;
    const target = caseById.get(c.duplicateOf);
    if (target === undefined) {
      issue(c.id, `duplicateOf points at missing case ${c.duplicateOf}`);
      continue;
    }
    if (target.category !== "ambiguity" || c.category !== "ambiguity") {
      issue(c.id, `duplicateOf pairs must both be ambiguity cases`);
    }
    if (target.query !== c.query) {
      issue(c.id, `duplicateOf target ${target.id} has a different query`);
    }
    if (target.duplicateOf !== undefined) {
      issue(c.id, `duplicateOf target ${target.id} must not itself use duplicateOf`);
    }
  }
  for (const [query, count] of [...queryCounts].sort(([a], [b]) => a.localeCompare(b))) {
    if (count < 2) continue;
    const members = cases.filter((c) => c.query === query);
    const canonicals = members.filter((c) => c.duplicateOf === undefined);
    if (canonicals.length !== 1) {
      issue(
        members.map((c) => c.id).join(", "),
        `duplicate query group must have exactly one canonical case without duplicateOf, found ${canonicals.length}`,
      );
    }
  }

  /* Every referenced id must resolve to a fixture in the same scope. */
  const scopeById = new Map(engrams.map((e) => [e.engram.id, e.engram.scope]));
  for (const c of cases) {
    for (const id of [...c.requiredIds, ...c.supportingIds, ...c.forbiddenIds]) {
      if (!byId.has(id)) {
        issue(c.id, `unresolved id: ${id} does not match any fixture engram`);
      } else if (scopeById.get(id) !== c.scope) {
        issue(
          c.id,
          `scope mismatch: ${id} is ${String(scopeById.get(id))} but the case scope is ${c.scope}`,
        );
      }
    }
  }

  /* Determinism: every case needs a fixed evaluation timestamp, from its
   * own `now` or the manifest `defaultNow`. */
  const defaultNowOk =
    manifest?.defaultNow !== undefined && parseTimestamp(manifest.defaultNow) !== undefined;
  for (const c of cases) {
    if (c.now === undefined && !defaultNowOk) {
      issue(
        c.id,
        `no fixed timestamp: the case has no "now" and the manifest has no valid "defaultNow"`,
      );
    }
  }

  issues.sort((a, b) => a.file.localeCompare(b.file) || a.message.localeCompare(b.message));
  return { manifest, engrams, cases, issues };
};

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

/** The fixed evaluation timestamp for one case: the case's `now`, else
 * the manifest's `defaultNow`. Consults only those two sources; the
 * `defaultNowMs` fallback for callers without a manifest belongs to
 * `evaluateCase`, which applies it after this helper returns undefined.
 * Undefined only when the corpus violates the contract (the loader flags
 * that as an issue). */
export const resolveCaseNowMs = (
  c: CorpusCase,
  manifest: CorpusManifest | undefined,
): number | undefined => {
  if (c.now !== undefined) return parseTimestamp(c.now);
  if (manifest?.defaultNow !== undefined) return parseTimestamp(manifest.defaultNow);
  return undefined;
};

/**
 * The pinned evaluation procedure, executable form (see
 * `corpus/README.md`, "Evaluation procedure"):
 *
 *   1. filter the corpus engrams to the case's scope;
 *   2. call searchEngrams(scoped, case.query, case.limit (default: no
 *      limit), { includeInactive: case.includeInactive (default: false),
 *      now: epochMs(case.now || manifest.defaultNow) }).
 *
 * No clock reads: a missing `now` and `defaultNow` is a corpus defect the
 * loader reports, and this function throws rather than falling back to
 * the wall clock. This function owns the `defaultNowMs` fallback:
 * `resolveCaseNowMs` consults only the case's `now` and the manifest's
 * `defaultNow`, and callers with a loaded manifest simply pass what it
 * resolved. A case passes when every required id appears in the
 * result ids, no forbidden id appears, and abstention cases return no
 * results at all.
 */
export const evaluateCase = (
  engrams: ReadonlyArray<Engram>,
  c: CorpusCase,
  defaultNowMs?: number,
): SearchResult[] => {
  const scoped = engrams.filter((e) => e.scope === c.scope);
  const nowMs = resolveCaseNowMs(c, undefined) ?? defaultNowMs;
  if (nowMs === undefined) {
    throw new Error(`case ${c.id} has no fixed timestamp; refusing to read the wall clock`);
  }
  return searchEngrams(scoped, c.query, c.limit, {
    includeInactive: c.includeInactive ?? false,
    now: nowMs,
  });
};

/** True when the id shape matches an engram id (legacy 4-digit or 26-char
 * base32). Re-exported shape check used by fixture filename rules. */
export const isEngramId = isValidId;
