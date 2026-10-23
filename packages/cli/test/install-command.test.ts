/**
 * `engram install` command tests (ENG-58): confirmation flow (A4: non-TTY
 * without --yes refuses; status/dry-run never write; idempotent re-runs
 * still confirm), install/uninstall into isolated homes, codex feature-flag
 * reporting, and no-backup semantics (A8). Runs the real command Effect over
 * MainLive with stdout captured; nothing shells out and no live host runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import { Effect } from "effect";
import { MainLive } from "@engram/core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installCommand } from "../src/commands/install.js";
import {
  CURSOR_BEGIN_MARKER,
  ENGRAM_GUIDANCE_TEMPLATE,
  GENERIC_BEGIN_MARKER,
  GENERIC_END_MARKER,
  claudeCodeSpec,
  parseSidecarLedger,
  SIDECAR_FILENAME,
} from "@engram/harnesses/installer";
import type { AssetSpec } from "@engram/harnesses/shared";

/* ------------------------------ helpers ------------------------------ */

const userClaudeSettings = (): string =>
  `${JSON.stringify(
    {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "user-own-hook", timeout: 30 }] }],
      },
    },
    null,
    2,
  )}\n`;

const userCodexHooks = (): string =>
  `${JSON.stringify(
    {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "user-own-codex", timeout: 10 }] }],
      },
    },
    null,
    2,
  )}\n`;

