/**
 * Guidance regression tests: no Pi or OpenCode tool surface may still
 * instruct an automatic duplicate startup call for engram_context, and the
 * manual fallback must stay present. Skills stay aligned across variants.
 */
import { describe, it, expect } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { engramContextTool as piContext, engramTools as piTools } from "../src/pi/tools.js";
import { engramContextTool as ocContext } from "../src/opencode/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

/** Phrases that instruct calling context at session start (the duplicate-load window). */
const STARTUP_CALL =
  /(start of a session|session start|at session start|beginning of (a|the) session)/i;

/** Remove sentences that merely STATE automatic loading; instructions must not survive this. */
const stripAutomatic = (text: string): string => text.replace(/automatic[^.]*\./gi, "");

const guidanceSurfaces = (): Array<{
  harness: string;
  surface: string;
  text: string;
}> => [
  ...piTools.map((t) => ({ harness: "pi", surface: `${t.name} description`, text: t.description })),
  ...piTools
    .filter((t) => t.promptSnippet)
    .map((t) => ({ harness: "pi", surface: `${t.name} promptSnippet`, text: t.promptSnippet! })),
  { harness: "opencode", surface: "engram_context description", text: ocContext.description },
];

describe("guidance / no duplicate startup calls", () => {
  it("no Pi or OpenCode tool description or snippet instructs a session-start context call", () => {
    for (const { harness, surface, text } of guidanceSurfaces()) {
      expect(
        STARTUP_CALL.test(stripAutomatic(text)),
        `${harness} ${surface} still instructs startup call`,
      ).toBe(false);
    }
  });

  it("engram_context states the digest loads automatically (both harnesses)", () => {
    for (const { text } of [
      { text: piContext.description + " " + piContext.promptSnippet },
      { text: ocContext.description },
    ]) {
      expect(text).toMatch(/automatic/i);
      expect(text).toMatch(/refresh|recovery|recover|paginat/i);
    }
  });

  it("engram_context keeps the manual fallback for failures and unsupported setups", () => {
    for (const text of [
      piContext.description + " " + piContext.promptSnippet,
      ocContext.description,
    ]) {
      expect(text).toMatch(/fail|unavailable|not loaded/i);
    }
  });
});

describe("guidance / skills stay aligned", () => {
  const piSkill = fs.readFileSync(
    path.join(repoRoot, "packages/harnesses/src/pi/skills/engram/SKILL.md"),
    "utf8",
  );
  const claudeSkill = fs.readFileSync(
    path.join(repoRoot, "packages/harnesses/claude/skills/engram/SKILL.md"),
    "utf8",
  );

  it("Pi skill states automatic loading and drops the startup call instruction", () => {
    expect(piSkill).toMatch(/automatic/i);
    expect(STARTUP_CALL.test(stripAutomatic(piSkill))).toBe(false);
    // refresh/recovery guidance present
    expect(piSkill).toMatch(/refresh|recover/i);
  });

  it("Claude skill keeps the manual startup flow until PR2 (harness truth)", () => {
    // Extract the Session flow section and require BOTH the session-start
    // condition and the manual digest-load instruction inside it — a bare
    // `engram context` mention in a later step must not satisfy this.
    const sessionFlow = claudeSkill.split("## Session flow")[1]?.split("## ")[0] ?? "";
    expect(sessionFlow.length).toBeGreaterThan(0);
    expect(sessionFlow).toMatch(/start of a session|session start/i);
    expect(sessionFlow).toMatch(/engram context/);
  });

  it("both skills keep shared search/show/add and recording guidance", () => {
    for (const [name, skill, search, show, add] of [
      ["pi", piSkill, "engram_search", "engram_show", "engram_add"],
      ["claude", claudeSkill, "engram search", "engram show", "engram add"],
    ] as const) {
      expect(skill, `${name}: search guidance`).toContain(search);
      expect(skill, `${name}: show guidance`).toContain(show);
      expect(skill, `${name}: add guidance`).toContain(add);
      expect(skill, `${name}: do-not-record guidance`).toMatch(/do\s*\*?\*?not\*?\*?\s+record/i);
      expect(skill, `${name}: scopes`).toMatch(/personal/i);
    }
  });

  it("both skills document the optional lifecycle fields, enums, and authority caveat", () => {
    for (const [name, skill] of [
      ["pi", piSkill],
      ["claude", claudeSkill],
    ] as const) {
      for (const word of [
        "active",
        "superseded",
        "archived",
        "supersedes",
        "reviewAfter",
        "expires",
      ]) {
        expect(skill, `${name}: lifecycle vocabulary ${word}`).toContain(word);
      }
      expect(skill, `${name}: provenance fields`).toContain("sourceType");
      expect(skill, `${name}: authority caveat`).toMatch(/unauthenticated/i);
      expect(skill, `${name}: instruction precedence`).toContain(
        "system, user, and repository instructions",
      );
    }
  });
});
