import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const core = "packages/core/src/";
const harnesses = "packages/harnesses/src/";
const corpus = "corpus/capture/";
const sources = [
  ...[
    "atomic-file",
    "capture-admission",
    "capture-control",
    "capture-corpus",
    "capture-lock",
    "capture-policy",
    "capture-rules",
    "capture-score",
    "config",
    "domain",
    "frontmatter",
    "integrity",
    "location",
    "pack-source",
    "pending-store",
    "repository-reference",
    "secrets",
    "store",
    "write-advisory",
  ].map((name) => core + name + ".ts"),
  ...["pi/capture-hook", "pi/index", "opencode/capture-command", "opencode/index"].map(
    (name) => harnesses + name + ".ts",
  ),
  "packages/harnesses/package.json",
  "pnpm-lock.yaml",
  corpus + "manifest.json",
  ...readdirSync(new URL(corpus + "sessions/", root))
    .filter((name) => name.endsWith(".json"))
    .map((name) => corpus + "sessions/" + name),
];

export function captureFingerprint() {
  const hash = createHash("sha256");
  for (const file of sources.sort()) {
    hash.update(file + "\0");
    hash.update(readFileSync(new URL(file, root)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify({ fingerprint: captureFingerprint() }, null, 2));
}
