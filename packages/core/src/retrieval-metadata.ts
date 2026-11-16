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

/** * matches within a segment; ** matches zero or more complete segments. */
export function pathApplies(pattern: string, currentPath: string): boolean {
  const parts = pattern.split("/");
  const regex = parts
    .map((part, index) => {
      if (part === "**") return index === parts.length - 1 ? ".*" : "(?:[^/]+/)*";
      const segment = part
        .split("*")
        .map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*");
      return segment + (index < parts.length - 1 ? "/" : "");
    })
    .join("");
  return new RegExp(`^${regex}$`).test(currentPath);
}
