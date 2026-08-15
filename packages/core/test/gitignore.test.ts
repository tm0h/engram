import { describe, it, expect, beforeEach, afterEach } from "@effect/vitest";
import { Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import { FileSystem } from "effect/FileSystem";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureGitignoreLine, removeGitignoreLine } from "../src/gitignore.js";

const withFs = <A, E>(
  f: (fs: FileSystem) => Effect.Effect<A, E>,
): Effect.Effect<A, E, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    return yield* f(fs);
  });

describe("gitignore helpers", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gi-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const readGi = () => {
    const f = path.join(tmp, ".gitignore");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  };

  it("appends a line to a new .gitignore", async () => {
    await withFs((fs) => ensureGitignoreLine(fs, tmp, ".engram/")).pipe(
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    );
    expect(readGi().split("\n")).toContain(".engram/");
  });

  it("is idempotent (does not duplicate)", async () => {
    await withFs((fs) => ensureGitignoreLine(fs, tmp, ".engram/")).pipe(
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    );
    await withFs((fs) => ensureGitignoreLine(fs, tmp, ".engram/")).pipe(
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    );
    const occurrences = readGi().match(/\.engram\//g)?.length ?? 0;
    expect(occurrences).toBe(1);
  });

  it("removes a line", async () => {
    await withFs((fs) => ensureGitignoreLine(fs, tmp, ".engram/")).pipe(
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    );
    await withFs((fs) => removeGitignoreLine(fs, tmp, ".engram/")).pipe(
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    );
    expect(readGi().includes(".engram/")).toBe(false);
  });

  it("preserves existing content", async () => {
    fs.writeFileSync(path.join(tmp, ".gitignore"), "node_modules/\n");
    await withFs((fs) => ensureGitignoreLine(fs, tmp, ".engram/")).pipe(
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    );
    const lines = readGi().split("\n");
    expect(lines).toContain("node_modules/");
    expect(lines).toContain(".engram/");
  });
});
