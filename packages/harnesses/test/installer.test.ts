/**
 * ENG-34 installer core: idempotent, previewable, reversible installation of
 * harness integration assets. Scenarios map one-to-one to the ENG-34
 * acceptance criteria (idempotency, marker preservation, preview purity,
 * atomic writes with interruption diagnostics, drift, pre-existing files,
 * rollback, owned-only removal, host neutrality).
 *
 * Filesystem tests run against real NodeServices on mkdtempSync directories.
 * Suite runs must set TMPDIR to a clean directory (host /tmp is contaminated).
 */
import { describe, it, expect, beforeEach, afterEach } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import { layer as pathLayer, Path } from "effect/Path";
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
  type ScanResult,
} from "../src/shared/installer.js";

/* ------------------------------ helpers ------------------------------ */

const Live = NodeServices.layer;

const run = <A>(eff: Effect.Effect<A, InstallerError, FileSystem | Path>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, Live));

const runExit = <A>(
  eff: Effect.Effect<A, InstallerError, never>,
): Promise<Exit.Exit<A, InstallerError>> => Effect.runPromiseExit(eff);

const BEGIN = ">>> engram:test-asset >>>";
const END = "<<< engram:test-asset <<<";
const BEGIN_FILE = ">>> engram:test-file >>>";
const END_FILE = "<<< engram:test-file <<<";

const textAsset = (over: Partial<Extract<AssetSpec, { kind: "text" }>> = {}): AssetSpec => ({
  kind: "text",
  id: "test-asset",
  path: "config/tool.conf",
  beginMarker: BEGIN,
  endMarker: END,
  content: "managed line 1\nmanaged line 2",
  ...over,
});

const fileAsset = (over: Partial<Extract<AssetSpec, { kind: "file" }>> = {}): AssetSpec => ({
  kind: "file",
  id: "test-file",
  path: "assets/skill.md",
  content: "# Owned file\n",
  ...over,
});

const jsonAsset = (over: Partial<Extract<AssetSpec, { kind: "json" }>> = {}): AssetSpec => ({
  kind: "json",
  id: "test-json",
  path: "config/settings.json",
  keyPath: ["integrations", "engram"],
  value: { enabled: true, level: 2 },
  ...over,
});

const spec = (assets: ReadonlyArray<AssetSpec>): InstallSpec => ({ assets });

const block = (content: string): string => `${BEGIN}\n${content}\n${END}\n`;
const fileBlock = (content: string): string => `${BEGIN_FILE}\n${content}\n${END_FILE}\n`;

const state = (
  spec: AssetSpec,
  status: ScanResult["states"][number]["status"],
  current: string | null,
  reasons: ReadonlyArray<string> = [],
): ScanResult["states"][number] => ({ spec, status, current, reasons });

/** Snapshot every file under dir (relative POSIX path -> content). */
const snapshot = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else out[child] = fs.readFileSync(path.join(dir, child), "utf8");
    }
  };
  walk("");
  return out;
};

/* ------------------------- spec validation ------------------------- */

describe("installer / spec validation", () => {
  it("rejects duplicate ids, path escapes, and marker defects", () => {
    const dup = validateSpec(spec([textAsset(), textAsset({ path: "other.conf" })]));
    expect(dup?.code).toBe("invalid_spec");

    expect(validateSpec(spec([textAsset({ path: "../escape.conf" })]))?.code).toBe("invalid_spec");
    expect(validateSpec(spec([textAsset({ path: "/etc/passwd" })]))?.code).toBe("invalid_spec");

    expect(
      validateSpec(spec([textAsset({ beginMarker: ">>> other >>>", endMarker: "<<< other <<<" })]))
        ?.code,
    ).toBe("invalid_spec");
    expect(validateSpec(spec([textAsset({ endMarker: BEGIN })]))?.code).toBe("invalid_spec");
    expect(validateSpec(spec([jsonAsset({ keyPath: [] })]))?.code).toBe("invalid_spec");

    expect(validateSpec(spec([textAsset(), fileAsset(), jsonAsset()]))).toBeNull();
  });

  it("rejects duplicate target paths and staging-suffix paths", () => {
    const dupPath = validateSpec(
      spec([jsonAsset({ id: "asset-a" }), jsonAsset({ id: "asset-b", keyPath: ["other", "key"] })]),
    );
    expect(dupPath?.code).toBe("invalid_spec");
    expect(dupPath?.message).toContain("asset-a");
    expect(dupPath?.message).toContain("asset-b");
    expect(dupPath?.message).toContain("config/settings.json");

    expect(validateSpec(spec([textAsset({ path: "config/tool.conf.engram-tmp" })]))?.code).toBe(
      "invalid_spec",
    );
  });
});

