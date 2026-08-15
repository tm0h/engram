import { describe, it, expect, beforeEach, afterEach } from "@effect/vitest";
import { Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findProjectRoot, findGitRoot } from "../src/location.js";
import { projectConfigPath } from "../src/paths.js";

const withFsPath = <A, E>(
  f: (fs: FileSystem, path: Path) => Effect.Effect<A, E>,
): Effect.Effect<A, E, FileSystem | Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    return yield* f(fs, path);
  });

describe("findProjectRoot", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loc-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("walks up to the dir containing .engram/config.json", async () => {
    const root = path.join(tmp, "proj");
    const nested = path.join(root, "apps", "web");
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(root, ".engram"), { recursive: true });
    fs.writeFileSync(projectConfigPath(root), "{}");

    const result = await withFsPath((fs, path) => findProjectRoot(fs, path, nested)).pipe(
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    );
    expect(result).toBe(root);
  });

  it("returns null when no project is initialized", async () => {
    const result = await withFsPath((fs, path) => findProjectRoot(fs, path, tmp)).pipe(
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    );
    expect(result).toBeNull();
  });
});

describe("findGitRoot", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("finds the nearest .git directory", async () => {
    const root = path.join(tmp, "repo");
    const nested = path.join(root, "a", "b");
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const result = await withFsPath((fs, path) => findGitRoot(fs, path, nested)).pipe(
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    );
    expect(result).toBe(root);
  });

  it("returns null when there is no git repo", async () => {
    const result = await withFsPath((fs, path) => findGitRoot(fs, path, tmp)).pipe(
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    );
    expect(result).toBeNull();
  });
});
