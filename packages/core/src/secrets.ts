/**
 * ENG-15: deterministic secret and prompt-injection scanning.
 *
 * Pure functions only: no I/O, no clock, no randomness. `scanContent`
 * finds security-relevant content; findings carry category, stable rule
 * id, 1-based line, 1-based code-point column, and a generic note. A
 * finding NEVER contains the matched text, so findings are safe to log,
 * render, and serialize anywhere.
 *
 * Detection is deliberately conservative: bare hashes, UUIDs, and
 * ULID-style ids pass unflagged, while values assigned to secret-named
 * fields are detected regardless of their charset.
 */
import type { Scope, SecretPolicy } from "./domain.js";

/** What kind of security-relevant content was found. */
export type SecretCategory =
  | "credential"
  | "high-entropy"
  | "private-key"
  | "invisible-unicode"
  | "prompt-injection"
  | "exfiltration";

/** One deterministic scan finding. Redacted by construction: no matched
 * text, only where (rule, line, column) and a generic note. */
export interface SecretFinding {
  readonly category: SecretCategory;
  /** Stable rule identifier, safe to match on across releases. */
  readonly rule: string;
  /** 1-based line number in the normalized (LF) text. */
  readonly line: number;
  /** 1-based column in Unicode code points within the line. */
  readonly column: number;
  /** Generic human-readable note. Never quotes the matched text. */
  readonly note: string;
}

/** Write policy for scan results (defined with the config schema in
 * domain.ts so persisted configuration and the scanner share one type). */
export type { SecretPolicy } from "./domain.js";

/** The outcome of a scan under a resolved policy: whether a write must be
 * blocked, which (redacted) findings apply, and whether an explicit
 * override let a blocked write through. */
export interface ScanEvaluation {
  readonly policy: SecretPolicy;
  readonly findings: ReadonlyArray<SecretFinding>;
  readonly blocked: boolean;
  readonly overrideUsed: boolean;
}

const NOTES: Record<SecretCategory, string> = {
  credential: "Possible credential detected; remove it and rotate the credential if it is real.",
  "high-entropy":
    "High-entropy token in a quoted string; store secrets in a dedicated manager instead.",
  "private-key": "Private key marker detected; private keys must not be stored in memory files.",
  "invisible-unicode":
    "Invisible Unicode character detected; such characters can hide or reorder content.",
  "prompt-injection": "Text resembling a prompt-injection instruction detected.",
  exfiltration: "Instruction resembling credential exfiltration detected.",
};

/* --------------------------- rule engines --------------------------- */

interface RuleMatch {
  readonly rule: string;
  readonly category: SecretCategory;
  readonly index: number;
}

const providerRules: ReadonlyArray<{ regex: RegExp; rule: string; category: SecretCategory }> = [
  {
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    rule: "SEC-CRED-AWS-KEY-ID",
    category: "credential",
  },
  {
    regex: /\bgh[posur]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    rule: "SEC-CRED-GITHUB-TOKEN",
    category: "credential",
  },
  {
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    rule: "SEC-CRED-OPENAI-KEY",
    category: "credential",
  },
  {
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
    rule: "SEC-KEY-PRIVATE-MARKER",
    category: "private-key",
  },
  {
    regex: /[\u00AD\u200B\u200C\u200D\u2060-\u2064\uFEFF]/g,
    rule: "SEC-UNICODE-ZERO-WIDTH",
    category: "invisible-unicode",
  },
  {
    regex: /[\u202A-\u202E\u2066-\u2069]/g,
    rule: "SEC-UNICODE-BIDI",
    category: "invisible-unicode",
  },
  {
    /* Imperative-shaped override instructions only, so descriptive
     * prose ("resists prompt injection") is not flagged. */
    regex:
      /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)\s+instructions?\b|\bdisregard\s+(?:all\s+|the\s+)?[\w\s]{0,20}?(?:instructions?|rules?)\b|\breveal\s+your\s+(?:system\s+)?(?:prompt|instructions?)\b/gi,
    rule: "SEC-INJECT-OVERRIDE",
    category: "prompt-injection",
  },
  {
    regex:
      /\b(?:send|post|upload|forward|exfiltrate|curl|wget)\b[^.\n]{0,60}?\b(?:api[\s_-]?keys?|secrets?|tokens?|passwords?|passphrases?|credentials?|private[_-]?keys?)\b[^.\n]{0,60}?https?:\/\/|\b(?:curl|wget|https?:\/\/)[^.\n]{0,60}?\b(?:passwords?|secrets?|api[\s_-]?keys?|credentials?)\b/gi,
    rule: "SEC-EXFIL-CREDENTIAL",
    category: "exfiltration",
  },
];

/** Secret-named fields whose assigned values are treated as sensitive
 * even when the value itself looks harmless (for example a bare hash). */