/* --------------------------- pure planning --------------------------- */

describe("installer / pure planning", () => {
  it("plans exact creation for absent assets, including parent directories", () => {
    const scanned: ScanResult = {
      root: "/root",
      states: [state(textAsset(), "absent", null)],
      leftovers: [],
    };
    const plan = planInstall(scanned);
    expect(plan.actions).toEqual([
      { op: "mkdir", path: "config" },
      {
        op: "write",
        path: "config/tool.conf",
        before: null,
        after: block("managed line 1\nmanaged line 2"),
      },
    ]);
    expect(plan.blocked).toEqual([]);
  });

  it("is a no-op when already installed (idempotency); uninstall removes it", () => {
    const content = block("managed line 1\nmanaged line 2");
    const scanned: ScanResult = {
      root: "/root",
      states: [state(textAsset(), "current", content)],
      leftovers: [],
    };
    expect(planInstall(scanned).actions).toEqual([]);
    expect(planUninstall(scanned).actions).toEqual([
      {
        op: "write",
        path: "config/tool.conf",
        before: content,
        after: "",
      },
    ]);
  });

  it("plans drift repair for text blocks, json values, and markered files", () => {
    const textPlan = planInstall({
      root: "/root",
      states: [state(textAsset(), "drift", `user data\n${block("edited line")}`)],
      leftovers: [],
    });
    expect(textPlan.actions).toEqual([
      { op: "mkdir", path: "config" },
      {
        op: "write",
        path: "config/tool.conf",
        before: `user data\n${block("edited line")}`,
        after: `user data\n${block("managed line 1\nmanaged line 2")}`,
      },
    ]);

    const jsonPlan = planInstall({
      root: "/root",
      states: [
        state(jsonAsset(), "drift", '{"integrations":{"engram":{"enabled":false}},"other":1}'),
      ],
      leftovers: [],
    });
    expect(jsonPlan.actions).toEqual([
      { op: "mkdir", path: "config" },
      {
        op: "write",
        path: "config/settings.json",
        before: '{"integrations":{"engram":{"enabled":false}},"other":1}',
        after:
          '{\n  "integrations": {\n    "engram": {\n      "enabled": true,\n      "level": 2\n    }\n  },\n  "other": 1\n}\n',
      },
    ]);

    const filePlan = planInstall({
      root: "/root",
      states: [
        state(
          fileAsset({ markers: { begin: BEGIN_FILE, end: END_FILE }, content: "owned body" }),
          "drift",
          `${fileBlock("old body")}extra footer\n`,
        ),
      ],
      leftovers: [],
    });
    expect(filePlan.actions).toEqual([
      { op: "mkdir", path: "assets" },
      {
        op: "write",
        path: "assets/skill.md",
        before: `${fileBlock("old body")}extra footer\n`,
        after: fileBlock("owned body"),
      },
    ]);
  });

  it("blocks on foreign unmanaged files without force, overwrites with force", () => {
    const scanned: ScanResult = {
      root: "/root",
      states: [
        state(fileAsset(), "blocked", "the user got here first\n", [
          "unmanaged file exists at target path",
        ]),
      ],
      leftovers: [],
    };
    const blocked = planInstall(scanned);
    expect(blocked.actions).toEqual([]);
    expect(blocked.blocked.map((b) => b.id)).toEqual(["test-file"]);

    expect(planInstall(scanned, { force: true }).actions).toEqual([
      { op: "mkdir", path: "assets" },
      {
        op: "write",
        path: "assets/skill.md",
        before: "the user got here first\n",
        after: "# Owned file\n",
      },
    ]);
  });

  it("blocks on unbalanced markers without force, force-uninstall clears them", () => {
    const scanned: ScanResult = {
      root: "/root",
      states: [
        state(textAsset(), "corrupt", `user data\n${BEGIN}\nlost the end marker\n`, [
          "unbalanced markers",
        ]),
      ],
      leftovers: [],
    };
    const blocked = planInstall(scanned);
    expect(blocked.actions).toEqual([]);
    expect(blocked.blocked.map((b) => b.id)).toEqual(["test-asset"]);

    expect(planUninstall(scanned, { force: true }).actions).toEqual([
      {
        op: "write",
        path: "config/tool.conf",
        before: `user data\n${BEGIN}\nlost the end marker\n`,
        after: "user data\n",
      },
    ]);
  });

  it("uninstall removes only owned content, preserving surroundings", () => {
    const before = `top of file\n${block("managed")}bottom of file`;
    const scanned: ScanResult = {
      root: "/root",
      states: [state(textAsset(), "current", before)],
      leftovers: [],
    };
    expect(planUninstall(scanned).actions).toEqual([
      {
        op: "write",
        path: "config/tool.conf",
        before,
        after: "top of file\nbottom of file",
      },
    ]);
  });

  it("uninstall removes wholly-owned files and owned json keys", () => {
    expect(
      planUninstall({
        root: "/root",
        states: [
          state(
            fileAsset({ markers: { begin: BEGIN_FILE, end: END_FILE }, content: "owned body" }),
            "current",
            fileBlock("owned body"),
          ),
        ],
        leftovers: [],
      }).actions,
    ).toEqual([{ op: "remove", path: "assets/skill.md", before: fileBlock("owned body") }]);

    expect(
      planUninstall({
        root: "/root",
        states: [
          state(
            jsonAsset({ value: { enabled: true } }),
            "current",
            '{\n  "integrations": {\n    "engram": {\n      "enabled": true\n    }\n  },\n  "keep": "me"\n}\n',
          ),
        ],
        leftovers: [],
      }).actions[0],
    ).toEqual({
      op: "write",
      path: "config/settings.json",
      before:
        '{\n  "integrations": {\n    "engram": {\n      "enabled": true\n    }\n  },\n  "keep": "me"\n}\n',
      after: '{\n  "keep": "me"\n}\n',
    });
  });

  it("uninstall is a no-op when assets are absent", () => {
    const scanned: ScanResult = {
      root: "/root",
      states: [state(textAsset(), "absent", null), state(fileAsset(), "absent", null)],
      leftovers: [],
    };
    expect(planUninstall(scanned).actions).toEqual([]);
  });
});

