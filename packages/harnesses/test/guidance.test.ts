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

  it("both skills document engram_edit with the three-state lifecycle contract", () => {
    for (const [name, skill] of [
      ["pi", piSkill],
      ["claude", claudeSkill],
    ] as const) {
      // the edit surface itself, named per harness (tool underscore vs CLI space)
      expect(skill, `${name}: edit guidance`).toMatch(/engram[._ ]edit/);
      // all six lifecycle names
      for (const word of [
        "status",
        "supersedes",
        "reviewAfter",
        "expires",
        "sourceType",
        "sourceRef",
      ]) {
        expect(skill, `${name}: edit lifecycle name ${word}`).toContain(word);
      }
      // replace semantics and preserve-on-omission
      expect(skill, `${name}: replace semantics`).toMatch(/replace/i);
      expect(skill, `${name}: preserve on omission`).toMatch(/omit/i);
      expect(skill, `${name}: preserve wording`).toMatch(/preserve/i);
    }
    // clear semantics, spelled per harness: null in the tool variant,
    // paired --clear-* flags in the CLI variant
    expect(piSkill, "pi: null clears").toMatch(/null\s+clears?/i);
    expect(claudeSkill, "claude: --clear- flags").toContain("--clear-");
    expect(claudeSkill, "claude: edit command").toContain("engram edit");
    expect(piSkill, "pi: edit tool").toContain("engram_edit");
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

  it("both skills cover the user-facing search and maintenance workflows", () => {
    for (const [name, skill] of [
      ["pi", piSkill],
      ["claude", claudeSkill],
    ] as const) {
      expect(skill, `${name}: quoted phrase search`).toMatch(/quoted phrase/i);
      expect(skill, `${name}: bounded prefix search`).toMatch(/bounded prefix/i);
      for (const token of ["tag:", "title:", "type:", "body:", "AND", "OR"]) {
        expect(skill, `${name}: search token ${token}`).toContain(token);
      }
      expect(skill, `${name}: inactive entry behavior`).toMatch(/inactive/i);
      expect(skill, `${name}: inactive CLI override`).toContain("--all");
      expect(skill, `${name}: review workflow`).toContain("engram review");
      expect(skill, `${name}: integrity workflow`).toContain("engram check");
      expect(skill, `${name}: project scan policy`).toContain("secretScan");
      expect(skill, `${name}: personal scan policy`).toContain("personalSecretScan");
    }
  });

  it("both skills document the ENG-58 install targets and hook flows", () => {
    for (const [name, skill] of [
      ["pi", piSkill],
      ["claude", claudeSkill],
    ] as const) {
      expect(skill, `${name}: claude-code target`).toContain("engram install claude-code");
      expect(skill, `${name}: codex target`).toContain("engram install codex");
      expect(skill, `${name}: status flow`).toContain("--status");
      expect(skill, `${name}: dry-run flow`).toContain("--dry-run");
      expect(skill, `${name}: uninstall flow`).toContain("--uninstall");
      expect(skill, `${name}: fail-open note`).toMatch(/fail open/i);
      expect(skill, `${name}: bounded output note`).toContain("8 KiB");
      expect(skill, `${name}: hook entry point`).toContain("engram hook");
      // lane boundary: no ENG-37 target names presented as installable
      expect(skill, `${name}: no ENG-37 targets`).not.toMatch(
        /install (generic|cursor)\b|install claude(?!-code)/,
      );
    }
  });
});
