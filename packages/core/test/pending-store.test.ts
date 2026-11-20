import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { Path } from "effect/Path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import { enqueuePendingCandidate, readPendingCandidate } from "../src/pending-store.js";

test("pending files must match their version, scope, and filename", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-pending-"));
  const run = <A, E>(effect: Effect.Effect<A, E, FileSystem | Path>) =>
    Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

  try {
    await mkdir(path.join(root, ".engram"));
    await writeFile(path.join(root, ".engram", "config.json"), "{}");
    const candidate = await run(
      enqueuePendingCandidate(
        {
          scope: "project",
          proposed: { title: "Synthetic decision", type: "decision", tags: [], body: "Use blue." },
          sourceExcerpt: "Blue was selected.",
          provenanceClass: "conversation",
          duplicates: [],
          conflicts: [],
        },
        root,
      ),
    );
    const file = path.join(root, ".engram", "pending", candidate.id + ".json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(candidate);
    expect(await run(readPendingCandidate("project", candidate.id, root))).toEqual(candidate);

    for (const invalid of [
      { ...candidate, schemaVersion: 2 },
      { ...candidate, schemaVersion: undefined },
      { ...candidate, scope: "personal" },
      { ...candidate, id: "0000" },
      { ...candidate, proposed: { ...candidate.proposed, extra: true } },
      { ...candidate, created: "yesterday" },
    ]) {
      await writeFile(file, JSON.stringify(invalid));
      await expect(run(readPendingCandidate("project", candidate.id, root))).rejects.toThrow(
        "Invalid pending candidate",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
