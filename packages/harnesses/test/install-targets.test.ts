/**
 * ENG-58 turn 1: host install targets `claude-code` and `codex` over the
 * ENG-34 installer core, including the new `jsonEntries` asset kind
 * (entry-level ownership in JSON hook configs).
 *
 * Rulings implemented here (handoffs/turn-1-eng58.md):
 * - A1: Codex mechanism discovered offline (hooks.json + stable `hooks`
 *   feature); minimum supported version pinned in constants; fixtures only.
 * - A2: one shared constants module; tests assert the bounds.
 * - A3: per-entry marker key + one root registry key listing owned
 *   identities; unmarked engram-referencing entries are left alone.
 * - A5: hook commands resolve engram via PATH at runtime (no absolute paths).
 * - A6: exactly startup, resume, compaction per target (codex maps resume
 *   onto SessionStart: no distinct resume event exists in its protocol).
 * - A7: structural JSON merge preserving byte-stability of untouched
 *   regions for canonically formatted (2-space) documents.
 *
 * Filesystem tests run against real NodeServices on mkdtempSync directories.
 */
import { describe, it, expect, beforeEach, afterEach } from "@effect/vitest";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { NodeServices } from "@effect/platform-node";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  InstallerError,
  applyPlan,
  planInstall,
  planUninstall,
  scanAssets,
  validateSpec,
  type AssetSpec,
  type InstallSpec,
} from "../src/shared/installer.js";
import {
  CODEX_MIN_VERSION,
  ENTRY_MARKER_KEY,
  HOOK_DEBUG_ENV,
  HOOK_STDOUT_CAP_BYTES,
  HOOK_TIMEOUT_MS,
  HOST_HOOK_TIMEOUT_SECONDS,
  OWNERSHIP_MARKER_KEY,
  TRUNCATION_MARKER,
} from "../src/installer/constants.js";
import { claudeCodeSpec, claudeCodeRoot } from "../src/installer/claude-code.js";
import { codexHooksFlagState, codexSpec, codexRoot } from "../src/installer/codex.js";
import { parseSidecarLedger, SIDECAR_FILENAME } from "../src/installer/sidecar.js";
import {
  GENERIC_AGENTS_PATH,
  GENERIC_ASSET_ID,
  GENERIC_BEGIN_MARKER,
  GENERIC_END_MARKER,
  genericRoot,
  genericSpec,
} from "../src/installer/generic.js";
import {
  CURSOR_HEADER,
  CURSOR_RULES_PATH,
  CURSOR_ASSET_ID,
  CURSOR_BEGIN_MARKER,
  CURSOR_END_MARKER,
  cursorRoot,
  cursorSpec,
} from "../src/installer/cursor.js";
import {
  CLAUDE_LAUNCHER_ASSET_ID,
  CLAUDE_LAUNCHER_BEGIN_MARKER,
  CLAUDE_LAUNCHER_END_MARKER,
  CLAUDE_LAUNCHER_PATH,
  CLAUDE_SKILL_ASSET_ID,
  CLAUDE_SKILL_BEGIN_MARKER,
  CLAUDE_SKILL_END_MARKER,
  CLAUDE_SKILL_PATH,
  claudeRoot,
  claudeSpec,
} from "../src/installer/claude.js";
import { fileURLToPath } from "node:url";
import { ENGRAM_GUIDANCE_TEMPLATE } from "../src/installer/guidance-template.js";

/* ------------------------------ helpers ------------------------------ */

const Live = NodeServices.layer;

const run = <A>(eff: Effect.Effect<A, InstallerError, FileSystem | Path>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, Live));

let tmp = "";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-targets-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const writeRoot = (rel: string, content: string | null): string => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (content !== null) fs.writeFileSync(abs, content);
  return abs;
};

