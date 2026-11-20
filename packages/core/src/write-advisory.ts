import { effectiveStatus } from "./domain.js";
import type { Engram, Scope } from "./domain.js";
import { normalizeText } from "./tokenize.js";

export interface WriteCandidate {
  readonly scope: Scope;
  readonly id: string;
  readonly kind: "exact_duplicate" | "likely_duplicate" | "possible_conflict";
}

const exactText = (value: string): string => value.replace(/\r\n?/g, "\n").trim().normalize("NFC");

export const sameWriteContent = (a: Engram, b: Engram): boolean =>
  exactText(a.title) === exactText(b.title) && exactText(a.body) === exactText(b.body);

const stopWords = new Set(
  "a an and are as at be by for from in is it of on or that the this to use using was we with".split(
    " ",
  ),
);
const terms = (text: string): ReadonlySet<string> =>
  new Set(
    (normalizeText(text).match(/[\p{L}\p{N}\p{M}]+/gu) ?? []).filter(
      (word) => !stopWords.has(word),
    ),
  );

const overlap = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
  let shared = 0;
  for (const term of a) if (b.has(term)) shared++;
  const union = a.size + b.size - shared;
  return { shared, similarity: union === 0 ? 0 : shared / union };
};

export function findWriteCandidates(
  proposed: Engram,
  entries: ReadonlyArray<Engram>,
  nowMs: number,
  previous?: Engram,
  supersededId?: string,
): WriteCandidate[] {
  const contentChanged = previous === undefined || !sameWriteContent(previous, proposed);
  const active = effectiveStatus(proposed, nowMs) === "active";
  const checkAdvisories =
    active &&
    (contentChanged ||
      previous?.type !== proposed.type ||
      effectiveStatus(previous, nowMs) === "inactive");
  if (!contentChanged && !checkAdvisories) return [];

  const title = terms(proposed.title);
  const body = terms(proposed.body);
  const tags = new Set(proposed.tags.map(normalizeText));
  const exact: WriteCandidate[] = [];
  const advisory: WriteCandidate[] = [];

  for (const entry of entries) {
    if (entry.scope !== proposed.scope || entry.id === proposed.id) continue;
    const ref = { scope: entry.scope, id: entry.id };
    if (contentChanged && sameWriteContent(proposed, entry)) {
      exact.push({ ...ref, kind: "exact_duplicate" });
      continue;
    }
    if (
      !checkAdvisories ||
      entry.type !== proposed.type ||
      entry.id === supersededId ||
      effectiveStatus(entry, nowMs) === "inactive"
    ) {
      continue;
    }

    const titles = overlap(title, terms(entry.title));
    const bodies = overlap(body, terms(entry.body));
    const sameSubject = titles.shared >= 2 && titles.similarity >= 0.75;
    const sameTitle = titles.shared >= 2 && titles.similarity === 1;
    const sharedTag = entry.tags.some((tag) => tags.has(normalizeText(tag)));

    // A changed preference or decision on the same subject can conflict even
    // when the replacement value shares very few words with the old value.
    if (
      (proposed.type === "preference" || proposed.type === "decision") &&
      body.size > 0 &&
      entry.body.trim() !== "" &&
      bodies.similarity < 1 &&
      (sameTitle || (sameSubject && (sharedTag || bodies.shared >= 3)))
    ) {
      advisory.push({ ...ref, kind: "possible_conflict" });
    } else if (
      (sameSubject && bodies.shared >= 3 && bodies.similarity >= 0.6) ||
      (sharedTag &&
        titles.shared >= 2 &&
        titles.similarity >= 0.4 &&
        bodies.shared >= 5 &&
        bodies.similarity >= 0.85)
    ) {
      advisory.push({ ...ref, kind: "likely_duplicate" });
    }
  }

  return (exact.length ? exact : advisory).sort((a, b) => a.id.localeCompare(b.id));
}
