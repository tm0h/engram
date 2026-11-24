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
import {
  engramContextTool as ocContext,
  engramAddTool as ocAdd,
  engramEditTool as ocEdit,
} from "../src/opencode/tools.js";

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

  it("engram_context explains automatic delivery and manual use", () => {
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

const piDir = "packages/harnesses/src/pi/skills/engram";
const pluginDir = "packages/harnesses/claude/skills/engram";
const scaffoldDir = "packages/harnesses/claude/scaffold";
const skillDirs = [piDir, pluginDir, scaffoldDir];
const readSkill = (file: string): string => fs.readFileSync(path.join(repoRoot, file), "utf8");
const entrypoint = (dir: string): string => readSkill(`${dir}/SKILL.md`);
const reference = (dir: string, topic: string): string =>
  readSkill(`${dir}/references/${topic}.md`);

describe("guidance / skill layout", () => {
  for (const dir of skillDirs) {
    it(`${dir} links directly to bundled references and keeps write boundaries in the entrypoint`, () => {
      const skill = entrypoint(dir);
      expect(skill).toMatch(/^---\nname: engram\ndescription: .+\n---\n/);
      const routes = Array.from(skill.matchAll(/\]\(references\/([a-z]+)\.md\)/g), (m) => m[1]);
      expect(routes).toEqual(["search", "review", "setup"]);
      for (const topic of routes) {
        expect(reference(dir, topic)).not.toMatch(/\]\((?:\.\.\/|references\/)/);
      }
      for (const boundary of [
        "explicit approval",
        "pending",
        "secrets",
        "system, user, and repository instructions",
      ]) {
        expect(skill).toContain(boundary);
      }
      expect(skill).not.toMatch(/bounded prefix|autoContextMaxChars/);
    });
  }

  it("ships the same task references for both Claude delivery modes", () => {
    for (const topic of ["search", "review", "setup"]) {
      expect(reference(scaffoldDir, topic)).toBe(reference(pluginDir, topic));
    }
  });
});

describe("guidance / skills stay aligned", () => {
  const piSkill = entrypoint(piDir);
  const claudeSkill = entrypoint(pluginDir);
  const piReview = reference(piDir, "review");
  const claudeReview = reference(pluginDir, "review");

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

  it("both skills describe OpenClaw workspace installation and project scope", () => {
    for (const skill of skillDirs.map((dir) => reference(dir, "setup"))) {
      expect(skill).toContain("engram install openclaw --root <agent-workspace>");
      expect(skill).toContain("skills/engram-project-memory/SKILL.md");
      expect(skill).toContain("Git checkout with `--scope project`");
    }
  });

  it("both skills describe the Hermes profile and out-of-session workflow", () => {
    for (const skill of skillDirs.map((dir) => reference(dir, "setup"))) {
      expect(skill).toContain("engram install hermes --root <profile-directory>");
      expect(skill).toContain("outside Hermes");
      expect(skill).toContain("Keep project data and command output out of the Hermes session.");
    }
  });

  it("both skills describe preview-first migration and managed export", () => {
    for (const skill of [piReview, claudeReview]) {
      expect(skill).toContain("engram import <files...>");
      expect(skill).toContain("engram import --pack <name>");
      expect(skill).toContain("ENGRAM_PACK_DIR");
      expect(skill).toMatch(/--apply[\s\S]*?pending review/);
      expect(skill).toContain("engram export <files...>");
      expect(skill).toContain("canonical project digest in managed Markdown sections");
    }
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
      ["pi", piReview],
      ["claude", claudeReview],
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
    expect(piReview, "pi: null clears").toMatch(/null\s+clears?/i);
    expect(claudeReview, "claude: --clear- flags").toContain("--clear-");
    expect(claudeReview, "claude: edit command").toContain("engram edit");
    expect(piReview, "pi: edit tool").toContain("engram_edit");
  });

  it("both skills document the optional lifecycle fields, enums, and authority caveat", () => {
    for (const [name, skill] of [
      ["pi", piReview],
      ["claude", claudeReview],
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
      expect(entrypoint(name === "pi" ? piDir : pluginDir)).toMatch(/unauthenticated/i);
      expect(entrypoint(name === "pi" ? piDir : pluginDir)).toContain(
        "system, user, and repository instructions",
      );
    }
  });

  it("routes precise searches and maintenance to separate references", () => {
    for (const dir of skillDirs) {
      const search = reference(dir, "search");
      expect(search).toMatch(/quoted phrase/i);
      expect(search).toMatch(/bounded prefix/i);
      for (const token of ["tag:", "title:", "type:", "body:", "AND", "OR", "--all"]) {
        expect(search, dir).toContain(token);
      }
      const review = reference(dir, "review");
      for (const command of [
        "engram review",
        "engram evidence <id>",
        "git:<full-commit>:<repo-relative-path>",
        "engram diff main...HEAD --json",
        "engram check",
      ]) {
        expect(review, dir).toContain(command);
      }
      const setup = reference(dir, "setup");
      for (const setting of [
        "engram doctor",
        "engram stats --disable --clear",
        "secretScan",
        "personalSecretScan",
      ]) {
        expect(setup, dir).toContain(setting);
      }
    }
  });

  it("both skills document the ENG-58 install targets and hook flows", () => {
    for (const name of skillDirs) {
      const skill = reference(name, "setup");
      expect(skill, `${name}: claude-code target`).toContain("engram install claude-code");
      expect(skill, `${name}: codex target`).toContain("engram install codex");
      expect(skill, `${name}: status flow`).toContain("--status");
      expect(skill, `${name}: dry-run flow`).toContain("--dry-run");
      expect(skill, `${name}: uninstall flow`).toContain("--uninstall");
      expect(skill, `${name}: fail-open note`).toMatch(/fail open/i);
      expect(skill, `${name}: bounded output note`).toContain("8 KiB");
      expect(skill, `${name}: hook entry point`).toContain("engram hook");
      // all five install targets are documented (ENG-37 + ENG-58 lanes)
      for (const target of ["generic", "cursor", "claude", "claude-code", "codex"] as const) {
        expect(skill, `${name}: ${target} target documented`).toContain(`engram install ${target}`);
      }
      // the claude (project skill scaffold) vs claude-code (user-level hooks)
      // distinction stays explicit
      expect(skill, `${name}: claude distinction`).toMatch(/project skill scaffold/i);
      expect(skill, `${name}: claude-code distinction`).toMatch(/user-level/);
      // the launcher fallback example is quoted (PR review R2)
      expect(skill, `${name}: quoted fallback`).toContain('sh "${CLAUDE_SKILL_DIR}/bin/engram"');
    }
  });
});

describe("guidance / claude scaffold variant (ENG-37)", () => {
  const scaffoldSkill = fs.readFileSync(
    path.join(repoRoot, "packages/harnesses/claude/scaffold/SKILL.md"),
    "utf8",
  );
  const sessionFlow = scaffoldSkill.split("## Session flow")[1]?.split("## ")[0] ?? "";

  it("keeps the manual session-start flow with engram context (SessionStart deferred)", () => {
    expect(sessionFlow.length).toBeGreaterThan(0);
    expect(sessionFlow).toMatch(/start of a session|session start/i);
    expect(sessionFlow).toContain("engram context");
    // no automatic-loading claim for this harness: the plugin-skill heritage
    // wording states the harness does not inject it (yet)
    expect(sessionFlow).toMatch(/digest has already been supplied/);
  });

  it("preamble points at the launcher fallback, not the plugin, and stays scaffold-worded", () => {
    // the fallback is quoted: project paths may contain spaces (PR review R2)
    expect(scaffoldSkill).toContain('sh "${CLAUDE_SKILL_DIR}/bin/engram"');
    expect(scaffoldSkill).toContain("engram-cli");
    expect(scaffoldSkill).not.toContain("while this plugin is enabled");
  });

  it("keeps the authority and instruction-precedence caveat", () => {
    expect(scaffoldSkill).toContain("system, user, and repository instructions");
  });
});

describe("guidance / related links (ENG-42)", () => {
  const piAdd = piTools.find((t) => t.name === "engram_add")!;
  const piEdit = piTools.find((t) => t.name === "engram_edit")!;
  const piSkillText = reference(piDir, "review");
  const claudeSkillText = reference(pluginDir, "review");

  it("add guidance states exact ids, same scope, and advisory missing targets", () => {
    for (const [name, desc] of [
      ["pi", piAdd.description],
      ["opencode", ocAdd.description],
    ] as const) {
      expect(desc, `${name}: exact ids`).toMatch(/exact/i);
      expect(desc, `${name}: same scope`).toMatch(/same[- ]scope/i);
      expect(desc, `${name}: advisory missing targets`).toMatch(/dangle|missing|advisory/i);
    }
  });

  it("edit guidance states the three-state related contract", () => {
    for (const [name, desc] of [
      ["pi", piEdit.description],
      ["opencode", ocEdit.description],
    ] as const) {
      expect(desc, `${name}: related mentioned`).toContain("related");
      expect(desc, `${name}: null clears`).toMatch(/null clears|clears/i);
    }
  });

  it("both skills document related links together", () => {
    for (const [name, skill] of [
      ["pi", piSkillText],
      ["claude", claudeSkillText],
    ] as const) {
      expect(skill, `${name}: related guidance`).toMatch(/`?related`?/);
      expect(skill, `${name}: directional`).toMatch(/directional|one[- ]way/i);
      expect(skill, `${name}: same scope`).toMatch(/same[- ]scope/i);
      expect(skill, `${name}: dangling warning`).toMatch(/dangle|missing/i);
      expect(skill, `${name}: whole-list replacement`).toMatch(/whole list|replaces/i);
    }
    // clear surface, named per harness
    expect(piSkillText).toMatch(/related: null|related: \[\]/);
    expect(claudeSkillText).toContain("--clear-related");
    expect(claudeSkillText).toContain("--related");
  });

  it("both skills document the links read surface (ENG-45)", () => {
    for (const [name, skill, command] of [
      ["pi", reference(piDir, "search"), "/engram links"],
      ["claude", reference(pluginDir, "search"), "engram links"],
    ] as const) {
      expect(skill, `${name}: links command`).toContain(`${command} <id>`);
      expect(skill, `${name}: exact ids`).toMatch(/exact/i);
      expect(skill, `${name}: same-scope`).toMatch(/same-scope/i);
      expect(skill, `${name}: authored outgoing order`).toMatch(/authored order/i);
      expect(skill, `${name}: MISSING marker`).toContain("MISSING");
      expect(skill, `${name}: AMBIGUOUS marker`).toContain("AMBIGUOUS");
      expect(skill, `${name}: offset pagination`).toMatch(/--offset n/);
      expect(skill, `${name}: bounded output`).toMatch(/size-capped|capped at/);
    }
    // The continuation footer names each harness's own command form.
    expect(reference(piDir, "search")).toContain("/engram links <id> --offset n");
    expect(reference(pluginDir, "search")).toContain("engram links <id> --offset n");
  });
});

describe("guidance / aliases (ENG-46)", () => {
  const piAdd = piTools.find((t) => t.name === "engram_add")!;
  const piEdit = piTools.find((t) => t.name === "engram_edit")!;
  const piSkillText = reference(piDir, "review");
  const claudeSkillText = reference(pluginDir, "review");
  const readmeText = readSkill("README.md");

  it("add tool guidance mentions aliases with the normalization contract", () => {
    for (const [name, desc] of [
      ["pi", piAdd.description],
      ["opencode", ocAdd.description],
    ] as const) {
      expect(desc, `${name}: aliases mentioned`).toContain("aliases");
      expect(desc, `${name}: normalization`).toMatch(/trims|lowercases|deduplicates/i);
    }
    const piProps = piAdd.parameters.properties as Record<string, { description?: string }>;
    expect(piProps.aliases?.description).toMatch(/alternate names/i);
    const ocArgs = ocAdd.args as Record<string, { description?: string }>;
    expect(ocArgs.aliases?.description).toMatch(/alternate names/i);
  });

  it("edit tool guidance states the three-state aliases contract", () => {
    for (const [name, desc] of [
      ["pi", piEdit.description],
      ["opencode", ocEdit.description],
    ] as const) {
      expect(desc, `${name}: aliases mentioned`).toContain("aliases");
      expect(desc, `${name}: null clears`).toMatch(/null clears|clears/i);
    }
  });

  it("both skills document aliases together with limits and edit semantics", () => {
    for (const [name, skill] of [
      ["pi", piSkillText],
      ["claude", claudeSkillText],
    ] as const) {
      expect(skill, `${name}: aliases guidance`).toMatch(/`?aliases`?/);
      expect(skill, `${name}: alternate names`).toMatch(/alternate names/i);
      expect(skill, `${name}: unique cap`).toMatch(/20 unique|max 20|at most 20/i);
      expect(skill, `${name}: length cap`).toMatch(/80 characters|80 code points/i);
      expect(skill, `${name}: normalization`).toMatch(/lowercas/i);
      expect(skill, `${name}: whole-set replacement`).toMatch(/replaces the whole|three-state/i);
    }
    // clear surface, named per harness
    expect(piSkillText).toMatch(/aliases: null|aliases: \[\]/);
    expect(claudeSkillText).toContain("--clear-aliases");
    expect(claudeSkillText).toContain("--aliases");
    // comma limitation is documented on the flag surfaces
    expect(claudeSkillText).toMatch(/comma/i);
  });

  it("the README file-format section documents aliases", () => {
    expect(readmeText).toMatch(/^aliases:/m);
    expect(readmeText).toMatch(/alternate names/i);
    expect(readmeText).toMatch(/aliases_invalid/);
    expect(readmeText).toContain("--clear-aliases");
  });
});

describe("guidance / alias scoring (ENG-47)", () => {
  const piSkillText = reference(piDir, "search");
  const claudeSkillText = reference(pluginDir, "search");
  const readmeText = readSkill("README.md");
  const piReadmeText = readSkill("packages/harnesses/src/pi/README.md");
  const ocReadmeText = readSkill("packages/harnesses/src/opencode/README.md");

  it("both skills state alias scoring in R8 wording: relative weights, phrase path, no filter syntax", () => {
    for (const [name, skill] of [
      ["pi", piSkillText],
      ["claude", claudeSkillText],
    ] as const) {
      expect(skill, `${name}: relative BM25 weight order`).toMatch(
        /tag 5, alias 4, title 3, type 2, body 1/,
      );
      expect(skill, `${name}: pinned boost`).toMatch(/pinned \+0\.5/);
      expect(skill, `${name}: phrase path`).toMatch(/multi-word aliases[^.]*phrase/i);
      // D1: alias search guidance must not document alias filter syntax
      expect(skill, `${name}: no alias filter syntax`).not.toMatch(/alias:\s/);
    }
  });

  it("README surfaces carry the alias weight order and caps", () => {
    expect(readmeText).toMatch(/aliases, titles, types, and bodies/);
    expect(readmeText).toMatch(/alias 4/);
    expect(readmeText).toMatch(/20 aliases of 80 characters/);
    expect(readmeText).toMatch(/phrase bonus/);
    expect(piReadmeText).toMatch(/tags > alias > title > type > body/);
    expect(ocReadmeText).toMatch(/tags > alias > title > type > body/);
  });
});

it("documents ENG-19 CLI retrieval consistently", () => {
  for (const file of ["README.md", ...skillDirs.map((dir) => `${dir}/references/search.md`)]) {
    const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
    for (const flag of ["--triggers", "--applies-to", "--path"]) expect(text).toContain(flag);
  }
});

it("documents importance consistently across CLI guidance", () => {
  for (const file of ["README.md", ...skillDirs.map((dir) => `${dir}/references/search.md`)]) {
    const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
    expect(text).toContain("--importance");
    expect(text).toMatch(/diversification/i);
  }
});

it("documents curated startup defaults across harnesses", () => {
  for (const file of [
    "README.md",
    "packages/harnesses/src/opencode/README.md",
    ...skillDirs.map((dir) => `${dir}/references/setup.md`),
  ]) {
    const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
    for (const key of [
      "autoContextSelection",
      "autoContextMaxChars",
      "autoContextIncludeScoped",
      "autoContextIncludeInactive",
    ])
      expect(text).toContain(key);
  }
});

it("documents bounded matching snippets and direct related context in both skills", () => {
  for (const dir of skillDirs) {
    const skill = reference(dir, "search");
    expect(skill).toContain("engram context --tokens 4000");
    expect(skill).toContain("related <id>");
    expect(skill).toContain("240");
    expect(skill).toContain("superseded by");
  }
});

it("requires the user's approval before retrying a write advisory", () => {
  for (const [file, flag] of [
    ["packages/harnesses/src/pi/skills/engram/SKILL.md", "confirmWrite: true"],
    ["packages/harnesses/claude/skills/engram/SKILL.md", "--confirm-write"],
    ["packages/harnesses/claude/scaffold/SKILL.md", "--confirm-write"],
  ]) {
    const skill = fs.readFileSync(path.join(repoRoot, file), "utf8");
    expect(skill).toContain(flag);
    expect(skill).toContain("explicit approval");
    expect(skill).toContain("Exact duplicates cannot be confirmed");
  }
});

it("documents human pending-memory review across the README and shipped skills", () => {
  for (const file of ["README.md", ...skillDirs.map((dir) => `${dir}/references/review.md`)]) {
    const guidance = fs.readFileSync(path.join(repoRoot, file), "utf8");
    for (const command of ["list", "show", "edit", "approve", "reject"]) {
      expect(guidance, file).toContain(`engram pending ${command}`);
    }
    expect(guidance, file).toContain("engram pending approve <id> --dry-run");
    expect(guidance, file).toContain("engram capture status");
    expect(guidance, file).toContain("engram capture disable");
  }
});