const readRoot = (rel: string): string | null => {
  const abs = path.join(tmp, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
};

const jsonAsset = (over: Partial<Extract<AssetSpec, { kind: "jsonEntries" }>> = {}): AssetSpec => ({
  kind: "jsonEntries",
  id: "engram-test-hooks",
  path: "config/hooks.json",
  mapPath: ["hooks"],
  registryKey: OWNERSHIP_MARKER_KEY,
  entryMarker: ENTRY_MARKER_KEY,
  entries: [
    {
      key: "SessionStart",
      groups: [
        {
          identity: "engram-hook:test:startup",
          group: { hooks: [{ type: "command", command: "engram hook test startup", timeout: 10 }] },
        },
      ],
    },
  ],
  ...over,
});

const installedDoc = () =>
  JSON.parse(readRoot("config/hooks.json") ?? "{}") as Record<string, unknown>;

/** Canonical-stringify a value the way the installer serializes documents. */
const canon = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/* --------------------- core: jsonEntries lifecycle -------------------- */

describe("installer core / jsonEntries kind", () => {
  it("validates specs: unique identities, non-empty keys, no pre-set marker, non-empty mapPath", () => {
    expect(validateSpec({ assets: [jsonAsset()] })).toBeNull();
    expect(
      validateSpec({
        assets: [
          jsonAsset({
            entries: [
              {
                key: "SessionStart",
                groups: [
                  { identity: "dup", group: {} },
                  { identity: "dup", group: {} },
                ],
              },
            ],
          }),
        ],
      })?.message,
    ).toMatch(/duplicate|identit/i);
    expect(validateSpec({ assets: [jsonAsset({ mapPath: [] })] })?.message).toMatch(/mapPath/i);
    expect(
      validateSpec({
        assets: [
          jsonAsset({
            entries: [
              {
                key: "SessionStart",
                groups: [{ identity: "i", group: { [ENTRY_MARKER_KEY]: "premarked" } }],
              },
            ],
          }),
        ],
      })?.message,
    ).toMatch(/marker/i);
    expect(
      validateSpec({
        assets: [jsonAsset({ mapPath: [OWNERSHIP_MARKER_KEY] })],
      })?.message,
    ).toMatch(/registry/i);
  });

  it("fresh install writes marked groups plus the registry and is idempotent", async () => {
    writeRoot("config/hooks.json", canon({}));
    const spec: InstallSpec = { assets: [jsonAsset()] };
    const scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]?.status).toBe("absent");

    const plan = planInstall(scan);
    expect(plan.actions.map((a) => a.op)).toEqual(["mkdir", "write"]);
    await run(applyPlan(tmp, plan));

    const doc = installedDoc();
    const groups = (doc as any).hooks.SessionStart as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(1);
    expect(groups[0]?.[ENTRY_MARKER_KEY]).toBe("engram-hook:test:startup");
    expect(doc[OWNERSHIP_MARKER_KEY]).toEqual(["engram-hook:test:startup"]);

    const scan2 = await run(scanAssets(tmp, spec));
    expect(scan2.states[0]?.status).toBe("current");
    expect(scan2.states[0]?.reasons).toEqual([]);
    expect(planInstall(scan2).actions).toHaveLength(0);
  });

  it("preserves unrelated user entries and byte-stable untouched regions (A7)", async () => {
    const userDoc = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "user-own-hook --flag", timeout: 30 }] },
        ],
      },
      otherRootKey: { keep: true },
    };
    writeRoot("config/hooks.json", canon(userDoc));
    const spec: InstallSpec = { assets: [jsonAsset()] };
    await run(applyPlan(tmp, planInstall(await run(scanAssets(tmp, spec)))));

    const after = JSON.parse(readRoot("config/hooks.json")!) as typeof userDoc;
    // user entry object survives untouched and first in order
    expect(after.hooks.SessionStart[0]).toEqual(userDoc.hooks.SessionStart[0]);
    expect(after.otherRootKey).toEqual({ keep: true });
    // byte stability: untouched subtrees serialize to their exact original
    // bytes, and original root key order is preserved with additions appended
    expect(JSON.stringify(after.hooks.SessionStart[0], null, 2)).toBe(
      JSON.stringify(userDoc.hooks.SessionStart[0], null, 2),
    );
    expect(JSON.stringify(after.otherRootKey, null, 2)).toBe(
      JSON.stringify(userDoc.otherRootKey, null, 2),
    );
    expect(Object.keys(after).slice(0, 2)).toEqual(Object.keys(userDoc));
  });

  it("uninstall removes only engram-owned entries, registry, and pruned containers", async () => {
    writeRoot(
      "config/hooks.json",
      canon({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "user-own-hook" }] },
            {
              hooks: [{ type: "command", command: "engram hook test startup" }],
              [ENTRY_MARKER_KEY]: "engram-hook:test:startup",
            },
          ],
          SessionEnd: [
            {
              hooks: [{ type: "command", command: "engram hook test startup" }],
              [ENTRY_MARKER_KEY]: "engram-hook:test:startup",
            },
          ],
        },
        [OWNERSHIP_MARKER_KEY]: ["engram-hook:test:startup", "engram-hook:test:gone"],
      }),
    );
    const spec: InstallSpec = { assets: [jsonAsset()] };
    const scan = await run(scanAssets(tmp, spec));
    await run(applyPlan(tmp, planUninstall(scan)));

    const doc = installedDoc();
    const groups = (doc as any).hooks.SessionStart as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(1);
    expect(groups[0]?.[ENTRY_MARKER_KEY]).toBeUndefined();
    expect((doc as any).hooks.SessionEnd).toBeUndefined(); // pruned when emptied
    expect(doc[OWNERSHIP_MARKER_KEY]).toBeUndefined(); // registry emptied and removed
    // the user's entry keeps the SessionStart array (and the map) alive
    expect((doc as any).hooks.SessionStart).toHaveLength(1);
    expect(readRoot("config/hooks.json")).not.toBeNull();
  });

  it("leaves hand-edited entries that reference engram but carry no marker (A3)", async () => {
    writeRoot(
      "config/hooks.json",
      canon({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "engram hook test startup" }] }],
        },
      }),
    );
    const spec: InstallSpec = { assets: [jsonAsset()] };
    const scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]?.status).toBe("absent"); // nothing recognized as ours
    await run(applyPlan(tmp, planInstall(scan)));

    const groups = (installedDoc() as any).hooks.SessionStart as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(2);
    expect(groups[0]?.[ENTRY_MARKER_KEY]).toBeUndefined(); // untouched
    expect(groups[1]?.[ENTRY_MARKER_KEY]).toBe("engram-hook:test:startup");

    // uninstall removes only the marked one
    await run(applyPlan(tmp, planUninstall(await run(scanAssets(tmp, spec)))));
    const after = (installedDoc() as any).hooks.SessionStart as Array<Record<string, unknown>>;
    expect(after).toHaveLength(1);
    expect(after[0]?.hooks).toEqual([{ type: "command", command: "engram hook test startup" }]);
  });

  it("never forces invalid JSON: install and uninstall both blocked", async () => {
    writeRoot("config/hooks.json", "{not json");
    const spec: InstallSpec = { assets: [jsonAsset()] };
    const scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]?.status).toBe("blocked");
    expect(planInstall(scan).blocked.map((b) => b.id)).toEqual(["engram-test-hooks"]);
    expect(planInstall(scan, { force: true }).blocked).toHaveLength(1);
    expect(planUninstall(scan).blocked).toHaveLength(1);
  });

  it("blocks when the event value or map container has a conflicting shape", async () => {
    writeRoot("config/hooks.json", canon({ hooks: { SessionStart: "not-an-array" } }));
    const scan = await run(scanAssets(tmp, { assets: [jsonAsset()] }));
    expect(scan.states[0]?.status).toBe("blocked");

    writeRoot("config/hooks.json", canon({ hooks: [1, 2] }));
    const scan2 = await run(scanAssets(tmp, { assets: [jsonAsset()] }));
    expect(scan2.states[0]?.status).toBe("blocked");

    writeRoot(
      "config/hooks.json",
      canon({ hooks: { SessionStart: [] }, [OWNERSHIP_MARKER_KEY]: "not-a-list" }),
    );
    const scan3 = await run(scanAssets(tmp, { assets: [jsonAsset()] }));
    expect(scan3.states[0]?.status).toBe("blocked");
  });

  it("repairs drift (edited or duplicated engram groups) without touching user groups", async () => {
    writeRoot(
      "config/hooks.json",
      canon({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "user-own-hook" }] },
            {
              hooks: [{ type: "command", command: "TAMPERED" }],
              [ENTRY_MARKER_KEY]: "engram-hook:test:startup",
            },
          ],
        },
        [OWNERSHIP_MARKER_KEY]: ["engram-hook:test:startup"],
      }),
    );
    const spec: InstallSpec = { assets: [jsonAsset()] };
    const scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]?.status).toBe("drift");
    await run(applyPlan(tmp, planInstall(scan)));

    const groups = (installedDoc() as any).hooks.SessionStart as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(2);
    expect(groups[0]?.hooks).toEqual([{ type: "command", command: "user-own-hook" }]);
    expect(groups[1]?.hooks).toEqual([
      { type: "command", command: "engram hook test startup", timeout: 10 },
    ]);
  });

  it("rewrites a missing registry key as drift repair", async () => {
    writeRoot(
      "config/hooks.json",
      canon({
        hooks: {
          SessionStart: [
            {
              hooks: [{ type: "command", command: "engram hook test startup", timeout: 10 }],
              [ENTRY_MARKER_KEY]: "engram-hook:test:startup",
            },
          ],
        },
      }),
    );
    const spec: InstallSpec = { assets: [jsonAsset()] };
    const scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]?.status).toBe("drift");
    await run(applyPlan(tmp, planInstall(scan)));
    expect(installedDoc()[OWNERSHIP_MARKER_KEY]).toEqual(["engram-hook:test:startup"]);
    const scan2 = await run(scanAssets(tmp, spec));
    expect(scan2.states[0]?.status).toBe("current");
  });

  it("plans carry exact before/after bytes and apply is a single write per file", async () => {
    writeRoot("config/hooks.json", canon({ hooks: {} }));
    const spec: InstallSpec = { assets: [jsonAsset()] };
    const plan = planInstall(await run(scanAssets(tmp, spec)));
    const writes = plan.actions.filter((a) => a.op === "write");
    expect(writes).toHaveLength(1);
    const w = writes[0] as Extract<(typeof writes)[number], { op: "write" }>;
    expect(w.before).toBe(canon({ hooks: {} }));
    expect(JSON.parse(w.after)).toMatchObject({
      [OWNERSHIP_MARKER_KEY]: ["engram-hook:test:startup"],
    });
  });
});

/* ----------------------- constants module (A2) ----------------------- */

