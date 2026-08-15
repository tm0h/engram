/**
 * Pure path-string builders (no I/O). These only do path math; anything that
 * needs to check existence lives in `location.ts` as an Effect.
 */
import os from "node:os";
import path from "node:path";

/* ---------------- personal (global) scope: ~/.engram/ ---------------- */

export const globalRoot = (): string => path.join(os.homedir(), ".engram");
export const globalEngramsDir = (): string => path.join(globalRoot(), "engrams");
export const globalConfigPath = (): string => path.join(globalRoot(), "config.json");

/* ----------------------- project scope: <repo>/.engram/ --------------------- */

export const projectDir = (root: string): string => path.join(root, ".engram");
export const projectEngramsDir = (root: string): string => path.join(root, ".engram", "engrams");
export const projectConfigPath = (root: string): string =>
  path.join(root, ".engram", "config.json");
export const projectReadmePath = (root: string): string => path.join(root, ".engram", "README.md");
export const gitignorePath = (gitRoot: string): string => path.join(gitRoot, ".gitignore");
