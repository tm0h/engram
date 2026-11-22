import { createHash } from "node:crypto";
import type { Engram } from "./domain.js";

const segments = (path: string) => path.split("/");

export function parseRepositoryReference(ref: string) {
  // eslint-disable-next-line no-control-regex
  const match = /^git:([0-9a-f]{40}|[0-9a-f]{64}):([^\\\x00-\x1f\x7f]+)$/.exec(ref);
  if (
    !match ||
    /[:]/.test(match[2]) ||
    segments(match[2]).some((part) =>
      ["", ".", "..", ".git", ".engram"].includes(part.toLowerCase()),
    )
  )
    return undefined;
  return { revision: match[1], path: match[2] };
}

export function correctionBaseline({ path: _path, ...entry }: Engram): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}