describe("ENG-58 constants (A2, A1)", () => {
  it("pins the fail-open bounds", () => {
    expect(HOOK_TIMEOUT_MS).toBe(5000);
    expect(HOOK_STDOUT_CAP_BYTES).toBe(8192);
    expect(HOOK_DEBUG_ENV).toBe("ENGRAM_DEBUG");
    expect(TRUNCATION_MARKER.length).toBeGreaterThan(0);
    expect(TRUNCATION_MARKER.length).toBeLessThan(200);
    expect(HOST_HOOK_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(10);
  });

  it("pins the minimum supported Codex version (discovered offline)", () => {
    expect(CODEX_MIN_VERSION).toBe("0.155.1");
  });
});

/* --------------------------- target specs ---------------------------- */

describe("claude-code target spec", () => {
  it("declares exactly startup, resume, compact under SessionStart (A6)", () => {
    const spec = claudeCodeSpec();
    expect(validateSpec(spec)).toBeNull();
    const asset = spec.assets[0] as Extract<AssetSpec, { kind: "jsonEntries" }>;
    expect(asset.path).toBe("settings.json");
    expect(asset.mapPath).toEqual(["hooks"]);
    expect(asset.entries).toHaveLength(1);
    const sessionStart = asset.entries[0]!;
    expect(sessionStart.key).toBe("SessionStart");
    expect(sessionStart.groups.map((g) => g.identity)).toEqual([
      "engram-hook:claude-code:startup",
      "engram-hook:claude-code:resume",
      "engram-hook:claude-code:compact",
    ]);
    for (const g of sessionStart.groups) {
      expect(g.group.matcher).toBe(g.identity.split(":").at(-1));
      const inner = (g.group.hooks as Array<Record<string, unknown>>)[0]!;
      expect(inner.command).toBe(`engram hook claude-code ${g.identity.split(":").at(-1)}`);
      expect(inner.timeout).toBe(HOST_HOOK_TIMEOUT_SECONDS);
    }
    // turn-2 (F2): markerless mode — no engram keys inside settings.json
    expect(asset.entryMarker).toBeUndefined();
    expect(asset.registryKey).toBeUndefined();
    const sidecar = spec.assets[1] as Extract<AssetSpec, { kind: "file" }>;
    expect(sidecar.path).toBe(SIDECAR_FILENAME);
    expect(sidecar.markers?.begin).toContain("engram-claude-code-sidecar");
    expect(sidecar.markers?.end).toContain("engram-claude-code-sidecar");
    expect(validateSpec({ assets: [sidecar] })).toBeNull();
  });

  it("hook commands contain no absolute paths (A5)", () => {
    const asset = claudeCodeSpec().assets[0] as Extract<AssetSpec, { kind: "jsonEntries" }>;
    for (const entry of asset.entries) {
      for (const g of entry.groups) {
        for (const inner of g.group.hooks as Array<Record<string, unknown>>) {
          expect(String(inner.command).startsWith("engram ")).toBe(true);
          expect(String(inner.command)).not.toContain("/");
        }
      }
    }
  });

  it("installs into <home>/.claude preserving the canonical fixture (end-to-end)", async () => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const fixture = fs.readFileSync(
      path.join(import.meta.dirname, "fixtures", "claude-settings-canonical.json"),
      "utf8",
    );
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), fixture);

    const spec = claudeCodeSpec();
    const root = claudeCodeRoot(home);
    await run(applyPlan(root, planInstall(await run(scanAssets(root, spec)))));

    const doc = JSON.parse(
      fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"),
    ) as any;
    expect(doc.model).toBe("opus"); // untouched
    expect(doc.permissions).toEqual({ allow: ["Bash(pnpm:*)"] }); // untouched
    const groups = doc.hooks.SessionStart as Array<Record<string, any>>;
    expect(groups).toHaveLength(4); // 1 user + 3 engram
    expect(groups[0]?.hooks?.[0]?.command).toBe("user-own-hook --flag"); // user entry first, untouched
    // engram groups carry only documented Claude schema keys (turn-2, F2)
    for (const g of groups.slice(1)) {
      for (const key of Object.keys(g)) expect(["matcher", "hooks"]).toContain(key);
      expect(g.matcher).toMatch(/^(startup|resume|compact)$/);
    }
    // ownership ledger lives in the engram-owned sidecar, itself valid JSON
    const ledger = parseSidecarLedger(
      fs.readFileSync(path.join(home, ".claude", SIDECAR_FILENAME), "utf8"),
    );
    expect(ledger?.target).toBe("claude-code");
    expect(ledger?.configFile).toBe("settings.json");
    expect(ledger?.entries.map((e) => e.identity).sort((a, b) => a.localeCompare(b))).toEqual([
      "engram-hook:claude-code:compact",
      "engram-hook:claude-code:resume",
      "engram-hook:claude-code:startup",
    ]);

    // idempotent across both assets
    const scan2 = await run(scanAssets(root, spec));
    expect(scan2.states.map((s) => s.status)).toEqual(["current", "current"]);
    expect(planInstall(scan2).actions).toHaveLength(0);

    // uninstall leaves only the user entry
    await run(applyPlan(root, planUninstall(await run(scanAssets(root, spec)))));
    const after = JSON.parse(
      fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"),
    ) as any;
    expect(after.hooks.SessionStart).toHaveLength(1);
    expect(after.hooks.SessionStart[0].hooks[0].command).toBe("user-own-hook --flag");
    expect(after[OWNERSHIP_MARKER_KEY]).toBeUndefined();
    expect(after.model).toBe("opus");
    // uninstall removes the sidecar itself (turn-2, F2)
    expect(fs.existsSync(path.join(home, ".claude", SIDECAR_FILENAME))).toBe(false);
  });

  it("drift repair rebuilds a stale or missing sidecar (turn-2, F2)", async () => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}\n");
    const spec = claudeCodeSpec();
    const root = claudeCodeRoot(home);
    const sidecarPath = path.join(home, ".claude", SIDECAR_FILENAME);

    await run(applyPlan(root, planInstall(await run(scanAssets(root, spec)))));

    // stale sidecar: markers intact, ledger content differs -> drift -> repair
    const stale = fs.readFileSync(sidecarPath, "utf8").replace('"version": 1', '"version": 99');
    fs.writeFileSync(sidecarPath, stale);
    const scan = await run(scanAssets(root, spec));
    expect(scan.states[1]?.status).toBe("drift");
    await run(applyPlan(root, planInstall(scan)));
    const scanRepaired = await run(scanAssets(root, spec));
    expect(scanRepaired.states[1]?.status).toBe("current");
    const repaired = parseSidecarLedger(fs.readFileSync(sidecarPath, "utf8"));
    expect(repaired?.version).toBe(1);

    // missing sidecar: entries still recognized -> absent -> rewritten
    fs.rmSync(sidecarPath);
    const scanMissing = await run(scanAssets(root, spec));
    expect(scanMissing.states[0]?.status).toBe("current"); // entries match
    expect(scanMissing.states[1]?.status).toBe("absent");
    await run(applyPlan(root, planInstall(scanMissing)));
    expect(parseSidecarLedger(fs.readFileSync(sidecarPath, "utf8"))?.entries).toHaveLength(3);
  });

  it("hand-edited entries with altered commands are left alone (A3, turn-2)", async () => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}\n");
    const spec = claudeCodeSpec();
    const root = claudeCodeRoot(home);
    await run(applyPlan(root, planInstall(await run(scanAssets(root, spec)))));

    // hand-edit one engram group's command
    const settingsPath = path.join(home, ".claude", "settings.json");
    const doc = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as any;
    const resume = doc.hooks.SessionStart.find((g: any) => g.matcher === "resume");
    resume.hooks[0].command = "hand-edited engram hook claude-code resume";
    fs.writeFileSync(settingsPath, `${JSON.stringify(doc, null, 2)}\n`);

    // uninstall removes only recognizable entries; the hand-edited one stays
    await run(applyPlan(root, planUninstall(await run(scanAssets(root, spec)))));
    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as any;
    expect(after.hooks.SessionStart).toHaveLength(1);
    expect(after.hooks.SessionStart[0].hooks[0].command).toBe(
      "hand-edited engram hook claude-code resume",
    );
  });

  it("root is <home>/.claude", () => {
    expect(claudeCodeRoot("/h").endsWith(".claude")).toBe(true);
  });
});