describe("engram install command", () => {
  let tmp = "";
  let outLines: string[] = [];
  let spies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-install-"));
    outLines = [];
    spies = [
      vi.spyOn(console, "log").mockImplementation(((...args: unknown[]) => {
        outLines.push(args.map(String).join(" "));
        return undefined;
      }) as typeof console.log),
      vi.spyOn(console, "error").mockImplementation(((...args: unknown[]) => {
        outLines.push(args.map(String).join(" "));
        return undefined;
      }) as typeof console.error),
    ];
  });

  afterEach(() => {
    for (const s of spies) s.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const output = (): string => outLines.join("\n");

  const runInstall = (opts: Omit<Parameters<typeof installCommand>[0], never>): Promise<unknown> =>
    Effect.runPromise(Effect.provide(installCommand(opts), MainLive));

  const writeHomeFile = (rel: string, content: string): string => {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  };

  const noBackupFiles = (): boolean => {
    const walk = (dir: string): string[] =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((e) =>
          e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
        );
    return !walk(tmp).some((f) => /\.engram-tmp$|\.bak$|~$/.test(f));
  };

  it("refuses unknown targets, enumerating exactly the five lanes (ENG-68)", async () => {
    await expect(runInstall({ target: "nope" })).rejects.toThrow(
      /unknown install target "nope" \(expected: generic \| cursor \| claude \| claude-code \| codex\)/,
    );
    // claude lands in ENG-37 turn 3 and stays unknown until then
    await expect(runInstall({ target: "claude" })).rejects.toThrow(/unknown install target/);
  });

  it("status is read-only and reports state", async () => {
    const settings = writeHomeFile("home/.claude/settings.json", userClaudeSettings());
    await runInstall({ target: "claude-code", status: true, home: path.join(tmp, "home") });
    expect(output()).toContain("target: claude-code");
    expect(output()).toContain(`root: ${path.join(tmp, "home", ".claude")}`);
    expect(output()).toContain("settings.json: absent");
    // P2a + turn-5 P2: nothing installed, so no ownership claims at all
    expect(output()).not.toContain("engram-owned entries");
    expect(output()).not.toContain("matches engram spec but not owned");
    expect(fs.readFileSync(settings, "utf8")).toBe(userClaudeSettings());
  });

  it("status reports owned entries from scanned state after install (P2a)", async () => {
    const homeDir = path.join(tmp, "home");
    await runInstall({ target: "claude-code", yes: true, home: homeDir });
    outLines = [];
    await runInstall({ target: "claude-code", status: true, home: homeDir });
    const ids = output()
      .split("\n")
      .find((l) => l.startsWith("engram-owned entries:"));
    expect(ids).toBeDefined();
    for (const event of ["startup", "resume", "compact"]) {
      expect(ids).toContain(`engram-hook:claude-code:${event}`);
    }
    expect(output()).not.toContain("matches engram spec but not owned");
  });

  it("status reports spec-matching hooks as not owned without the sidecar (turn-5 P2)", async () => {
    const homeDir = path.join(tmp, "home");
    // user-written settings containing hooks identical to the engram spec,
    // but no sidecar: ownership cannot be claimed from content alone
    const spec = claudeCodeSpec();
    const engramGroups = (
      spec.assets[0] as Extract<AssetSpec, { kind: "jsonEntries" }>
    ).entries[0]!.groups.map((g) => g.group);
    writeHomeFile(
      "home/.claude/settings.json",
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { hooks: [{ type: "command", command: "user-own-hook" }] },
              ...engramGroups,
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    await runInstall({ target: "claude-code", status: true, home: homeDir });
    expect(output()).not.toContain("engram-owned entries:");
    const unowned = output()
      .split("\n")
      .find((l) => l.startsWith("matches engram spec but not owned:"));
    expect(unowned).toBeDefined();
    for (const event of ["startup", "resume", "compact"]) {
      expect(unowned).toContain(`engram-hook:claude-code:${event}`);
    }
  });

  it("status drops owned claims when the sidecar is missing (turn-5 P2)", async () => {
    const homeDir = path.join(tmp, "home");
    await runInstall({ target: "claude-code", yes: true, home: homeDir });
    fs.rmSync(path.join(homeDir, ".claude", SIDECAR_FILENAME));
    outLines = [];
    await runInstall({ target: "claude-code", status: true, home: homeDir });
    expect(output()).not.toContain("engram-owned entries:");
    expect(output()).toContain("matches engram spec but not owned:");
  });

  it("install refuses a plan with a blocked sidecar and writes no hooks (P1a)", async () => {
    const settings = writeHomeFile("home/.claude/settings.json", userClaudeSettings());
    // foreign file at the sidecar path blocks the sidecar asset
    writeHomeFile("home/.claude/engram-managed.json", "{}\n");

    await expect(
      runInstall({ target: "claude-code", yes: true, home: path.join(tmp, "home") }),
    ).rejects.toThrow(/refusing to install.*blocked asset\(s\).*engram-claude-code-sidecar/);
    // no hooks written without the ownership ledger
    const doc = JSON.parse(fs.readFileSync(settings, "utf8")) as Record<string, any>;
    expect(doc.hooks.SessionStart).toHaveLength(1); // user entry only
    expect(Object.keys(doc)).toEqual(["hooks"]);
  });

  it("respects CODEX_HOME and CLAUDE_CONFIG_DIR config-dir overrides (P1d)", async () => {
    const origCodex = process.env.CODEX_HOME;
    const origClaude = process.env.CLAUDE_CONFIG_DIR;
    try {
      const codexHome = path.join(tmp, "codex-home");
      const claudeDir = path.join(tmp, "claude-dir");
      fs.mkdirSync(codexHome, { recursive: true });
      fs.mkdirSync(claudeDir, { recursive: true });
      process.env.CODEX_HOME = codexHome;
      process.env.CLAUDE_CONFIG_DIR = claudeDir;

      await runInstall({ target: "codex", yes: true });
      expect(fs.existsSync(path.join(codexHome, "hooks.json"))).toBe(true);
      expect(fs.existsSync(path.join(codexHome, "engram-managed.json"))).toBe(true);

      await runInstall({ target: "claude-code", yes: true });
      expect(fs.existsSync(path.join(claudeDir, "settings.json"))).toBe(true);

      // --home still wins over the env override
      const explicit = path.join(tmp, "explicit-home");
      await runInstall({ target: "codex", yes: true, home: explicit });
      expect(fs.existsSync(path.join(explicit, ".codex", "hooks.json"))).toBe(true);
      expect(fs.existsSync(path.join(codexHome, ".codex"))).toBe(false);
    } finally {
      if (origCodex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = origCodex;
      if (origClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = origClaude;
    }
  });

  it("dry-run prints the exact plan and never writes (A4, A8)", async () => {
    const settings = writeHomeFile("home/.claude/settings.json", userClaudeSettings());
    await runInstall({ target: "claude-code", dryRun: true, home: path.join(tmp, "home") });
    expect(output()).toContain("Install plan for claude-code");
    expect(output()).toMatch(/write settings\.json \(\d+ bytes -> \d+ bytes\)/);
    expect(output()).toContain("Dry run: no changes were written.");
    expect(fs.readFileSync(settings, "utf8")).toBe(userClaudeSettings());
  });

  it("non-TTY without --yes refuses with a clear error and writes nothing (A4)", async () => {
    const settings = writeHomeFile("home/.claude/settings.json", userClaudeSettings());
    await expect(
      runInstall({ target: "claude-code", home: path.join(tmp, "home") }),
    ).rejects.toThrow(/refusing to modify .* --yes/);
    expect(fs.readFileSync(settings, "utf8")).toBe(userClaudeSettings());
  });

  it("install --yes merges plain entries, preserves user hooks, and creates no backups", async () => {
    const settings = writeHomeFile("home/.claude/settings.json", userClaudeSettings());
    await runInstall({ target: "claude-code", yes: true, home: path.join(tmp, "home") });
    expect(output()).toContain("Installed 2 change(s)"); // settings.json + sidecar

    const doc = JSON.parse(fs.readFileSync(settings, "utf8")) as Record<string, any>;
    const groups = doc.hooks.SessionStart as Array<Record<string, any>>;
    expect(groups).toHaveLength(4); // 1 user + 3 engram
    expect(groups[0].hooks[0].command).toBe("user-own-hook");
    // engram groups carry only documented Claude schema keys (turn-2, F2)
    expect(Object.keys(doc)).toEqual(["hooks"]);
    for (const g of groups.slice(1)) {
      for (const key of Object.keys(g)) expect(["matcher", "hooks"]).toContain(key);
      expect(g.matcher).toMatch(/^(startup|resume|compact)$/);
    }
    // ownership ledger lives in the engram-owned sidecar
    const ledger = parseSidecarLedger(
      fs.readFileSync(path.join(tmp, "home", ".claude", SIDECAR_FILENAME), "utf8"),
    );
    expect(ledger?.entries).toHaveLength(3);
    expect(ledger?.target).toBe("claude-code");
    expect(noBackupFiles()).toBe(true);
  });

  it("idempotent re-run needs confirmation, changes nothing with --yes (A4)", async () => {
    const settings = writeHomeFile("home/.claude/settings.json", userClaudeSettings());
    const homeDir = path.join(tmp, "home");
    await runInstall({ target: "claude-code", yes: true, home: homeDir });
    const afterFirst = fs.readFileSync(settings, "utf8");

    // re-run still requires confirmation in non-TTY sessions
    await expect(runInstall({ target: "claude-code", home: homeDir })).rejects.toThrow(/--yes/);

    await runInstall({ target: "claude-code", yes: true, home: homeDir });
    expect(output()).toContain("(no changes needed)");
    expect(output()).toContain("Nothing to do");
    expect(fs.readFileSync(settings, "utf8")).toBe(afterFirst);
    expect(noBackupFiles()).toBe(true);
  });

  it("uninstall --yes removes only engram-owned entries (A3)", async () => {
    const settings = writeHomeFile("home/.claude/settings.json", userClaudeSettings());
    const homeDir = path.join(tmp, "home");
    await runInstall({ target: "claude-code", yes: true, home: homeDir });
    outLines = [];
    await runInstall({ target: "claude-code", yes: true, uninstall: true, home: homeDir });
    expect(fs.readFileSync(settings, "utf8")).toBe(userClaudeSettings());
    expect(output()).toContain("Uninstalled");
    expect(noBackupFiles()).toBe(true);
  });

  it("creates the target directory on a fresh home", async () => {
    const homeDir = path.join(tmp, "fresh-home");
    await runInstall({ target: "claude-code", yes: true, home: homeDir });
    expect(fs.existsSync(path.join(homeDir, ".claude", "settings.json"))).toBe(true);
    const ledger = parseSidecarLedger(
      fs.readFileSync(path.join(homeDir, ".claude", SIDECAR_FILENAME), "utf8"),
    );
    expect(ledger?.entries).toHaveLength(3);
  });

  it("blocked reasons never advertise a nonexistent --force flag; status tips differentiate blocked vs drift (F5, F6)", async () => {
    const homeDir = path.join(tmp, "home");
    // a foreign file at the sidecar path blocks the sidecar asset
    writeHomeFile("home/.claude/engram-managed.json", "{}\n");

    await runInstall({ target: "claude-code", status: true, home: homeDir });
    expect(output()).toContain("engram-managed.json: blocked");
    expect(output()).toContain("unmanaged file exists at target path");
    expect(output()).not.toContain("use force");
    // blocked-state tip: manual removal first, then reinstall or uninstall
    expect(output()).toContain("remove or rename them manually");
    expect(output()).toContain("--uninstall");

    outLines = [];
    await runInstall({ target: "claude-code", dryRun: true, home: homeDir });
    expect(output()).toContain("BLOCKED engram-claude-code-sidecar");
    expect(output()).not.toContain("use force");
    // dry-run still writes nothing (A4)
    expect(fs.readFileSync(path.join(tmp, "home/.claude/engram-managed.json"), "utf8")).toBe(
      "{}\n",
    );

    // drift-state tip: --yes repairs (sidecar markers intact, ledger stale);
    // fresh second home so the foreign blocked sidecar above does not apply
    const driftHome = path.join(tmp, "drift-home");
    await runInstall({ target: "claude-code", yes: true, home: driftHome });
    const sidecarPath = path.join(driftHome, ".claude/engram-managed.json");
    fs.writeFileSync(
      sidecarPath,
      fs.readFileSync(sidecarPath, "utf8").replace('"version": 1', '"version": 99'),
    );
    outLines = [];
    await runInstall({ target: "claude-code", status: true, home: driftHome });
    expect(output()).toContain("engram-managed.json: drift");
    expect(output()).toContain("tip: repair with");
  });

  it("codex: status reports the feature flag; install manages hooks.json only", async () => {
    const homeDir = path.join(tmp, "home");
    const hooks = writeHomeFile("home/.codex/hooks.json", userCodexHooks());

    await runInstall({ target: "codex", status: true, home: homeDir });
    expect(output()).toContain("codex hooks feature: default");

    writeHomeFile("home/.codex/config.toml", 'model = "x"\n\n[features]\nhooks = false\n');
    outLines = [];
    await runInstall({ target: "codex", status: true, home: homeDir });
    expect(output()).toContain("explicitly disabled in config.toml");

    // install still manages hooks.json; the user's flag is left untouched
    await runInstall({ target: "codex", yes: true, home: homeDir });
    const doc = JSON.parse(fs.readFileSync(hooks, "utf8")) as Record<string, any>;
    expect(doc.hooks.SessionStart).toHaveLength(2); // 1 user + 1 engram
    expect(doc.hooks.PostCompact).toHaveLength(1);
    // entries carry only spec-valid keys; the ledger lives in the sidecar
    for (const g of [...doc.hooks.SessionStart, ...doc.hooks.PostCompact]) {
      for (const key of Object.keys(g)) expect(key).toBe("hooks");
    }
    const ledger = parseSidecarLedger(
      fs.readFileSync(path.join(homeDir, ".codex", SIDECAR_FILENAME), "utf8"),
    );
    expect(ledger?.entries).toHaveLength(2);
    expect(fs.readFileSync(path.join(homeDir, ".codex", "config.toml"), "utf8")).toBe(
      'model = "x"\n\n[features]\nhooks = false\n',
    );

    outLines = [];
    await runInstall({ target: "codex", yes: true, uninstall: true, home: homeDir });
    expect(JSON.parse(fs.readFileSync(hooks, "utf8") as string)).toEqual(
      JSON.parse(userCodexHooks()),
    );
    expect(fs.existsSync(path.join(homeDir, ".codex", SIDECAR_FILENAME))).toBe(false);
    expect(noBackupFiles()).toBe(true);
  });

  /* ------------------- generic: project-local (ENG-37) ------------------- */

  it("generic: dry-run plans, install --yes writes AGENTS.md, status and re-run are read-only", async () => {
    const proj = path.join(tmp, "proj");
    fs.mkdirSync(proj, { recursive: true });
    const agents = path.join(proj, "AGENTS.md");

    // dry-run: exact plan, never writes
    await runInstall({ target: "generic", dryRun: true, root: proj });
    expect(output()).toContain(`Install plan for generic in ${proj}`);
    expect(output()).toMatch(/write AGENTS\.md \(new file -> \d+ bytes\)/);
    expect(output()).toContain("Dry run: no changes were written.");
    expect(fs.existsSync(agents)).toBe(false);

    // install
    await runInstall({ target: "generic", yes: true, root: proj });
    expect(output()).toContain("Installed 1 change(s) for generic");
    // project targets manage files, never hooks
    expect(output()).not.toMatch(/\bhooks\b/);
    const installed = fs.readFileSync(agents, "utf8");
    expect(installed).toContain(GENERIC_BEGIN_MARKER);
    expect(installed).toContain(GENERIC_END_MARKER);
    expect(installed).toContain(ENGRAM_GUIDANCE_TEMPLATE);

    // status: read-only view
    outLines = [];
    await runInstall({ target: "generic", status: true, root: proj });
    expect(output()).toContain("target: generic");
    expect(output()).toContain(`root: ${proj}`);
    expect(output()).toContain("AGENTS.md: current");
    expect(fs.readFileSync(agents, "utf8")).toBe(installed);

    // idempotent re-run with --yes changes nothing
    outLines = [];
    await runInstall({ target: "generic", yes: true, root: proj });
    expect(output()).toContain("(no changes needed)");
    expect(output()).toContain("Nothing to do");
    expect(fs.readFileSync(agents, "utf8")).toBe(installed);
  });

  it("generic: preserves foreign AGENTS.md content, repairs drift, uninstalls owned-only", async () => {
    const proj = path.join(tmp, "proj");
    fs.mkdirSync(proj, { recursive: true });
    const agents = path.join(proj, "AGENTS.md");
    const foreign = "# My project\n\nCustom agent notes.\n";
    fs.writeFileSync(agents, foreign);

    await runInstall({ target: "generic", yes: true, root: proj });
    const installed = fs.readFileSync(agents, "utf8");
    expect(installed.startsWith(foreign)).toBe(true);

    // drift: a hand edit inside the managed block is repaired, foreign kept
    fs.writeFileSync(agents, installed.replace("engram search", "engram SERACH"));
    await runInstall({ target: "generic", yes: true, root: proj });
    const repaired = fs.readFileSync(agents, "utf8");
    expect(repaired.startsWith(foreign)).toBe(true);
    expect(repaired).toContain("engram search");
    expect(repaired).not.toContain("engram SERACH");

    // uninstall: managed block removed, foreign content and the file survive
    outLines = [];
    await runInstall({ target: "generic", yes: true, uninstall: true, root: proj });
    expect(output()).toContain("Uninstalled 1 change(s) for generic");
    expect(fs.readFileSync(agents, "utf8")).toBe(foreign);
    expect(noBackupFiles()).toBe(true);
  });

  it("generic: defaults to the process cwd as root", async () => {
    const proj = path.join(tmp, "proj");
    fs.mkdirSync(proj, { recursive: true });
    const prevCwd = process.cwd();
    // the repo itself may carry an AGENTS.md in the test cwd: it must stay
    // byte-identical (the install targets the project dir, not the old cwd)
    const cwdAgents = path.join(prevCwd, "AGENTS.md");
    const before = fs.existsSync(cwdAgents) ? fs.readFileSync(cwdAgents, "utf8") : null;
    process.chdir(proj);
    try {
      await runInstall({ target: "generic", yes: true });
      expect(fs.existsSync(path.join(proj, "AGENTS.md"))).toBe(true);
      expect(fs.existsSync(cwdAgents) ? fs.readFileSync(cwdAgents, "utf8") : null).toBe(before);
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("generic: --home is a hard error naming --root, for installs and status alike", async () => {
    const proj = path.join(tmp, "proj");
    fs.mkdirSync(proj, { recursive: true });
    await expect(
      runInstall({ target: "generic", yes: true, root: proj, home: path.join(tmp, "home") }),
    ).rejects.toThrow(/--home[\s\S]*--root/);
    await expect(
      runInstall({ target: "generic", status: true, root: proj, home: path.join(tmp, "home") }),
    ).rejects.toThrow(/--home[\s\S]*--root/);
    expect(fs.existsSync(path.join(proj, "AGENTS.md"))).toBe(false);
  });

  it("generic: a nonexistent --root fails instead of being created", async () => {
    await expect(
      runInstall({ target: "generic", yes: true, root: path.join(tmp, "missing") }),
    ).rejects.toThrow(/project root does not exist/);
  });

  it("generic: never reads or writes the OS home or other targets' config dirs", async () => {
    const guards = {
      HOME: path.join(tmp, "home-guard"),
      CODEX_HOME: path.join(tmp, "codex-guard"),
      CLAUDE_CONFIG_DIR: path.join(tmp, "claude-guard"),
    };
    const prev = {
      HOME: process.env.HOME,
      CODEX_HOME: process.env.CODEX_HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    };
    for (const dir of Object.values(guards)) fs.mkdirSync(dir, { recursive: true });
    const proj = path.join(tmp, "proj");
    fs.mkdirSync(proj, { recursive: true });
    try {
      Object.assign(process.env, guards);
      await runInstall({ target: "generic", yes: true, root: proj });
      expect(fs.existsSync(path.join(proj, "AGENTS.md"))).toBe(true);
      for (const dir of Object.values(guards)) {
        expect(fs.readdirSync(dir)).toEqual([]);
      }
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("generic: non-TTY without --yes refuses and writes nothing (A4)", async () => {
    const proj = path.join(tmp, "proj");
    fs.mkdirSync(proj, { recursive: true });
    await expect(runInstall({ target: "generic", root: proj })).rejects.toThrow(
      /refusing to modify .* --yes/,
    );
    expect(fs.existsSync(path.join(proj, "AGENTS.md"))).toBe(false);
  });

  /* ---------------------- cursor: project-local (ENG-37) ---------------------- */

  const cursorRule = (proj: string): string => path.join(proj, ".cursor", "rules", "engram.mdc");

  it("cursor: dry-run plans, install --yes scaffolds .cursor/rules, status and re-run are read-only", async () => {
    const proj = path.join(tmp, "proj");
    fs.mkdirSync(proj, { recursive: true });

    // dry-run: exact plan (directory + file), never writes
    await runInstall({ target: "cursor", dryRun: true, root: proj });
    expect(output()).toContain(`Install plan for cursor in ${proj}`);
    expect(output()).toContain("create directory .cursor/rules");
    expect(output()).toMatch(/write \.cursor[/\\]rules[/\\]engram\.mdc \(new file -> \d+ bytes\)/);
    expect(output()).toContain("Dry run: no changes were written.");
    expect(fs.existsSync(path.join(proj, ".cursor"))).toBe(false);

    // install
    await runInstall({ target: "cursor", yes: true, root: proj });
    expect(output()).toContain("Installed 1 change(s) for cursor");
    expect(output()).not.toMatch(/\bhooks\b/);
    const installed = fs.readFileSync(cursorRule(proj), "utf8");
    expect(installed).toContain(CURSOR_BEGIN_MARKER);
    expect(installed).toContain("alwaysApply: true");
    expect(installed).toContain(ENGRAM_GUIDANCE_TEMPLATE);

    // status: read-only view
    outLines = [];
    await runInstall({ target: "cursor", status: true, root: proj });
    expect(output()).toContain("target: cursor");
    expect(output()).toContain(`root: ${proj}`);
    expect(output()).toContain(".cursor/rules/engram.mdc: current");
    expect(fs.readFileSync(cursorRule(proj), "utf8")).toBe(installed);

    // idempotent re-run with --yes changes nothing
    outLines = [];
    await runInstall({ target: "cursor", yes: true, root: proj });
    expect(output()).toContain("(no changes needed)");
    expect(output()).toContain("Nothing to do");
    expect(fs.readFileSync(cursorRule(proj), "utf8")).toBe(installed);
  });

  it("cursor: repairs template drift, preserves user .mdc files, uninstalls owned-only", async () => {
    const proj = path.join(tmp, "proj");
    const userRule = path.join(proj, ".cursor", "rules", "my-rules.mdc");
    const userContent = "---\ndescription: user rule\nglobs: *.ts\n---\n\nKeep types strict.\n";
    fs.mkdirSync(path.dirname(userRule), { recursive: true });
    fs.writeFileSync(userRule, userContent);

    await runInstall({ target: "cursor", yes: true, root: proj });
    const installed = fs.readFileSync(cursorRule(proj), "utf8");
    expect(fs.readFileSync(userRule, "utf8")).toBe(userContent);

    // drift: a hand edit inside the managed block is repaired, user file kept
    fs.writeFileSync(cursorRule(proj), installed.replace("engram search", "engram SERACH"));
    await runInstall({ target: "cursor", yes: true, root: proj });
    const repaired = fs.readFileSync(cursorRule(proj), "utf8");
    expect(repaired).toContain("engram search");
    expect(repaired).not.toContain("engram SERACH");
    expect(fs.readFileSync(userRule, "utf8")).toBe(userContent);

    // uninstall: our file removed, user file and directory survive
    outLines = [];
    await runInstall({ target: "cursor", yes: true, uninstall: true, root: proj });
    expect(output()).toContain("Uninstalled 1 change(s) for cursor");
    expect(fs.existsSync(cursorRule(proj))).toBe(false);
    expect(fs.readFileSync(userRule, "utf8")).toBe(userContent);
    expect(noBackupFiles()).toBe(true);
  });

  it("cursor: a pre-existing foreign engram.mdc is refused, not clobbered", async () => {
    const proj = path.join(tmp, "proj");
    const rulePath = cursorRule(proj);
    fs.mkdirSync(path.dirname(rulePath), { recursive: true });
    const foreignFile = "---\ndescription: my own engram notes\nalwaysApply: true\n---\n\nMine.\n";
    fs.writeFileSync(rulePath, foreignFile);

    await expect(runInstall({ target: "cursor", yes: true, root: proj })).rejects.toThrow(
      /refusing to install.*blocked asset\(s\).*engram-cursor-rules/,
    );
    expect(fs.readFileSync(rulePath, "utf8")).toBe(foreignFile);
  });

  it("cursor: --home is a hard error naming --root", async () => {
    const proj = path.join(tmp, "proj");
    fs.mkdirSync(proj, { recursive: true });
    await expect(
      runInstall({ target: "cursor", yes: true, root: proj, home: path.join(tmp, "home") }),
    ).rejects.toThrow(/--home[\s\S]*--root/);
    expect(fs.existsSync(path.join(proj, ".cursor"))).toBe(false);
  });
});
