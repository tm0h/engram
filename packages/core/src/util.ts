/**
 * Small standalone utilities.
 */
import { Effect } from "effect";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";

/** Crockford base32, lowercase (filesystem-safe, no i/l/o/u). */
const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";

let lastTime = -1;
let lastRandom = "";

const encodeTime = (t: number): string => {
  let s = "";
  for (let i = 0; i < 10; i++) {
    s = BASE32[t % 32] + s;
    t = Math.floor(t / 32);
  }
  return s;
};

/** Increment a base32 string by one (big-endian, with carry). */
const incrementBase32 = (s: string): string => {
  const chars = s.split("");
  for (let i = chars.length - 1; i >= 0; i--) {
    const v = BASE32.indexOf(chars[i]);
    if (v < 31) {
      chars[i] = BASE32[v + 1];
      return chars.join("");
    }
    chars[i] = "0";
  }
  return "0".repeat(s.length);
};

/**
 * A ULID-style identifier: 10 chars of millisecond timestamp + 16 chars of
 * randomness, lowercase base32.
 *
 * Properties that matter here:
 * - **Globally unique without coordination** — any machine, session, or CI
 *   run can mint ids concurrently; merged branches can never collide on id.
 * - **Lexicographically sortable** — sort order equals creation order, so
 *   listing needs no shared counter. Within one process ids are strictly
 *   monotonic (same-millisecond draws increment the random part).
 *
 * Legacy stores use 4-digit numeric ids ("0001"); both formats coexist.
 */
export const newId = (): string => {
  // A backwards clock step (NTP correction, VM resume) must not produce a
  // smaller id than the last one issued — clamp to the high-water mark.
  const t = Math.max(Date.now(), lastTime);
  if (t === lastTime && lastRandom) {
    lastRandom = incrementBase32(lastRandom);
    return encodeTime(t) + lastRandom;
  }
  lastTime = t;
  let n = 0n;
  for (const b of randomBytes(10)) n = (n << 8n) | BigInt(b);
  let s = "";
  for (let i = 0; i < 16; i++) {
    s = BASE32[Number(n & 31n)] + s;
    n >>= 5n;
  }
  lastRandom = s;
  return encodeTime(t) + s;
};

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