describe("codex target spec", () => {
  it("maps startup and compaction only; resume shares SessionStart (A1, A6)", () => {
    const spec = codexSpec();
    expect(validateSpec(spec)).toBeNull();
    const asset = spec.assets[0] as Extract<AssetSpec, { kind: "jsonEntries" }>;
    expect(asset.path).toBe("hooks.json");
    expect(asset.mapPath).toEqual(["hooks"]);
    expect(asset.entries.map((e) => e.key)).toEqual(["SessionStart", "PostCompact"]);
    const identities = asset.entries.flatMap((e) => e.groups.map((g) => g.identity));
    expect(identities).toEqual(["engram-hook:codex:startup", "engram-hook:codex:compact"]);
    // turn-2 (F2): markerless mode — hooks.json carries only spec-valid keys
    expect(asset.entryMarker).toBeUndefined();
    expect(asset.registryKey).toBeUndefined();
    const sidecar = spec.assets[1] as Extract<AssetSpec, { kind: "file" }>;
    expect(sidecar.path).toBe(SIDECAR_FILENAME);
    expect(sidecar.markers?.begin).toContain("engram-codex-sidecar");
    expect(sidecar.markers?.end).toContain("engram-codex-sidecar");
    expect(validateSpec({ assets: [sidecar] })).toBeNull();
    for (const entry of asset.entries) {
      for (const g of entry.groups) {
        expect(g.group.matcher).toBeUndefined(); // observed codex schema has no matcher
        const inner = (g.group.hooks as Array<Record<string, unknown>>)[0]!;
        expect(inner.type).toBe("command");
        expect(inner.timeout).toBe(HOST_HOOK_TIMEOUT_SECONDS);
        expect(String(inner.command)).not.toContain("/");
      }
    }
  });

  it("merges into the observed codex 0.155.1 fixture shape without touching user hooks", async () => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    const fixture = fs.readFileSync(
      path.join(import.meta.dirname, "fixtures", "codex-hooks-0.155.1.json"),
      "utf8",
    );
    fs.writeFileSync(path.join(home, ".codex", "hooks.json"), fixture);

    const spec = codexSpec();
    const root = codexRoot(home);
    await run(applyPlan(root, planInstall(await run(scanAssets(root, spec)))));

    const doc = JSON.parse(fs.readFileSync(path.join(home, ".codex", "hooks.json"), "utf8")) as any;
    const startGroups = doc.hooks.SessionStart as Array<Record<string, any>>;
    expect(startGroups).toHaveLength(2);
    expect(startGroups[0]?.hooks?.[0]?.command).toContain("herdr-agent-state.sh"); // user entry untouched
    expect(startGroups[1]?.hooks?.[0]?.command).toBe("engram hook codex startup");
    const compactGroups = doc.hooks.PostCompact as Array<Record<string, any>>;
    expect(compactGroups).toHaveLength(1);
    expect(compactGroups[0]?.hooks?.[0]?.command).toBe("engram hook codex compact");
    // only keys observed in the pinned codex schema (turn-2: no marker keys)
    for (const group of [...startGroups, ...compactGroups]) {
      for (const key of Object.keys(group)) {
        expect(key).toBe("hooks");
      }
    }
    // ownership ledger lives in the engram-owned sidecar, itself valid JSON
    const ledger = parseSidecarLedger(
      fs.readFileSync(path.join(home, ".codex", SIDECAR_FILENAME), "utf8"),
    );
    expect(ledger?.target).toBe("codex");
    expect(ledger?.configFile).toBe("hooks.json");
    expect(ledger?.entries.map((e) => e.identity).sort((a, b) => a.localeCompare(b))).toEqual([
      "engram-hook:codex:compact",
      "engram-hook:codex:startup",
    ]);

    const scan2 = await run(scanAssets(root, spec));
    expect(scan2.states.map((s) => s.status)).toEqual(["current", "current"]);
    expect(planInstall(scan2).actions).toHaveLength(0);

    await run(applyPlan(root, planUninstall(await run(scanAssets(root, spec)))));
    const after = JSON.parse(
      fs.readFileSync(path.join(home, ".codex", "hooks.json"), "utf8"),
    ) as any;
    expect(after).toEqual(JSON.parse(fixture)); // back to the user's exact content
    // uninstall removes the sidecar itself (turn-2, F2)
    expect(fs.existsSync(path.join(home, ".codex", SIDECAR_FILENAME))).toBe(false);
  });

  it("root is <home>/.codex", () => {
    expect(codexRoot("/h").endsWith(".codex")).toBe(true);
  });

  it("codexHooksFlagState detects inline and section table forms (P2b)", () => {
    expect(codexHooksFlagState('model = "x"\n\n[features]\nhooks = false\n')).toBe("disabled");
    expect(codexHooksFlagState("[features]\nhooks = true\n")).toBe("enabled");
    expect(codexHooksFlagState("features = { hooks = false }\n")).toBe("disabled");
    expect(codexHooksFlagState("features = {hooks=false}\n")).toBe("disabled");
    expect(codexHooksFlagState("features = { hooks = true, other = 1 }\n")).toBe("enabled");
    expect(codexHooksFlagState("features = { other = true }\n")).toBe("default");
    expect(codexHooksFlagState(null)).toBe("default");
    expect(codexHooksFlagState('model = "x"\n')).toBe("default");
    // commented-out lines never count
    expect(codexHooksFlagState("# hooks = false\n")).toBe("default");
    // a hooks key outside [features] is not the feature flag
    expect(codexHooksFlagState("[other]\nhooks = false\n")).toBe("default");
    // turn-5: inline tables under other tables belong to that table
    expect(codexHooksFlagState("[other]\nfeatures = { hooks = false }\n")).toBe("default");
    // quoted keys and headers are honored
    expect(codexHooksFlagState('["features"]\nhooks = false\n')).toBe("disabled");
    expect(codexHooksFlagState('features = { "hooks" = false }\n')).toBe("disabled");
  });
});

/* ----------------- core: jsonEntries markerless mode (F2) ----------------- */

