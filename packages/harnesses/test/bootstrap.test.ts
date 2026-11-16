import { it, expect } from "vite-plus/test";
import { bootstrapCandidates } from "../src/shared/bootstrap.js";
import type { Engram } from "@engram/core";
const now = Date.parse("2026-11-16T12:00:00Z");
const entry = (id: string, extra: Partial<Engram> = {}): Engram => ({
  id,
  title: "Entry",
  type: "note",
  tags: [],
  aliases: [],
  body: "",
  scope: "project",
  path: "",
  author: undefined,
  pinned: false,
  schemaVersion: 1,
  created: "2025-01-01T00:00:00Z",
  updated: "2025-01-01T00:00:00Z",
  ...extra,
});
it("selects pinned memories, important decisions and critical preferences in stable priority", () => {
  const list = [
    entry("old", { type: "decision", importance: 3 }),
    entry("new", { type: "decision", importance: 5, updated: new Date(now).toISOString() }),
    entry("pref", { type: "preference", importance: 4 }),
    entry("pin", { pinned: true }),
    entry("note"),
    entry("scoped", { pinned: true, appliesTo: ["src/**"] }),
    entry("dead", { pinned: true, status: "archived" }),
  ];
  const options = { now, includeInactive: false, includeScoped: false };
  const selected = bootstrapCandidates(list, options);
  expect(selected.candidates.map((c) => c.entry.id)).toEqual(["pin", "new", "pref", "old"]);
  expect(selected.excluded).toEqual({ inactive: 1, scoped: 1, uncurated: 1 });
  expect(bootstrapCandidates([...list].reverse(), options)).toEqual(selected);
  expect(
    bootstrapCandidates(list, { ...options, includeInactive: true, includeScoped: true })
      .candidates,
  ).toHaveLength(6);
});
