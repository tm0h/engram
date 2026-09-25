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
import { claudeCodeSpec, parseSidecarLedger, SIDECAR_FILENAME } from "@engram/harnesses/installer";
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

  it("refuses unknown targets, including other lanes' target names (ENG-68)", async () => {
    await expect(runInstall({ target: "generic" })).rejects.toThrow(/unknown install target/);
    await expect(runInstall({ target: "cursor" })).rejects.toThrow(/unknown install target/);
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
});