describe("installer core / jsonEntries markerless mode", () => {
  const plainAsset = (
    over: Partial<Extract<AssetSpec, { kind: "jsonEntries" }>> = {},
  ): AssetSpec => ({
    kind: "jsonEntries",
    id: "engram-plain-hooks",
    path: "config/hooks.json",
    mapPath: ["hooks"],
    entries: [
      {
        key: "SessionStart",
        groups: [
          {
            identity: "engram-hook:plain:startup",
            group: {
              hooks: [{ type: "command", command: "engram hook plain startup", timeout: 10 }],
            },
          },
        ],
      },
    ],
    ...over,
  });

  it("requires entryMarker and registryKey to be set together", () => {
    expect(
      validateSpec({ assets: [plainAsset({ entryMarker: ENTRY_MARKER_KEY })] })?.message,
    ).toMatch(/together/i);
    expect(
      validateSpec({ assets: [plainAsset({ registryKey: OWNERSHIP_MARKER_KEY })] })?.message,
    ).toMatch(/together/i);
  });

  it("rejects duplicate group content (content-addressing needs distinct groups)", () => {
    const group = { hooks: [{ type: "command", command: "same" }] };
    expect(
      validateSpec({
        assets: [
          plainAsset({
            entries: [
              {
                key: "SessionStart",
                groups: [
                  { identity: "engram-hook:plain:a", group },
                  { identity: "engram-hook:plain:b", group },
                ],
              },
            ],
          }),
        ],
      })?.message,
    ).toMatch(/duplicate group content/i);
  });

  it("installs groups without marker keys and stays idempotent", async () => {
    writeRoot("config/hooks.json", canon({}));
    const spec: InstallSpec = { assets: [plainAsset()] };
    await run(applyPlan(tmp, planInstall(await run(scanAssets(tmp, spec)))));

    const groups = (installedDoc() as any).hooks.SessionStart as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(1);
    expect(Object.keys(groups[0]!)).toEqual(["hooks"]); // only spec-valid keys
    expect(installedDoc()[OWNERSHIP_MARKER_KEY]).toBeUndefined();

    const scan2 = await run(scanAssets(tmp, spec));
    expect(scan2.states[0]?.status).toBe("current");
    expect(scan2.states[0]?.reasons).toEqual([]);
    expect(planInstall(scan2).actions).toHaveLength(0);
  });

  it("uninstall removes only canonical-matching entries and prunes containers", async () => {
    writeRoot(
      "config/hooks.json",
      canon({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "user-own-hook" }] },
            { hooks: [{ type: "command", command: "engram hook plain startup", timeout: 10 }] },
          ],
        },
      }),
    );
    const spec: InstallSpec = { assets: [plainAsset()] };
    await run(applyPlan(tmp, planUninstall(await run(scanAssets(tmp, spec)))));

    const groups = (installedDoc() as any).hooks.SessionStart as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(1); // only the user entry remains
    expect(groups[0]?.hooks).toEqual([{ type: "command", command: "user-own-hook" }]);
  });

  it("hand-edited entries (changed command) are never recognized or removed", async () => {
    writeRoot(
      "config/hooks.json",
      canon({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "hand-edited engram hook plain startup" }] },
          ],
        },
      }),
    );
    const spec: InstallSpec = { assets: [plainAsset()] };
    const scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]?.status).toBe("absent"); // nothing recognizable
    await run(applyPlan(tmp, planInstall(scan)));
    let groups = (installedDoc() as any).hooks.SessionStart as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(2); // hand-edited untouched + fresh engram entry

    await run(applyPlan(tmp, planUninstall(await run(scanAssets(tmp, spec)))));
    groups = (installedDoc() as any).hooks.SessionStart as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(1);
    expect(groups[0]?.hooks).toEqual([
      { type: "command", command: "hand-edited engram hook plain startup" },
    ]);
  });

  it("duplicate copies of spec-identical entries are drift; install dedupes them", async () => {
    const group = {
      hooks: [{ type: "command", command: "engram hook plain startup", timeout: 10 }],
    };
    writeRoot("config/hooks.json", canon({ hooks: { SessionStart: [group, group] } }));
    const spec: InstallSpec = { assets: [plainAsset()] };
    const scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]?.status).toBe("drift");
    await run(applyPlan(tmp, planInstall(scan)));
    const groups = (installedDoc() as any).hooks.SessionStart as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(1);
    const scan2 = await run(scanAssets(tmp, spec));
    expect(scan2.states[0]?.status).toBe("current");
  });

  it("recognizes entries whose keys are reordered (P1c)", async () => {
    // same values as the spec group, keys reordered at both nesting levels
    writeRoot(
      "config/hooks.json",
      canon({
        hooks: {
          SessionStart: [
            { hooks: [{ timeout: 10, type: "command", command: "engram hook plain startup" }] },
          ],
        },
      }),
    );
    const spec: InstallSpec = { assets: [plainAsset()] };
    const scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]?.status).toBe("current");
    expect(planInstall(scan).actions).toHaveLength(0);

    // uninstall removes the reordered entry too (container then prunes)
    await run(applyPlan(tmp, planUninstall(scan)));
    const after = installedDoc() as any;
    expect(after.hooks?.SessionStart ?? []).toHaveLength(0);
  });

  it("uninstall keeps a foreign duplicate of an engram hook (P1b)", async () => {
    writeRoot("config/hooks.json", canon({}));
    const spec: InstallSpec = { assets: [plainAsset()] };
    await run(applyPlan(tmp, planInstall(await run(scanAssets(tmp, spec)))));

    // the user independently adds a hook identical to engram's
    const doc = installedDoc() as any;
    doc.hooks.SessionStart.push(doc.hooks.SessionStart[0]);
    fs.writeFileSync(path.join(tmp, "config/hooks.json"), `${JSON.stringify(doc, null, 2)}\n`);

    await run(applyPlan(tmp, planUninstall(await run(scanAssets(tmp, spec)))));
    const groups = (installedDoc() as any).hooks.SessionStart as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(1); // only the foreign duplicate survives
    expect(groups[0]?.hooks).toEqual([
      { type: "command", command: "engram hook plain startup", timeout: 10 },
    ]);
  });

  it("cross-event copies of engram entries are foreign and survive uninstall (P1b)", async () => {
    writeRoot("config/hooks.json", canon({}));
    const spec: InstallSpec = { assets: [plainAsset()] };
    await run(applyPlan(tmp, planInstall(await run(scanAssets(tmp, spec)))));

    // user copies the engram group under a different event key
    const doc = installedDoc() as any;
    doc.hooks.SessionEnd = [doc.hooks.SessionStart[0]];
    fs.writeFileSync(path.join(tmp, "config/hooks.json"), `${JSON.stringify(doc, null, 2)}\n`);

    await run(applyPlan(tmp, planUninstall(await run(scanAssets(tmp, spec)))));
    const after = installedDoc() as any;
    expect(after.hooks.SessionStart).toBeUndefined(); // ours removed
    expect(after.hooks.SessionEnd).toHaveLength(1); // the copy is foreign
  });
});

/* --------------------- generic target (ENG-37 turn 1) --------------------- */

