/**
 * Release preparation: bump every synchronized version location and open the
 * CHANGELOG section for a new version.
 *
 * All transforms are pure string functions so the vitest suite
 * (packages/cli/test/release-prep.test.ts) can exercise them without touching
 * the working tree. The CLI wrapper at the bottom is a thin, all-or-nothing
 * applier: nothing is written unless every location transforms cleanly and
 * the self-verification passes.
 *
 * Locations kept in sync (AGENTS.md "Release process"):
 *   1. packages/cli/package.json
 *   2. packages/cli/src/index.ts (.version())
 *   3. packages/harnesses/package.json
 *   4. packages/harnesses/claude/.claude-plugin/plugin.json
 *   5. packages/harnesses/claude/bin/engram (npx pin)
 * plus the Pi README install pins and the root CHANGELOG entry.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, cwd, exit } from "node:process";

/** Strict X.Y.Z: no prerelease, no build metadata, no leading zeros. */
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Parse and normalize a version argument. Accepts an optional `v` prefix. */
export function parseVersion(input: string): string {
  const v = input.trim().replace(/^v/, "");
  if (!SEMVER_RE.test(v)) {
    throw new Error(
      `invalid version "${input}": expected strict X.Y.Z (no prerelease, no build metadata, no leading zeros)`,
    );
  }
  return v;
}

/** Compare two already-validated stable semantic versions. */
function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(BigInt);
  const rightParts = right.split(".").map(BigInt);
  for (let i = 0; i < leftParts.length; i++) {
    if (leftParts[i] > rightParts[i]) return 1;
    if (leftParts[i] < rightParts[i]) return -1;
  }
  return 0;
}

export interface ReleaseInputs {
  /** packages/cli/package.json */
  cliPkg: string;
  /** packages/cli/src/index.ts */
  indexTs: string;
  /** packages/harnesses/package.json */
  harnessesPkg: string;
  /** packages/harnesses/claude/.claude-plugin/plugin.json */
  pluginJson: string;
  /** packages/harnesses/claude/bin/engram */
  binSh: string;
  /** packages/harnesses/src/pi/README.md */
  piReadme: string;
  /** CHANGELOG.md */
  changelog: string;
}

export interface PreparedRelease {
  files: ReleaseInputs;
  changes: string[];
}

interface VersionedLocation {
  label: string;
  versions: (content: string) => string[];
  bump: (content: string, version: string) => string;
}

