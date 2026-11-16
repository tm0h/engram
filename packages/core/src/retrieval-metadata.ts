import { normalizeAliases, validateAliases } from "./util.js";

/** Repository-relative paths only. Reject traversal on either platform. */
export function validRetrievalPath(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[a-z]:/i.test(value) &&
    !Array.from(value).some((char) => char.charCodeAt(0) < 32) &&
    value.split("/").every((part) => part !== ".." && part !== "." && part !== "")
  );
}

export function metadataErrors(field: "triggers" | "appliesTo", values: unknown): string[] {
  if (!Array.isArray(values)) return [`${field} must be a list of strings`];
  if (field === "triggers")
    return validateAliases(values).map((issue) => issue.message.replaceAll("aliases", "triggers"));
  if (values.length > 20) return ["appliesTo accepts at most 20 patterns"];
  return values.flatMap((value) =>
    typeof value !== "string" ||
    value.length > 256 ||
    !validRetrievalPath(value) ||
    /[[\]{}!?]/.test(value)
      ? ["appliesTo requires relative paths or globs (*, **), without traversal"]
      : [],
  );
}

export const normalizeMetadata = (
  field: "triggers" | "appliesTo",
  values: readonly string[],
): readonly string[] => (field === "triggers" ? normalizeAliases(values) : [...new Set(values)]);

/** Wildcard matching with rolling dynamic-programming rows. Each pattern
 * character/path character pair is visited at most once: no regex backtracking.
 * Memory is linear in path length. */
function segmentApplies(pattern: string, segment: string): boolean {
  let previous = Array.from({ length: segment.length + 1 }, () => false);
  previous[0] = true;
  for (const char of pattern.split("")) {
    const next = Array.from({ length: segment.length + 1 }, () => false);
    next[0] = char === "*" && previous[0]!;
    for (let i = 1; i <= segment.length; i++) {
      next[i] =
        char === "*" ? previous[i]! || next[i - 1]! : previous[i - 1]! && char === segment[i - 1];
    }
    previous = next;
  }
  return previous[segment.length]!;
}

/** * matches within a segment; ** matches zero or more complete segments.
 * Total work is O(pattern length * path length), including segment matching. */
export function pathApplies(pattern: string, currentPath: string): boolean {
  const segments = currentPath.split("/");
  let previous = Array.from({ length: segments.length + 1 }, () => false);
  previous[0] = true;
  for (const part of pattern.split("/")) {
    const next = Array.from({ length: segments.length + 1 }, () => false);
    next[0] = part === "**" && previous[0]!;
    for (let i = 1; i <= segments.length; i++) {
      next[i] =
        part === "**"
          ? previous[i]! || next[i - 1]!
          : previous[i - 1]! && segmentApplies(part, segments[i - 1]!);
    }
    previous = next;
  }
  return previous[segments.length]!;
}