describe("generic install target (ENG-37)", () => {
  /** Exact managed block the installer writes: markers, template, LF endings. */
  const block = (): string =>
    `${GENERIC_BEGIN_MARKER}\n${ENGRAM_GUIDANCE_TEMPLATE}\n${GENERIC_END_MARKER}\n`;

  it("declares one valid text asset on AGENTS.md with id-bearing HTML-comment markers", () => {
    const spec = genericSpec();
    expect(spec.assets).toHaveLength(1);
    const asset = spec.assets[0] as Extract<AssetSpec, { kind: "text" }>;
    expect(asset.kind).toBe("text");
    expect(asset.id).toBe(GENERIC_ASSET_ID);
    expect(asset.id).toBe("engram-agents-instructions");
    expect(asset.path).toBe(GENERIC_AGENTS_PATH);
    expect(asset.path).toBe("AGENTS.md");
    // POSIX-style relative path: the core rejects backslashes outright
    expect(asset.path.includes("\\")).toBe(false);
    expect(validateSpec(spec)).toBeNull();
    expect(asset.beginMarker).toBe(GENERIC_BEGIN_MARKER);
    expect(asset.endMarker).toBe(GENERIC_END_MARKER);
    expect(GENERIC_BEGIN_MARKER).toContain(GENERIC_ASSET_ID);
    expect(GENERIC_END_MARKER).toContain(GENERIC_ASSET_ID);
    expect(GENERIC_BEGIN_MARKER).not.toBe(GENERIC_END_MARKER);
    // project targets root at the project directory itself; a
    // trailing-separator-only root stays the root and never degenerates
    expect(genericRoot("/")).toBe("/");
    expect(genericRoot("///")).toBe("/");
    expect(genericRoot("/some/project/")).toBe("/some/project");
    expect(genericRoot("/some/project")).toBe("/some/project");
  });

  it("installs into a fresh root and reports current afterwards", async () => {
    const spec = genericSpec();
    let scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]!.status).toBe("absent");
    const plan = planInstall(scan);
    expect(plan.blocked).toHaveLength(0);
    expect(plan.actions).toEqual([
      { op: "write", path: "AGENTS.md", before: null, after: block() },
    ]);
    await run(applyPlan(tmp, plan));
    expect(readRoot("AGENTS.md")).toBe(block());
    scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]!.status).toBe("current");
    expect(planInstall(scan).actions).toHaveLength(0);
  });

  it("appends to foreign content byte-for-byte and re-runs stay idempotent", async () => {
    const foreignTop = "# My project\n\nAgent notes live here.\n\n";
    const foreignBottom = "## Build\n\npnpm test\n";
    writeRoot("AGENTS.md", `${foreignTop}${foreignBottom}`);
    const spec = genericSpec();
    await run(applyPlan(tmp, planInstall(await run(scanAssets(tmp, spec)))));
    expect(readRoot("AGENTS.md")).toBe(`${foreignTop}${foreignBottom}${block()}`);

    const scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]!.status).toBe("current");
    expect(planInstall(scan).actions).toHaveLength(0);
  });

  it("drift repair rebuilds the managed block in place and keeps foreign content", async () => {
    const foreign = "# My project\n";
    const spec = genericSpec();
    const agents = path.join(tmp, "AGENTS.md");
    fs.writeFileSync(agents, `${foreign}${block()}`.replace("engram search", "engram SERACH"));

    let scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]!.status).toBe("drift");
    await run(applyPlan(tmp, planInstall(scan)));
    expect(readRoot("AGENTS.md")).toBe(`${foreign}${block()}`);

    scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]!.status).toBe("current");
  });

  it("uninstall removes only the managed block; AGENTS.md always survives", async () => {
    const foreign = "# My project\n";
    const spec = genericSpec();
    // nothing installed: uninstall is a no-op, the file is never touched
    writeRoot("AGENTS.md", foreign);
    let scan = await run(scanAssets(tmp, spec));
    expect(planUninstall(scan).actions).toHaveLength(0);

    await run(applyPlan(tmp, planInstall(await run(scanAssets(tmp, spec)))));
    scan = await run(scanAssets(tmp, spec));
    const plan = planUninstall(scan);
    expect(plan.actions).toEqual([
      { op: "write", path: "AGENTS.md", before: `${foreign}${block()}`, after: foreign },
    ]);
    await run(applyPlan(tmp, plan));
    expect(readRoot("AGENTS.md")).toBe(foreign);

    // turn-1 review note 4: foreign content BELOW the block survives too
    const trailing = "\nTeam conventions live after the block.\n";
    writeRoot("AGENTS.md", `${foreign}${block()}${trailing}`);
    scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]!.status).toBe("current"); // text assets ignore outside content
    await run(applyPlan(tmp, planUninstall(scan)));
    expect(readRoot("AGENTS.md")).toBe(`${foreign}${trailing}`);
  });

  it("duplicated markers are corrupt and install refuses them without force", async () => {
    const spec = genericSpec();
    writeRoot("AGENTS.md", `${block()}${block()}`);
    const scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]!.status).toBe("corrupt");
    const plan = planInstall(scan);
    expect(plan.actions).toHaveLength(0);
    expect(plan.blocked).toEqual([
      { id: GENERIC_ASSET_ID, status: "corrupt", reasons: ["unbalanced or duplicated markers"] },
    ]);
  });

  it("CRLF: markers still match, foreign bytes survive, managed block stays LF", async () => {
    const foreignCrlf = "# Project\r\nWindows-edited notes.\r\n";
    const spec = genericSpec();
    writeRoot("AGENTS.md", foreignCrlf);

    let scan = await run(scanAssets(tmp, spec));
    // no markers yet: a text asset appends regardless of line endings
    expect(scan.states[0]!.status).toBe("absent");
    await run(applyPlan(tmp, planInstall(scan)));
    const after = readRoot("AGENTS.md")!;
    // foreign CRLF bytes intact, managed block written LF per core renderBlock
    expect(after.startsWith(foreignCrlf)).toBe(true);
    expect(after).toBe(`${foreignCrlf}${block()}`);

    scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]!.status).toBe("current");

    await run(applyPlan(tmp, planUninstall(scan)));
    expect(readRoot("AGENTS.md")).toBe(foreignCrlf);
  });

  it("shared guidance template is bounded and carries the required semantics", () => {
    const template = ENGRAM_GUIDANCE_TEMPLATE;
    expect(template.split("\n").length).toBeLessThanOrEqual(40);
    // explicit manual session start; never claims automatic loading
    expect(template).toContain("`engram context`");
    expect(template).toMatch(/manual/i);
    expect(template).not.toMatch(/automatic/i);
    // search/show for specifics, add with --type decision
    expect(template).toContain("`engram search");
    expect(template).toContain("`engram show");
    expect(template).toContain("`engram add`");
    expect(template).toContain("--type decision");
    // never hand-create engram files or guess ids
    expect(template).toMatch(/never hand-create/i);
    expect(template).toContain(".engram/engrams/");
    expect(template).toMatch(/never guess/i);
    // personal scope, brief do/do-not recording rules
    expect(template).toContain("--scope personal");
    expect(template).toMatch(/do record/i);
    expect(template).toMatch(/do not record/i);
    // precedence caveat, phrased like the in-repo precedents
    expect(template).toContain("system, user, and repository instructions");
    // CLI-variant only: no harness tool names, no hook targets, no host names
    expect(template).not.toMatch(/engram_/);
    expect(template).not.toMatch(/engram hook|claude-code|codex|cursor|\bpi\b/);
  });
});

/* --------------------- cursor target (ENG-37 turn 2) --------------------- */

