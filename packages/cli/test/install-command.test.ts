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
import { parseSidecarLedger, SIDECAR_FILENAME } from "@engram/harnesses/installer";

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
    expect(fs.readFileSync(settings, "utf8")).toBe(userClaudeSettings());
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
