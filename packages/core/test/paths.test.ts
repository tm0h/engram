import { describe, it, expect } from "vite-plus/test";
import os from "node:os";
import path from "node:path";
import {
  globalRoot,
  globalEngramsDir,
  globalConfigPath,
  projectDir,
  projectEngramsDir,
  projectConfigPath,
  projectReadmePath,
  gitignorePath,
} from "../src/paths.js";

describe("global scope paths", () => {
  it("lives under ~/.engram", () => {
    expect(globalRoot()).toBe(path.join(os.homedir(), ".engram"));
    expect(globalEngramsDir()).toBe(path.join(os.homedir(), ".engram", "engrams"));
    expect(globalConfigPath()).toBe(path.join(os.homedir(), ".engram", "config.json"));
  });
});

describe("project scope paths", () => {
  const root = "/tmp/repo";
  it("lives under <repo>/.engram", () => {
    expect(projectDir(root)).toBe(path.join(root, ".engram"));
    expect(projectEngramsDir(root)).toBe(path.join(root, ".engram", "engrams"));
    expect(projectConfigPath(root)).toBe(path.join(root, ".engram", "config.json"));
    expect(projectReadmePath(root)).toBe(path.join(root, ".engram", "README.md"));
  });
  it("gitignore is at the git root", () => {
    expect(gitignorePath(root)).toBe(path.join(root, ".gitignore"));
  });
});