describe("cursor install target (ENG-37)", () => {
  /** Exact rendered file: frontmatter header first, markers wrapping the body. */
  const file = (): string =>
    `${CURSOR_HEADER}\n${CURSOR_BEGIN_MARKER}\n${ENGRAM_GUIDANCE_TEMPLATE}\n${CURSOR_END_MARKER}\n`;

  it("declares one valid wholly-owned file asset: frontmatter header, markered shared body", () => {
    const spec = cursorSpec();
    expect(spec.assets).toHaveLength(1);
    const asset = spec.assets[0] as Extract<AssetSpec, { kind: "file" }>;
    expect(asset.kind).toBe("file");
    expect(asset.id).toBe(CURSOR_ASSET_ID);
    expect(asset.id).toBe("engram-cursor-rules");
    expect(asset.path).toBe(CURSOR_RULES_PATH);
    expect(asset.path).toBe(".cursor/rules/engram.mdc");
    expect(asset.path.includes("\\")).toBe(false);
    expect(validateSpec(spec)).toBeNull();
    // frontmatter is the declared header: the file's first lines, documented
    // and guaranteed-parsed cursor shape
    expect(asset.header).toBe(CURSOR_HEADER);
    expect(CURSOR_HEADER).toMatch(/^---\n/);
    expect(CURSOR_HEADER).toMatch(/\n---$/);
    expect(CURSOR_HEADER).toContain("alwaysApply: true");
    expect(CURSOR_HEADER).toMatch(/^description: /m);
    // markers wrap only the body; the body is the shared template verbatim
    expect(asset.markers!.begin).toBe(CURSOR_BEGIN_MARKER);
    expect(asset.markers!.end).toBe(CURSOR_END_MARKER);
    expect(CURSOR_BEGIN_MARKER).toContain(CURSOR_ASSET_ID);
    expect(CURSOR_END_MARKER).toContain(CURSOR_ASSET_ID);
    expect(CURSOR_BEGIN_MARKER).not.toBe(CURSOR_END_MARKER);
    expect(asset.content).toBe(ENGRAM_GUIDANCE_TEMPLATE);
    expect(cursorRoot("/")).toBe("/");
    expect(cursorRoot("///")).toBe("/");
    expect(cursorRoot("/some/project/")).toBe("/some/project");
  });

  it("fresh install creates .cursor/rules/ and the exact frontmatter-first file", async () => {
    const spec = cursorSpec();
    let scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]!.status).toBe("absent");
    const plan = planInstall(scan);
    expect(plan.blocked).toHaveLength(0);
    expect(plan.actions).toEqual([
      { op: "mkdir", path: ".cursor/rules" },
      { op: "write", path: ".cursor/rules/engram.mdc", before: null, after: file() },
    ]);
    await run(applyPlan(tmp, plan));
    expect(readRoot(".cursor/rules/engram.mdc")).toBe(file());
    scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]!.status).toBe("current");
    expect(planInstall(scan).actions).toHaveLength(0);
  });

  it("body and frontmatter drift are repaired in place to the exact declared file", async () => {
    const spec = cursorSpec();
    const agents = path.join(tmp, ".cursor/rules/engram.mdc");
    fs.mkdirSync(path.dirname(agents), { recursive: true });
    // body drift
    fs.writeFileSync(agents, file().replace("engram search", "engram SERACH"));
    let scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]!.status).toBe("drift");
    await run(applyPlan(tmp, planInstall(scan)));
    expect(readRoot(".cursor/rules/engram.mdc")).toBe(file());

    // frontmatter drift (hand edit above the markers) repairs away too
    fs.writeFileSync(agents, file().replace("alwaysApply: true", "alwaysApply: false"));
    scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]!.status).toBe("drift");
    expect(scan.states[0]!.reasons).toContain("unmanaged content outside managed block");
    await run(applyPlan(tmp, planInstall(scan)));
    expect(readRoot(".cursor/rules/engram.mdc")).toBe(file());

    scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]!.status).toBe("current");
  });

  it("a pre-existing foreign engram.mdc is blocked and never clobbered", async () => {
    const foreignFile = "---\ndescription: my own engram notes\nalwaysApply: true\n---\n\nMine.\n";
    const spec = cursorSpec();
    writeRoot(".cursor/rules/engram.mdc", foreignFile);

    const scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]!.status).toBe("blocked");
    const plan = planInstall(scan);
    expect(plan.actions).toHaveLength(0);
    expect(plan.blocked).toEqual([
      {
        id: CURSOR_ASSET_ID,
        status: "blocked",
        reasons: ["unmanaged file exists at target path (use force to overwrite)"],
      },
    ]);
    expect(readRoot(".cursor/rules/engram.mdc")).toBe(foreignFile);
  });

  it("uninstall removes exactly our file; trailing hand-edits block without force", async () => {
    const spec = cursorSpec();
    await run(applyPlan(tmp, planInstall(await run(scanAssets(tmp, spec)))));
    const extra = `${file()}\nHand-added note.\n`;
    fs.writeFileSync(path.join(tmp, ".cursor/rules/engram.mdc"), extra);

    let scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]!.status).toBe("drift");
    const plan = planUninstall(scan);
    expect(plan.actions).toHaveLength(0);
    expect(plan.blocked).toEqual([
      {
        id: CURSOR_ASSET_ID,
        status: "drift",
        reasons: ["managed file has extra unmanaged content (use force to remove)"],
      },
    ]);
    expect(readRoot(".cursor/rules/engram.mdc")).toBe(extra);

    // exact file: uninstall removes it wholly
    fs.writeFileSync(path.join(tmp, ".cursor/rules/engram.mdc"), file());
    scan = await run(scanAssets(tmp, spec));
    const clean = planUninstall(scan);
    expect(clean.actions).toEqual([
      { op: "remove", path: ".cursor/rules/engram.mdc", before: file() },
    ]);
    await run(applyPlan(tmp, clean));
    expect(fs.existsSync(path.join(tmp, ".cursor/rules/engram.mdc"))).toBe(false);
  });

  it("uninstall leaves user .mdc files in .cursor/rules/ untouched", async () => {
    const userRule = "---\ndescription: user rule\nglobs: *.ts\n---\n\nKeep types strict.\n";
    writeRoot(".cursor/rules/my-rules.mdc", userRule);
    const spec = cursorSpec();

    let scan = await run(scanAssets(tmp, spec));
    expect(planUninstall(scan).actions).toHaveLength(0);

    await run(applyPlan(tmp, planInstall(scan)));
    expect(readRoot(".cursor/rules/my-rules.mdc")).toBe(userRule);

    scan = await run(scanAssets(tmp, spec));
    await run(applyPlan(tmp, planUninstall(scan)));
    expect(fs.existsSync(path.join(tmp, ".cursor/rules/engram.mdc"))).toBe(false);
    expect(readRoot(".cursor/rules/my-rules.mdc")).toBe(userRule);
  });
});

/* --------------------- claude target (ENG-37 turn 3) --------------------- */