/** All regexes expect exactly the bare X.Y.Z forms this script writes. */
const LOCATIONS: VersionedLocation[] = [
  {
    label: "packages/cli/package.json",
    versions: (c) => [jsonVersion(c, "packages/cli/package.json")],
    bump: (c, v) => bumpJson(c, v),
  },
  {
    label: "packages/cli/src/index.ts",
    versions: (c) => regexVersions(c, /\.version\("(\d+\.\d+\.\d+)"/g, "packages/cli/src/index.ts"),
    bump: (c, v) =>
      replaceAll(c, /(\.version\(")\d+\.\d+\.\d+(")/g, `$1${v}$2`, "packages/cli/src/index.ts"),
  },
  {
    label: "packages/harnesses/package.json",
    versions: (c) => [jsonVersion(c, "packages/harnesses/package.json")],
    bump: (c, v) => bumpJson(c, v),
  },
  {
    label: "packages/harnesses/claude/.claude-plugin/plugin.json",
    versions: (c) => [jsonVersion(c, "plugin.json")],
    bump: (c, v) => bumpJson(c, v),
  },
  {
    label: "packages/harnesses/claude/bin/engram",
    versions: (c) => regexVersions(c, /engram-cli@(\d+\.\d+\.\d+)/g, "bin/engram"),
    bump: (c, v) => replaceAll(c, /(engram-cli@)\d+\.\d+\.\d+/g, `$1${v}`, "bin/engram"),
  },
  {
    label: "packages/harnesses/src/pi/README.md (npm pin)",
    versions: (c) => regexVersions(c, /engram-cli@(\d+\.\d+\.\d+)/g, "pi README npm pin"),
    bump: (c, v) => replaceAll(c, /(engram-cli@)\d+\.\d+\.\d+/g, `$1${v}`, "pi README npm pin"),
  },
  {
    label: "packages/harnesses/src/pi/README.md (git pin)",
    versions: (c) => regexVersions(c, /engram@v(\d+\.\d+\.\d+)/g, "pi README git pin"),
    bump: (c, v) => replaceAll(c, /(engram@v)\d+\.\d+\.\d+/g, `$1${v}`, "pi README git pin"),
  },
];

function jsonVersion(content: string, label: string): string {
  const parsed: unknown = JSON.parse(content);
  const { version } = parsed as { version?: unknown };
  if (typeof version !== "string" || !SEMVER_RE.test(version)) {
    throw new Error(`${label}: no strict X.Y.Z "version" field found`);
  }
  return version;
}

function bumpJson(content: string, version: string): string {
  const doc = JSON.parse(content) as Record<string, unknown>;
  doc.version = version;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function regexVersions(content: string, re: RegExp, label: string): string[] {
  const found = [...content.matchAll(re)].map((m) => m[1]);
  if (found.length === 0) {
    throw new Error(`${label}: no version pin found`);
  }
  return found;
}

function replaceAll(content: string, re: RegExp, replacement: string, label: string): string {
  if (!new RegExp(re.source, re.flags.replace("g", "")).test(content)) {
    throw new Error(`${label}: expected pattern not found, refusing to write`);
  }
  return content.replace(re, replacement);
}

/** `git+https://github.com/<org>/<repo>.git` -> `https://github.com/<org>/<repo>`. */
function repoUrlFromCliPkg(content: string): string {
  const url = (JSON.parse(content) as { repository?: { url?: string } }).repository?.url;
  if (typeof url !== "string" || !url.startsWith("git+https://") || !url.endsWith(".git")) {
    throw new Error("packages/cli/package.json: unexpected repository.url format");
  }
  return url.slice("git+".length, -".git".length);
}

/**
 * Rotate the CHANGELOG: turn the `## [Unreleased]` section into
 * `## [<version>] - <date>` (Keep a Changelog style) and append the
 * reference-style tag link inside the new section's link block.
 */
export function updateChangelog(
  content: string,
  version: string,
  date: string,
  repoUrl: string,
): string {
  if (!SEMVER_RE.test(version)) {
    throw new Error(`invalid version "${version}": expected strict X.Y.Z`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`invalid date "${date}": expected YYYY-MM-DD`);
  }
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new Error(`invalid date "${date}": expected a real YYYY-MM-DD date`);
  }
  const lines = content.split("\n");
  const unreleased = lines.findIndex((l) => l.trim() === "## [Unreleased]");
  if (unreleased === -1) {
    throw new Error("CHANGELOG.md: no `## [Unreleased]` heading found");
  }
  const escaped = version.replace(/[.]/g, "\\.");
  if (new RegExp(`^## \\[${escaped}\\]`, "m").test(content)) {
    throw new Error(`CHANGELOG.md: a section for ${version} already exists`);
  }
  const isH2 = (l: string): boolean => /^##(?!#)/.test(l);
  let next = lines.length;
  for (let i = unreleased + 1; i < lines.length; i++) {
    if (isH2(lines[i])) {
      next = i;
      break;
    }
  }
  const body = lines.slice(unreleased + 1, next);
  while (body.length > 0 && body[0].trim() === "") body.shift();
  while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
  const refLine = `[${version}]: ${repoUrl}/releases/tag/v${version}`;
  if (body.length === 0) {
    body.push(refLine);
  } else if (/^\[[^\]]+\]: /.test(body[body.length - 1])) {
    body.push(refLine);
  } else {
    body.push("", refLine);
  }
  return [
    ...lines.slice(0, unreleased + 1),
    "",
    `## [${version}] - ${date}`,
    "",
    ...body,
    "",
    ...lines.slice(next),
  ].join("\n");
}

/**
 * Compute every new file content for the release. Fails closed: refuses on
 * drift between locations, an existing CHANGELOG section, or any location
 * whose pattern cannot be found. Nothing here performs I/O.
 */
export function prepareRelease(
  input: ReleaseInputs,
  version: string,
  date: string,
): PreparedRelease {
  const v = parseVersion(version);
  const current: Array<[string, string[]]> = LOCATIONS.map((loc) => [
    loc.label,
    loc.versions(input[inputsKey(loc)]),
  ]);
  const reference = current[0][1][0];
  const drifted = current.flatMap(([label, vs]) =>
    vs.filter((x) => x !== reference).map((x) => `${label} has ${x}`),
  );
  if (drifted.length > 0) {
    throw new Error(
      `version locations have drifted (expected ${reference} everywhere): ${drifted.join("; ")}`,
    );
  }
  if (compareVersions(v, reference) <= 0) {
    throw new Error(`target version ${v} must be greater than ${reference}`);
  }
  const repoUrl = repoUrlFromCliPkg(input.cliPkg);
  const files: ReleaseInputs = {
    ...input,
    changelog: updateChangelog(input.changelog, v, date, repoUrl),
  };
  // Bumps compose: the two Pi README pins transform the same file in sequence.
  for (const loc of LOCATIONS) {
    const key = inputsKey(loc);
    files[key] = loc.bump(files[key], v);
  }
  // Self-verification: re-extract from the outputs; every location must now
  // carry the target version and the CHANGELOG must contain the new section.
  for (const loc of LOCATIONS) {
    const key = inputsKey(loc);
    const stale = loc.versions(files[key]).filter((x) => x !== v);
    if (stale.length > 0) {
      throw new Error(`self-verification failed for ${loc.label}: still has ${stale.join(", ")}`);
    }
  }
  if (!files.changelog.includes(`## [${v}] - ${date}`)) {
    throw new Error("self-verification failed: CHANGELOG section missing after update");
  }
  const changes = LOCATIONS.map((loc) => `${loc.label}: ${reference} -> ${v}`);
  changes.push(`CHANGELOG.md: opened ## [${v}] - ${date}`);
  return { files, changes };
}

// Map a location entry onto its ReleaseInputs key. The mapping is positional
// and 1:1; spelled out here so both loops above stay in lockstep.
function inputsKey(loc: VersionedLocation): keyof ReleaseInputs {
  const order: Array<keyof ReleaseInputs> = [
    "cliPkg",
    "indexTs",
    "harnessesPkg",
    "pluginJson",
    "binSh",
    "piReadme",
    "piReadme",
  ];
  const idx = LOCATIONS.indexOf(loc);
  return order[idx];
}

/**
 * CLI entry: `tsx scripts/release-prep.ts <version> [--root <dir>] [--date YYYY-MM-DD]`.
 * Reads the seven files, computes everything, verifies, then writes.
 */
function main(): number {
  const args = argv.slice(2);
  const positional: string[] = [];
  let root = cwd();
  let date = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root") {
      root = resolve(args[++i] ?? "");
    } else if (args[i] === "--date") {
      date = args[++i] ?? "";
    } else {
      positional.push(args[i]);
    }
  }
  if (positional.length !== 1) {
    console.error(
      "usage: tsx scripts/release-prep.ts <version> [--root <dir>] [--date YYYY-MM-DD]",
    );
    return 2;
  }
  const paths: Array<[keyof ReleaseInputs, string]> = [
    ["cliPkg", "packages/cli/package.json"],
    ["indexTs", "packages/cli/src/index.ts"],
    ["harnessesPkg", "packages/harnesses/package.json"],
    ["pluginJson", "packages/harnesses/claude/.claude-plugin/plugin.json"],
    ["binSh", "packages/harnesses/claude/bin/engram"],
    ["piReadme", "packages/harnesses/src/pi/README.md"],
    ["changelog", "CHANGELOG.md"],
  ];
  const input = Object.fromEntries(
    paths.map(([key, rel]) => [key, readFileSync(resolve(root, rel), "utf8")]),
  ) as unknown as ReleaseInputs;
  const { files, changes } = prepareRelease(input, positional[0], date);
  try {
    for (const [key, rel] of paths) {
      writeFileSync(resolve(root, rel), files[key]);
    }
  } catch (error) {
    for (const [key, rel] of paths) {
      try {
        writeFileSync(resolve(root, rel), input[key]);
      } catch {
        // Preserve the original write error. A later run can repair this file.
      }
    }
    throw error;
  }
  for (const change of changes) {
    console.log(change);
  }
  console.log(`release ${positional[0]} prepared in ${root}`);
  return 0;
}

/* Run only when executed directly, so vitest can import this module. */
const invoked = argv[1] ? resolve(argv[1]) : "";
if (invoked.endsWith("release-prep.ts")) {
  try {
    exit(main());
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    exit(1);
  }
}