/* ---------------- scan + apply on real temp directories ---------------- */

describe("installer / scan and apply", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-installer-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("preview does not mutate the filesystem; apply matches the preview exactly", async () => {
    fs.mkdirSync(path.join(tmp, "config"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "config", "tool.conf"), "user data\n");
    const s = spec([textAsset(), jsonAsset(), fileAsset()]);

    const scanned = await run(scanAssets(tmp, s));
    const plan = planInstall(scanned);
    const beforeTree = snapshot(tmp);

    // The plan is a pure value: previewing must not touch the disk.
    expect(snapshot(tmp)).toEqual(beforeTree);

    await run(applyPlan(tmp, plan));

    const afterTree = snapshot(tmp);
    const writePaths = plan.actions
      .filter((a) => a.op === "write")
      .map((a) => a.path)
      .sort();
    expect(Object.keys(afterTree).sort()).toEqual(writePaths);
    for (const action of plan.actions) {
      if (action.op === "write") {
        expect(afterTree[action.path]).toBe(action.after);
      }
    }
  });

  it("is byte-stable idempotent: second scan+plan is empty, content unchanged", async () => {
    const s = spec([
      textAsset(),
      fileAsset({ markers: { begin: BEGIN_FILE, end: END_FILE } }),
      jsonAsset(),
    ]);
    const first = await run(scanAssets(tmp, s));
    await run(applyPlan(tmp, planInstall(first)));
    const afterFirst = snapshot(tmp);

    const second = await run(scanAssets(tmp, s));
    expect(second.states.map((a) => a.status)).toEqual(["current", "current", "current"]);
    expect(planInstall(second).actions).toEqual([]);
    expect(planUninstall(second).actions.length).toBe(3);
    expect(snapshot(tmp)).toEqual(afterFirst);
  });

  it("rollback: install then uninstall restores the original tree bytes", async () => {
    fs.mkdirSync(path.join(tmp, "config"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "config", "tool.conf"), "user data\n");
    const original = snapshot(tmp);
    const s = spec([textAsset()]);

    const installed = await run(scanAssets(tmp, s));
    await run(applyPlan(tmp, planInstall(installed)));
    expect(snapshot(tmp)).not.toEqual(original);

    const installedState = await run(scanAssets(tmp, s));
    await run(applyPlan(tmp, planUninstall(installedState)));
    expect(snapshot(tmp)).toEqual(original);
  });

  it("json unknown keys and ordering survive install, update, and uninstall", async () => {
    fs.mkdirSync(path.join(tmp, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "config", "settings.json"),
      '{\n  "zeta": "unknown setting",\n  "alpha": 1\n}\n',
    );
    const s = spec([jsonAsset()]);

    const installed = await run(scanAssets(tmp, s));
    await run(applyPlan(tmp, planInstall(installed)));
    const afterInstall = fs.readFileSync(path.join(tmp, "config", "settings.json"), "utf8");
    const doc = JSON.parse(afterInstall);
    expect(doc.zeta).toBe("unknown setting");
    expect(doc.alpha).toBe(1);
    expect(doc.integrations.engram).toEqual({ enabled: true, level: 2 });
    expect(Object.keys(doc)).toEqual(["zeta", "alpha", "integrations"]);

    // drift: rewrite the owned value; unknown keys must still survive
    fs.writeFileSync(
      path.join(tmp, "config", "settings.json"),
      afterInstall.replace('"level": 2', '"level": 9'),
    );
    const drifted = await run(scanAssets(tmp, s));
    expect(drifted.states[0]?.status).toBe("drift");
    await run(applyPlan(tmp, planInstall(drifted)));
    const afterUpdate = JSON.parse(
      fs.readFileSync(path.join(tmp, "config", "settings.json"), "utf8"),
    );
    expect(afterUpdate.zeta).toBe("unknown setting");
    expect(afterUpdate.integrations.engram).toEqual({ enabled: true, level: 2 });

    // uninstall: owned key gone, unknown keys intact
    const current = await run(scanAssets(tmp, s));
    await run(applyPlan(tmp, planUninstall(current)));
    const afterUninstall = JSON.parse(
      fs.readFileSync(path.join(tmp, "config", "settings.json"), "utf8"),
    );
    expect(afterUninstall.zeta).toBe("unknown setting");
    expect(afterUninstall.alpha).toBe(1);
    expect(afterUninstall.integrations).toBeUndefined();
  });

  it("preserves text surrounding content byte-for-byte across install, update, uninstall", async () => {
    fs.mkdirSync(path.join(tmp, "config"), { recursive: true });
    const original = "# Header\n\nuser notes with   spacing\n\n# Footer\n";
    fs.writeFileSync(path.join(tmp, "config", "tool.conf"), original);
    const s = spec([textAsset()]);

    const installed = await run(scanAssets(tmp, s));
    await run(applyPlan(tmp, planInstall(installed)));
    const withBlock = fs.readFileSync(path.join(tmp, "config", "tool.conf"), "utf8");
    expect(withBlock).toContain("# Header");
    expect(withBlock).toContain("user notes with   spacing");
    expect(withBlock.endsWith(`${END}\n`)).toBe(true);

    // reinstall over the block: surroundings must not move
    const reinstalled = await run(scanAssets(tmp, s));
    expect(reinstalled.states[0]?.status).toBe("current");
    await run(applyPlan(tmp, planInstall(reinstalled)));
    const afterReinstall = fs.readFileSync(path.join(tmp, "config", "tool.conf"), "utf8");
    expect(afterReinstall.startsWith("# Header\n\n")).toBe(true);
    expect(afterReinstall).toContain("# Footer");
    expect(afterReinstall.endsWith("managed line 2\n" + END + "\n")).toBe(true);

    const current = await run(scanAssets(tmp, s));
    await run(applyPlan(tmp, planUninstall(current)));
    expect(fs.readFileSync(path.join(tmp, "config", "tool.conf"), "utf8")).toBe(original);
  });

  it("detects drift from edited managed content and repairs it in place", async () => {
    fs.mkdirSync(path.join(tmp, "config"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "config", "tool.conf"), `user data\n${block("tampered")}`);
    const s = spec([textAsset()]);

    const drifted = await run(scanAssets(tmp, s));
    expect(drifted.states[0]?.status).toBe("drift");
    await run(applyPlan(tmp, planInstall(drifted)));
    expect(fs.readFileSync(path.join(tmp, "config", "tool.conf"), "utf8")).toBe(
      `user data\n${block("managed line 1\nmanaged line 2")}`,
    );
  });

  it("reports stale temp files as leftovers with actionable relative paths", async () => {
    fs.mkdirSync(path.join(tmp, "config"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "config", "tool.conf.engram-tmp"), "half written");
    const scanned = await run(scanAssets(tmp, spec([textAsset()])));
    expect(scanned.leftovers).toEqual(["config/tool.conf.engram-tmp"]);
  });

  it("interrupted apply: nothing partial on disk, leftover diagnosed, rerun recovers", async () => {
    fs.mkdirSync(path.join(tmp, "config"), { recursive: true });
    const s = spec([textAsset(), jsonAsset()]);
    const scanned = await run(scanAssets(tmp, s));
    const plan = planInstall(scanned);

    // Fake FileSystem whose atomic publish step (rename) always fails.
    const renames: Array<[string, string]> = [];
    let renameCalls = 0;
    const failingFs = {
      makeDirectory: (_path: string, _options?: { recursive?: boolean }) => Effect.void,
      writeFileString: (_path: string, _data: string) => Effect.void,
      rename: (oldPath: string, newPath: string) => {
        renameCalls += 1;
        renames.push([oldPath, newPath] as [string, string]);
        return Effect.fail(
          new InstallerError({ code: "io", path: newPath, message: "simulated interruption" }),
        );
      },
      remove: (_path: string, _options?: { recursive?: boolean; force?: boolean }) => Effect.void,
    } as unknown as FileSystem;
    const InterruptedLive = Layer.merge(Layer.succeed(FileSystem, failingFs), pathLayer);

    const exit = await runExit(Effect.provide(applyPlan(tmp, plan), InterruptedLive));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      if (Option.isSome(error)) {
        expect(error.value).toBeInstanceOf(InstallerError);
        expect(error.value.code).toBe("io");
        expect(error.value.message).toContain("simulated interruption");
        // actionable diagnostics: what finished, what the rerun must redo
        expect(error.value.completed).toEqual(["config"]);
        expect(error.value.pending).toEqual(["config/tool.conf", "config/settings.json"]);
      } else {
        const squashed = Cause.squash(exit.cause);
        throw new Error(`expected a failed InstallerError, got a defect: ${String(squashed)}`);
      }
    }
    expect(renameCalls).toBe(1);

    // Nothing was published: the target file must not exist on disk (rename
    // is the only step that creates it), so no partial content is possible.
    expect(fs.existsSync(path.join(tmp, "config", "tool.conf"))).toBe(false);

    // A healthy rerun completes the install.
    const rescanned = await run(scanAssets(tmp, s));
    expect(rescanned.states.map((a) => a.status)).toEqual(["absent", "absent"]);
    await run(applyPlan(tmp, planInstall(rescanned)));
    const final = await run(scanAssets(tmp, s));
    expect(final.states.map((a) => a.status)).toEqual(["current", "current"]);
    void renames;
  });
});