describe("claude install target (ENG-37)", () => {
  /** Source-of-truth scaffold assets, read from their in-repo locations. */
  const repoSkill = (): string =>
    fs.readFileSync(fileURLToPath(new URL("../claude/scaffold/SKILL.md", import.meta.url)), "utf8");
  const repoLauncher = (): string =>
    fs.readFileSync(fileURLToPath(new URL("../claude/bin/engram", import.meta.url)), "utf8");

  const splitFrontmatter = (src: string): { header: string; body: string } => {
    const m = /^---\n[\s\S]*?\n---\n/.exec(src);
    if (m === null) throw new Error("scaffold SKILL.md has no frontmatter");
    return { header: m[0].replace(/\n$/, ""), body: src.slice(m[0].length) };
  };

  const skillFile = (): string => {
    const { header, body } = splitFrontmatter(repoSkill());
    return `${header}\n${CLAUDE_SKILL_BEGIN_MARKER}\n${body}${CLAUDE_SKILL_END_MARKER}\n`;
  };
  const launcherFile = (): string => {
    const rest = repoLauncher().slice(repoLauncher().indexOf("\n") + 1);
    return `#!/bin/sh\n${CLAUDE_LAUNCHER_BEGIN_MARKER}\n${rest}${CLAUDE_LAUNCHER_END_MARKER}\n`;
  };

  it("declares two valid markered assets sourced from the repo files, no hard-coded versions", () => {
    const spec = claudeSpec();
    expect(spec.assets).toHaveLength(2);
    const skill = spec.assets[0] as Extract<AssetSpec, { kind: "file" }>;
    const launcher = spec.assets[1] as Extract<AssetSpec, { kind: "file" }>;

    expect(skill.kind).toBe("file");
    expect(skill.id).toBe(CLAUDE_SKILL_ASSET_ID);
    expect(skill.id).toBe("engram-claude-skill");
    expect(skill.path).toBe(CLAUDE_SKILL_PATH);
    expect(skill.path).toBe(".claude/skills/engram/SKILL.md");
    expect(skill.path.includes("\\")).toBe(false);
    // frontmatter-first: the declared header is the scaffold's YAML block
    expect(skill.header).toBe(splitFrontmatter(repoSkill()).header);
    expect(skill.header).toMatch(/^---\n/);
    expect(skill.header).toMatch(/\n---$/);
    expect(skill.content).toBe(splitFrontmatter(repoSkill()).body);
    expect(CLAUDE_SKILL_BEGIN_MARKER).toContain(CLAUDE_SKILL_ASSET_ID);
    expect(CLAUDE_SKILL_END_MARKER).toContain(CLAUDE_SKILL_ASSET_ID);

    expect(launcher.id).toBe(CLAUDE_LAUNCHER_ASSET_ID);
    expect(launcher.id).toBe("engram-claude-launcher");
    expect(launcher.path).toBe(CLAUDE_LAUNCHER_PATH);
    expect(launcher.path).toBe(".claude/skills/engram/bin/engram");
    // shebang stays line 1; the body is the release-pinned launcher as-is
    expect(launcher.header).toBe("#!/bin/sh");
    expect(launcher.content).toBe(repoLauncher().slice(repoLauncher().indexOf("\n") + 1));
    expect(launcher.content).toMatch(/engram-cli@\d+\.\d+\.\d+/);
    expect(CLAUDE_LAUNCHER_BEGIN_MARKER).toContain(CLAUDE_LAUNCHER_ASSET_ID);
    expect(CLAUDE_LAUNCHER_END_MARKER).toContain(CLAUDE_LAUNCHER_ASSET_ID);

    expect(validateSpec(spec)).toBeNull();
    expect(claudeRoot("/")).toBe("/");
    expect(claudeRoot("///")).toBe("/");
    expect(claudeRoot("/some/project/")).toBe("/some/project");
  });

  it("fresh install scaffolds .claude/skills/engram/ and reports current", async () => {
    const spec = claudeSpec();
    let scan = await run(scanAssets(tmp, spec));
    expect(scan.states.map((s) => s.status)).toEqual(["absent", "absent"]);
    const plan = planInstall(scan);
    expect(plan.blocked).toHaveLength(0);
    expect(plan.actions).toEqual([
      { op: "mkdir", path: ".claude/skills/engram" },
      { op: "mkdir", path: ".claude/skills/engram/bin" },
      { op: "write", path: ".claude/skills/engram/SKILL.md", before: null, after: skillFile() },
      {
        op: "write",
        path: ".claude/skills/engram/bin/engram",
        before: null,
        after: launcherFile(),
      },
    ]);
    await run(applyPlan(tmp, plan));
    expect(readRoot(".claude/skills/engram/SKILL.md")).toBe(skillFile());
    expect(readRoot(".claude/skills/engram/bin/engram")).toBe(launcherFile());
    scan = await run(scanAssets(tmp, spec));
    expect(scan.states.map((s) => s.status)).toEqual(["current", "current"]);
    expect(planInstall(scan).actions).toHaveLength(0);
  });

  it("body, frontmatter, and version-pin drift are repaired to the repo files", async () => {
    const spec = claudeSpec();
    // version-pin bump scenario: an older release's pin inside the block
    writeRoot(
      ".claude/skills/engram/bin/engram",
      launcherFile().replace(/engram-cli@\d+\.\d+\.\d+/, "engram-cli@0.0.1"),
    );
    writeRoot(
      ".claude/skills/engram/SKILL.md",
      skillFile().replace("engram search", "engram SERACH"),
    );

    let scan = await run(scanAssets(tmp, spec));
    expect(scan.states.map((s) => s.status)).toEqual(["drift", "drift"]);
    await run(applyPlan(tmp, planInstall(scan)));
    expect(readRoot(".claude/skills/engram/SKILL.md")).toBe(skillFile());
    expect(readRoot(".claude/skills/engram/bin/engram")).toBe(launcherFile());

    // frontmatter edits above the markers repair away too
    writeRoot(".claude/skills/engram/SKILL.md", skillFile().replace("engram CLI.", "tweaked."));
    scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]!.status).toBe("drift");
    expect(scan.states[0]!.reasons).toContain("unmanaged content outside managed block");
    await run(applyPlan(tmp, planInstall(scan)));
    expect(readRoot(".claude/skills/engram/SKILL.md")).toBe(skillFile());

    scan = await run(scanAssets(tmp, spec));
    expect(scan.states.map((s) => s.status)).toEqual(["current", "current"]);
  });

  it("a foreign SKILL.md is blocked and never clobbered", async () => {
    const foreign = "---\nname: mine\ndescription: my own skill\n---\n\nMine.\n";
    writeRoot(".claude/skills/engram/SKILL.md", foreign);
    const spec = claudeSpec();

    const scan = await run(scanAssets(tmp, spec));
    expect(scan.states[0]!.status).toBe("blocked");
    expect(scan.states[1]!.status).toBe("absent");
    const plan = planInstall(scan);
    expect(plan.blocked.map((b) => b.id)).toEqual([CLAUDE_SKILL_ASSET_ID]);
    // only the launcher side is planned; the foreign skill is never touched
    expect(plan.actions.map((a) => a.path)).toEqual([
      ".claude/skills/engram/bin",
      ".claude/skills/engram/bin/engram",
    ]);
    await run(applyPlan(tmp, plan));
    expect(readRoot(".claude/skills/engram/SKILL.md")).toBe(foreign);
  });

  it("uninstall removes exactly our two files; user skills survive untouched", async () => {
    const userSkill = "---\nname: my-skill\ndescription: user skill\n---\n\nDo things.\n";
    writeRoot(".claude/skills/other-skill/SKILL.md", userSkill);
    const spec = claudeSpec();

    // nothing installed: no-op
    let scan = await run(scanAssets(tmp, spec));
    expect(planUninstall(scan).actions).toHaveLength(0);

    await run(applyPlan(tmp, planInstall(scan)));
    expect(readRoot(".claude/skills/other-skill/SKILL.md")).toBe(userSkill);

    scan = await run(scanAssets(tmp, spec));
    const plan = planUninstall(scan);
    expect(plan.actions).toEqual([
      { op: "remove", path: ".claude/skills/engram/SKILL.md", before: skillFile() },
      { op: "remove", path: ".claude/skills/engram/bin/engram", before: launcherFile() },
    ]);
    await run(applyPlan(tmp, plan));
    expect(fs.existsSync(path.join(tmp, ".claude/skills/engram/SKILL.md"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, ".claude/skills/engram/bin/engram"))).toBe(false);
    expect(readRoot(".claude/skills/other-skill/SKILL.md")).toBe(userSkill);

    // trailing hand-edit on one file blocks it without force; the other removes
    await run(applyPlan(tmp, planInstall(await run(scanAssets(tmp, spec)))));
    writeRoot(".claude/skills/engram/SKILL.md", `${skillFile()}\nextra\n`);
    scan = await run(scanAssets(tmp, spec));
    const blockedPlan = planUninstall(scan);
    expect(blockedPlan.actions).toEqual([
      { op: "remove", path: ".claude/skills/engram/bin/engram", before: launcherFile() },
    ]);
    expect(blockedPlan.blocked.map((b) => b.id)).toEqual([CLAUDE_SKILL_ASSET_ID]);
    await run(applyPlan(tmp, planUninstall(scan, { force: true })));
    expect(fs.existsSync(path.join(tmp, ".claude/skills/engram/SKILL.md"))).toBe(false);
  });
});
