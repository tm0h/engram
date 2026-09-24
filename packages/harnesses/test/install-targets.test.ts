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
