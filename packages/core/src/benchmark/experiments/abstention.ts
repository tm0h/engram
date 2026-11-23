import { evaluateCase } from "@engram/core/corpus";
import { abstentionEligible } from "../../abstention.js";
import { parseQuery } from "../../query.js";
import { normalizeText } from "../../tokenize.js";
import type { EvaluateFn } from "../types.js";

// Small families of relation phrases, independent of product names. A query
// outside these families leaves the lexical result alone.
const intentPatterns = {
  domainAcquisition:
    /\b(?:(?:buy(?:ing)?|purchas(?:e|es|ing)|register(?:ing)?) (?:an? |the |new |custom |existing ){0,3}(?:domains?|domain names?)|domain (?:purchases?|acquisition|registration))\b/u,
  collaborativeEditing:
    /\b(?:collaborative edit(?:ing|s)?|co edit(?:ing|s)?|edit(?:ing)? together|multi user editing|simultaneous editing)\b/u,
};

const fold = (value: string): string => normalizeText(value).replace(/[^\p{L}\p{N}\p{M}]+/gu, " ");

// Shadow the verifier over the real, already-scoped manual ranking with only
// one possible change: suppress the whole result if an intent is unsupported.
export const evaluateIntentAbstention: EvaluateFn = (entries, query, now) => {
  const results = evaluateCase(entries, query, now);
  if (results.length === 0 || !abstentionEligible(parseQuery(query.query))) return results;

  const foldedQuery = fold(query.query);
  const intents = Object.values(intentPatterns).filter((pattern) => pattern.test(foldedQuery));
  if (intents.length === 0) return results;

  const exactQuery = normalizeText(query.query.trim());
  if (
    results.some(({ engram }) =>
      engram.triggers?.some((trigger) => normalizeText(trigger.trim()) === exactQuery),
    )
  ) {
    return results;
  }

  const evidence = results.map(({ engram }) => [fold(engram.title), fold(engram.body)]);
  // Require all requested relations in one result. Scan title and body
  // independently so words across field boundaries cannot form a phrase.
  return evidence.some((fields) =>
    intents.every((intent) => fields.some((field) => intent.test(field))),
  )
    ? results
    : [];
};
