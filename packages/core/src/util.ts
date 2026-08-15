/**
 * Small standalone utilities.
 */
import { Effect } from "effect";
import { execSync } from "node:child_process";

export const nowISO = (): string => new Date().toISOString();

export const slugify = (input: string): string => {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "engram";
};

export const parseTags = (input?: string): ReadonlyArray<string> => {
  if (!input) return [];
  return Array.from(
    new Set(
      input
        .split(/[,\s]+/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
};

export const padId = (n: number): string => String(n).padStart(4, "0");

export const numericId = (id: string): number => {
  const n = parseInt(id, 10);
  return Number.isFinite(n) ? n : 0;
};

export const truncate = (s: string, n: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
};

/** Best-effort author detection via git config, falling back to env. */
export const detectAuthor = (): Effect.Effect<string> =>
  Effect.sync(() => {
    try {
      const name = execSync("git config user.name", {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      if (name) return name;
    } catch {
      /* ignore */
    }
    return process.env.USER || process.env.USERNAME || "unknown";
  });