const ASSIGNMENT_RE =
  /\b(api[_-]?key|apikey|secret|client[_-]?secret|secret[_-]?key|access[_-]?key|auth[_-]?token|password|passwd|pwd|private[_-]?key|token)["']?[ \t]*[:=][ \t]*("|')?/gi;

const isPlaceholderValue = (value: string): boolean =>
  value.length < 8 ||
  /^[<{[]/.test(value) ||
  /^\$[A-Z0-9_]+$/.test(value) ||
  /\$\{[^}]*\}/.test(value) ||
  /^(?:changeme|change[-_]?me|placeholder|example|redacted|none|null|nil|true|false|your[-_]?key[-_]?here|x{3,}|y{3,}|z{3,}|\*+|\.+)$/i.test(
    value,
  );

const assignmentFindings = (text: string): RuleMatch[] => {
  const out: RuleMatch[] = [];
  for (const m of text.matchAll(ASSIGNMENT_RE)) {
    const valueStart = m.index + m[0].length;
    const closing = m[2];
    let end = text.indexOf("\n", valueStart);
    if (end === -1) end = text.length;
    if (closing !== undefined) {
      const closeAt = text.indexOf(closing, valueStart);
      if (closeAt !== -1 && closeAt < end) end = closeAt;
    }
    const value = text.slice(valueStart, end).trim();
    if (isPlaceholderValue(value)) continue;
    out.push({ rule: "SEC-CRED-ASSIGNMENT", category: "credential", index: m.index });
  }
  return out;
};

/** High-entropy quoted strings. Context-gated to keep false positives
 * down: lowercase-only, uppercase-only (ULID-style ids), digit-only, and
 * hex-only (hashes) strings all pass; the value must mix upper and lower
 * case and at least three character classes. */
const ENTROPY_RE = /["']([A-Za-z0-9+/=_-]{22,})["']/g;

const isHighEntropyValue = (value: string): boolean => {
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value)) return false;
  if (/^[0-9a-f]+$/i.test(value)) return false;
  let classes = 0;
  for (const re of [/[a-z]/, /[A-Z]/, /[0-9]/, /[-_+/=]/]) {
    if (re.test(value)) classes += 1;
  }
  return classes >= 3;
};

const entropyFindings = (text: string): RuleMatch[] => {
  const out: RuleMatch[] = [];
  for (const m of text.matchAll(ENTROPY_RE)) {
    if (isHighEntropyValue(m[1])) {
      out.push({ rule: "SEC-ENTROPY-TOKEN", category: "high-entropy", index: m.index });
    }
  }
  return out;
};

/* ----------------------------- positions ----------------------------- */

/** Line-start offsets of the normalized (LF) text. */
const lineStarts = (text: string): number[] => {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
};

/* ------------------------------ scanning ------------------------------ */

/** Scan normalized text and return findings sorted by (line, column,
 * rule). Deterministic: identical input yields identical output. */
export const scanContent = (raw: string): ReadonlyArray<SecretFinding> => {
  // Normalize newlines first: CRLF and lone CR become LF, so line and
  // column math is computed over one canonical form.
  const text = raw.replace(/\r\n?/g, "\n");
  const matches: RuleMatch[] = [];
  for (const { regex, rule, category } of providerRules) {
    for (const m of text.matchAll(regex)) {
      matches.push({ rule, category, index: m.index });
    }
  }
  matches.push(...assignmentFindings(text));
  matches.push(...entropyFindings(text));

  const starts = lineStarts(text);
  const findings = matches.map(({ rule, category, index }) => {
    // binary search for the line containing `index`
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    const lineStart = starts[lo];
    const lineEnd = text.indexOf("\n", lineStart);
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    // code-point offset: Array.from iterates code points (UTF-16 safe)
    const column = Array.from(line.slice(0, index - lineStart)).length + 1;
    return {
      category,
      rule,
      line: lo + 1,
      column,
      note: NOTES[category],
    };
  });
  findings.sort(
    (a, b) =>
      a.line - b.line || a.column - b.column || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0),
  );
  return findings;
};

/** Resolve raw findings into a write decision under a policy. Per the
 * reviewed semantics: `off` surfaces nothing; `warn` surfaces findings
 * without blocking; `block` blocks unless `allowSecrets` is set, and
 * then reports `overrideUsed` only when there was something to override. */
export const evaluateScan = (
  findings: ReadonlyArray<SecretFinding>,
  policy: SecretPolicy,
  allowSecrets: boolean,
): ScanEvaluation => {
  if (policy === "off") {
    return { policy, findings: [], blocked: false, overrideUsed: false };
  }
  if (policy === "warn") {
    return { policy, findings, blocked: false, overrideUsed: false };
  }
  const hasFindings = findings.length > 0;
  if (allowSecrets) {
    return { policy, findings, blocked: false, overrideUsed: hasFindings };
  }
  return { policy, findings, blocked: hasFindings, overrideUsed: false };
};

/** Resolve the effective policy for a scope: project defaults to block,
 * personal to warn; explicit configuration wins. */
export const resolveSecretPolicy = (
  scope: Scope,
  configured: { readonly project?: SecretPolicy; readonly personal?: SecretPolicy },
): SecretPolicy =>
  scope === "project" ? (configured.project ?? "block") : (configured.personal ?? "warn");
