import { describe, expect, it } from "vite-plus/test";
import type { Engram, Scope } from "../src/domain.js";
import type { DuplicateIdClaim, StoreDiagnostic, StoreScan } from "../src/integrity.js";
import {
  computeLinkAdjacency,
  type LinkAdjacency,
  type LinkTargetResolution,
} from "../src/links.js";

/* ENG-43: read-time link adjacency over one completed StoreScan. These tests
 * pin the pure contract before any implementation exists (TDD): exact ids
 * only, duplicate claims win over valid entries, authored outgoing order,
 * created-then-id backlinks, one graph per scan, and total structured
 * results that never throw. */

/** New-format ids: 26 lowercase Crockford-base32 chars (timestamp + randomness). */
const ULID26 = "01j2k3n4p5q6r7s8t9v0w1x2z";

const mem = (over: Partial<Engram> & { id: string; title: string }): Engram => ({
  type: "note",
  tags: [],
  scope: "project",
  created: "2025-08-15T10:00:00.000Z",
  updated: "2025-08-15T10:00:00.000Z",
  author: undefined,
  pinned: false,
  schemaVersion: 1,
  aliases: [],
  body: "",
  path: "",
  ...over,
});

const claim = (id: string, files: string[]): DuplicateIdClaim => ({ id, files });

const diag = (file: string): StoreDiagnostic => ({
  code: "frontmatter_missing",
  severity: "error",
  scope: "project",
  file,
  message: "no frontmatter",
  hint: "add frontmatter",
});

const scan = (over: {
  scope?: Scope;
  entries?: ReadonlyArray<Engram>;
  duplicateIds?: ReadonlyArray<DuplicateIdClaim>;
  diagnostics?: ReadonlyArray<StoreDiagnostic>;
  omittedFiles?: number;
}): StoreScan => ({
  scope: over.scope ?? "project",
  directory: "/store/project",
  filesChecked: over.entries?.length ?? 0,
  entries: over.entries ?? [],
  diagnostics: over.diagnostics ?? [],
  duplicateIds: over.duplicateIds ?? [],
  omittedFiles: over.omittedFiles ?? 0,
});

const foundIds = (resolutions: ReadonlyArray<LinkTargetResolution>): string[] =>
  resolutions.filter((r) => r.status === "found").map((r) => r.id);

describe("computeLinkAdjacency (ENG-43)", () => {
  /* ---------------- step 1: result union and empty scans ---------------- */

  it("exposes the documented public result types", () => {
    const result: LinkAdjacency = computeLinkAdjacency(scan({}), "0001");
    const target: LinkTargetResolution = result.target;
    expect(target.status).toBe("missing");
    if (target.status === "found") {
      // the found variant carries the resolved entry
      expect(target.entry.id).toBe(target.id);
    }
    if (target.status === "ambiguous") {
      expect(target.claimants.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("resolves any target over an empty scan as missing with empty collections", () => {
    expect(computeLinkAdjacency(scan({}), "0001")).toEqual({
      target: { status: "missing", id: "0001" },
      outgoing: [],
      incoming: [],
    });
  });

  it("returns deeply equal results for repeated calls over the same scan", () => {
    const s = scan({ entries: [mem({ id: "0001", title: "A" })] });
    expect(computeLinkAdjacency(s, "0001")).toEqual(computeLinkAdjacency(s, "0001"));
  });

  it("never mutates the scan it consumes", () => {
    const s = scan({ entries: [mem({ id: "0001", title: "A", related: ["0002"] })] });
    const before = JSON.stringify(s);
    computeLinkAdjacency(s, "0001");
    expect(JSON.stringify(s)).toBe(before);
  });

  /* ---------------- step 2: exact resolution ---------------- */

  it("resolves a found legacy four-digit id", () => {
    const entry = mem({ id: "0042", title: "Legacy" });
    expect(computeLinkAdjacency(scan({ entries: [entry] }), "0042").target).toEqual({
      status: "found",
      id: "0042",
      entry,
    });
  });

  it("resolves a found 26-character new-format id", () => {
    const entry = mem({ id: ULID26, title: "New format" });
    expect(computeLinkAdjacency(scan({ entries: [entry] }), ULID26).target).toEqual({
      status: "found",
      id: ULID26,
      entry,
    });
  });

  it("keeps a strict prefix of a found id missing (no prefix resolution)", () => {
    const s = scan({
      entries: [mem({ id: "0042", title: "Legacy" }), mem({ id: ULID26, title: "New" })],
    });
    expect(computeLinkAdjacency(s, "004").target.status).toBe("missing");
    expect(computeLinkAdjacency(s, ULID26.slice(0, 10)).target.status).toBe("missing");
  });

  it("keeps a longer non-match missing", () => {
    const s = scan({ entries: [mem({ id: "0042", title: "Legacy" })] });
    expect(computeLinkAdjacency(s, "00421").target.status).toBe("missing");
    expect(computeLinkAdjacency(s, `${ULID26}x`).target.status).toBe("missing");
  });

  it("resolves a strict prefix of a duplicate-claimed id as missing, not ambiguous", () => {
    const s = scan({
      duplicateIds: [claim("0099aa", ["/store/project/a.md", "/store/project/b.md"])],
    });
    expect(computeLinkAdjacency(s, "0099").target).toEqual({ status: "missing", id: "0099" });
  });

  it("resolves a duplicate claim with zero valid claimants as ambiguous", () => {
    const s = scan({
      duplicateIds: [claim("d0", ["/store/project/a.md", "/store/project/b.md"])],
    });
    expect(computeLinkAdjacency(s, "d0").target).toEqual({
      status: "ambiguous",
      id: "d0",
      claimants: ["/store/project/a.md", "/store/project/b.md"],
    });
  });

  it("resolves a duplicate claim with one valid claimant as ambiguous, never found", () => {
    const valid = mem({ id: "d1", title: "Only valid claimant", path: "/store/project/a.md" });
    const s = scan({
      entries: [valid],
      duplicateIds: [claim("d1", ["/store/project/a.md", "/store/project/b.md"])],
    });
    expect(computeLinkAdjacency(s, "d1").target).toEqual({
      status: "ambiguous",
      id: "d1",
      claimants: ["/store/project/a.md", "/store/project/b.md"],
    });
  });

  it("resolves a duplicate claim with multiple valid claimants as ambiguous", () => {
    const first = mem({ id: "d2", title: "First claimant", path: "/store/project/a.md" });
    const second = mem({ id: "d2", title: "Second claimant", path: "/store/project/b.md" });
    const s = scan({
      entries: [first, second],
      duplicateIds: [claim("d2", ["/store/project/a.md", "/store/project/b.md"])],
    });
    expect(computeLinkAdjacency(s, "d2").target).toEqual({
      status: "ambiguous",
      id: "d2",
      claimants: ["/store/project/a.md", "/store/project/b.md"],
    });
  });

  it("reports ambiguous claimant paths exactly as the scan provides them (sorted)", () => {
    const files = ["/store/project/a.md", "/store/project/b.md", "/store/project/c.md"];
    const s = scan({ duplicateIds: [claim("d3", files)] });
    const target = computeLinkAdjacency(s, "d3").target;
    expect(target.status).toBe("ambiguous");
    if (target.status === "ambiguous") expect(target.claimants).toEqual(files);
  });

  /* ---------------- step 3: outgoing adjacency ---------------- */

  it("yields no outgoing adjacency when the found target has no related field", () => {
    const s = scan({ entries: [mem({ id: "0001", title: "A" })] });
    expect(computeLinkAdjacency(s, "0001").outgoing).toEqual([]);
  });

  it("yields no outgoing adjacency for an explicitly empty related list", () => {
    const s = scan({ entries: [mem({ id: "0001", title: "A", related: [] })] });
    expect(computeLinkAdjacency(s, "0001").outgoing).toEqual([]);
  });

  it("resolves one related target as found", () => {
    const a = mem({ id: "0001", title: "A", related: ["0002"] });
    const b = mem({ id: "0002", title: "B" });
    const outgoing = computeLinkAdjacency(scan({ entries: [a, b] }), "0001").outgoing;
    expect(outgoing).toEqual([{ status: "found", id: "0002", entry: b }]);
  });

  it("preserves authored related order over several targets", () => {
    // Chronological entry order differs from the authored order on purpose:
    // the authored list, not the scan's entry order, drives outgoing order.
    const a = mem({ id: "0001", title: "A", related: ["0002", "0003", "0004"] });
    const c = mem({ id: "0003", title: "C", created: "2025-08-15T09:00:00.000Z" });
    const b = mem({ id: "0002", title: "B", created: "2025-08-15T09:30:00.000Z" });
    const d = mem({ id: "0004", title: "D", created: "2025-08-15T11:00:00.000Z" });
    const outgoing = computeLinkAdjacency(scan({ entries: [c, b, a, d] }), "0001").outgoing;
    expect(foundIds(outgoing)).toEqual(["0002", "0003", "0004"]);
  });

  it("keeps a dangling related id missing in place", () => {
    const a = mem({ id: "0001", title: "A", related: ["0002", "zzzz"] });
    const b = mem({ id: "0002", title: "B" });
    const outgoing = computeLinkAdjacency(scan({ entries: [a, b] }), "0001").outgoing;
    expect(outgoing).toEqual([
      { status: "found", id: "0002", entry: b },
      { status: "missing", id: "zzzz" },
    ]);
  });

  it("keeps a duplicate-claimed related id ambiguous in place", () => {
    const a = mem({ id: "0001", title: "A", related: ["d1"] });
    const valid = mem({ id: "d1", title: "Claimant", path: "/store/project/a.md" });
    const s = scan({
      entries: [a, valid],
      duplicateIds: [claim("d1", ["/store/project/a.md", "/store/project/b.md"])],
    });
    expect(computeLinkAdjacency(s, "0001").outgoing).toEqual([
      {
        status: "ambiguous",
        id: "d1",
        claimants: ["/store/project/a.md", "/store/project/b.md"],
      },
    ]);
  });

  it("preserves authored order across a mix of found, missing, and ambiguous slots", () => {
    const a = mem({ id: "0001", title: "A", related: ["0002", "zzzz", "d1", "0003"] });
    const b = mem({ id: "0002", title: "B" });
    const c = mem({ id: "0003", title: "C" });
    const s = scan({
      entries: [a, b, c],
      duplicateIds: [claim("d1", ["/store/project/x.md", "/store/project/y.md"])],
    });
    const outgoing = computeLinkAdjacency(s, "0001").outgoing;
    expect(outgoing.map((r) => r.status)).toEqual(["found", "missing", "ambiguous", "found"]);
    expect(foundIds(outgoing)).toEqual(["0002", "0003"]);
  });

  it("leaks no prefix inside related in either direction", () => {
    const short = mem({ id: "0001", title: "Short id" });
    const long = mem({ id: "00012", title: "Longer id" });
    const prefixSource = mem({ id: "0010", title: "Prefix source", related: ["000"] });
    const exactSource = mem({ id: "0011", title: "Exact source", related: ["0001"] });
    const longSource = mem({ id: "0012", title: "Long source", related: ["00012"] });
    const s = scan({ entries: [short, long, prefixSource, exactSource, longSource] });

    // "000" is a strict prefix of "0001": it must not resolve to it.
    expect(computeLinkAdjacency(s, "0010").outgoing).toEqual([{ status: "missing", id: "000" }]);
    // "0001" must resolve to the entry with exactly that id, not "00012".
    expect(foundIds(computeLinkAdjacency(s, "0011").outgoing)).toEqual(["0001"]);
    expect(foundIds(computeLinkAdjacency(s, "0012").outgoing)).toEqual(["00012"]);
  });

  /* ---------------- step 4: incoming backlinks ---------------- */

  it("yields no incoming backlinks when nothing references the target", () => {
    const s = scan({ entries: [mem({ id: "0001", title: "A" }), mem({ id: "0002", title: "B" })] });
    expect(computeLinkAdjacency(s, "0001").incoming).toEqual([]);
  });

  it("returns one referrer with its full entry", () => {
    const target = mem({ id: "0002", title: "Target" });
    const referrer = mem({ id: "0001", title: "Referrer", related: ["0002"] });
    expect(computeLinkAdjacency(scan({ entries: [referrer, target] }), "0002").incoming).toEqual([
      referrer,
    ]);
  });

  it("resolves both directions over the same scan without inferring anything", () => {
    const a = mem({ id: "0001", title: "A", related: ["0002"] });
    const b = mem({ id: "0002", title: "B", related: ["0001"] });
    const s = scan({ entries: [a, b] });
    expect(computeLinkAdjacency(s, "0002")).toEqual({
      target: { status: "found", id: "0002", entry: b },
      outgoing: [{ status: "found", id: "0001", entry: a }],
      incoming: [a],
    });
  });

  it("reports a synthetic self-link deterministically and filters nothing", () => {
    const self = mem({ id: "0500", title: "Self", related: ["0500"] });
    expect(computeLinkAdjacency(scan({ entries: [self] }), "0500")).toEqual({
      target: { status: "found", id: "0500", entry: self },
      outgoing: [{ status: "found", id: "0500", entry: self }],
      incoming: [self],
    });
  });

  it("returns every referrer when several entries point at the target", () => {
    const target = mem({ id: "0009", title: "Target" });
    const b = mem({
      id: "0001",
      title: "B",
      created: "2025-08-15T09:00:00.000Z",
      related: ["0009"],
    });
    const c = mem({
      id: "0002",
      title: "C",
      created: "2025-08-15T10:00:00.000Z",
      related: ["0009"],
    });
    const d = mem({
      id: "0003",
      title: "D",
      created: "2025-08-15T11:00:00.000Z",
      related: ["0009"],
    });
    expect(
      computeLinkAdjacency(scan({ entries: [d, target, b, c] }), "0009").incoming.map((m) => m.id),
    ).toEqual(["0001", "0002", "0003"]);
  });

  it("tie-breaks equal creation timestamps by id", () => {
    const target = mem({ id: "0009", title: "Target" });
    const laterId = mem({ id: "0005", title: "Later id", related: ["0009"] });
    const earlierId = mem({ id: "0003", title: "Earlier id", related: ["0009"] });
    // Input order is reversed relative to the expected id tie-break.
    const incoming = computeLinkAdjacency(
      scan({ entries: [target, laterId, earlierId] }),
      "0009",
    ).incoming;
    expect(incoming.map((m) => m.id)).toEqual(["0003", "0005"]);
  });

  it("sorts backlinks chronologically regardless of scan entry order", () => {
    const target = mem({ id: "0009", title: "Target" });
    const first = mem({
      id: "0001",
      title: "First",
      created: "2025-08-15T08:00:00.000Z",
      related: ["0009"],
    });
    const second = mem({
      id: "0002",
      title: "Second",
      created: "2025-08-15T09:00:00.000Z",
      related: ["0009"],
    });
    const third = mem({
      id: "0003",
      title: "Third",
      created: "2025-08-15T10:00:00.000Z",
      related: ["0009"],
    });
    const incoming = computeLinkAdjacency(
      scan({ entries: [third, second, first, target] }),
      "0009",
    ).incoming;
    expect(incoming.map((m) => m.id)).toEqual(["0001", "0002", "0003"]);
  });

  it("matches complete strings only around neighboring unrelated ids", () => {
    const target = mem({ id: "0050", title: "Target" });
    const neighbor = mem({ id: "00501", title: "Neighbor" });
    // References "00501" only: it is not a referrer of "0050".
    const nearMiss = mem({ id: "0010", title: "Near miss", related: ["00501"] });
    expect(
      computeLinkAdjacency(scan({ entries: [target, neighbor, nearMiss] }), "0050").incoming,
    ).toEqual([]);
  });

  it("counts a source once when its related list names unrelated ids around the target", () => {
    const target = mem({ id: "0050", title: "Target" });
    const before = mem({ id: "0011", title: "Before" });
    const after = mem({ id: "0012", title: "After" });
    const source = mem({ id: "0010", title: "Source", related: ["0011", "0050", "0012"] });
    const incoming = computeLinkAdjacency(
      scan({ entries: [before, source, target, after] }),
      "0050",
    ).incoming;
    expect(incoming).toEqual([source]);
  });

  it("keeps both valid claimants when a duplicated referrer id references the target", () => {
    const target = mem({ id: "0009", title: "Target" });
    const claimantA = mem({
      id: "0007",
      title: "Claimant A",
      created: "2025-08-15T09:00:00.000Z",
      path: "/store/project/a.md",
      related: ["0009"],
    });
    const claimantB = mem({
      id: "0007",
      title: "Claimant B",
      created: "2025-08-15T10:00:00.000Z",
      path: "/store/project/b.md",
      related: ["0009"],
    });
    const s = scan({
      entries: [target, claimantB, claimantA],
      duplicateIds: [claim("0007", ["/store/project/a.md", "/store/project/b.md"])],
    });
    // Referrers are never filtered through duplicateIds: each valid claimant
    // entry that references the target appears, one each.
    expect(computeLinkAdjacency(s, "0009").incoming).toEqual([claimantA, claimantB]);
  });

  it("counts a source once even when a synthetic related list repeats the target", () => {
    const target = mem({ id: "0050", title: "Target" });
    const source = mem({ id: "0010", title: "Source", related: ["0050", "0050"] });
    expect(computeLinkAdjacency(scan({ entries: [source, target] }), "0050").incoming).toEqual([
      source,
    ]);
  });

  /* ---------------- step 5: scope isolation ---------------- */

  it("resolves colliding ids within the queried scan only", () => {
    const projectTarget = mem({ id: "0100", title: "Project target" });
    const projectReferrer = mem({ id: "0101", title: "Project referrer", related: ["0100"] });
    const personalTarget = mem({
      id: "0100",
      title: "Personal target",
      scope: "personal",
      path: "/home/x/.engram/engrams/0100.md",
    });
    const personalReferrer = mem({
      id: "0102",
      title: "Personal referrer",
      scope: "personal",
      related: ["0100"],
    });
    const projectScan = scan({ scope: "project", entries: [projectTarget, projectReferrer] });
    const personalScan = scan({ scope: "personal", entries: [personalTarget, personalReferrer] });

    const projectResult = computeLinkAdjacency(projectScan, "0100");
    expect(projectResult.target).toEqual({
      status: "found",
      id: "0100",
      entry: projectTarget,
    });
    expect(projectResult.incoming.map((m) => m.id)).toEqual(["0101"]);

    const personalResult = computeLinkAdjacency(personalScan, "0100");
    expect(personalResult.target).toEqual({
      status: "found",
      id: "0100",
      entry: personalTarget,
    });
    expect(personalResult.incoming.map((m) => m.id)).toEqual(["0102"]);
  });

  it("keeps an id present only in the other scope missing", () => {
    const personalOnly = scan({
      scope: "personal",
      entries: [mem({ id: "0200", title: "Personal only", scope: "personal" })],
    });
    const result = computeLinkAdjacency(scan({ scope: "project" }), "0200");
    expect(result).toEqual({
      target: { status: "missing", id: "0200" },
      outgoing: [],
      incoming: [],
    });
    // The same id resolves in the scope that actually holds it.
    expect(computeLinkAdjacency(personalOnly, "0200").target.status).toBe("found");
  });

  /* ---------------- step 6: damaged scans ---------------- */

  it("returns incoming dangling references for a missing requested target", () => {
    const referrer = mem({ id: "0001", title: "Referrer", related: ["zzzz"] });
    const result = computeLinkAdjacency(scan({ entries: [referrer] }), "zzzz");
    expect(result).toEqual({
      target: { status: "missing", id: "zzzz" },
      outgoing: [],
      incoming: [referrer],
    });
  });

  it("returns incoming references for an ambiguous requested target", () => {
    const validClaimant = mem({ id: "d1", title: "Claimant", path: "/store/project/a.md" });
    const referrer = mem({ id: "0001", title: "Referrer", related: ["d1"] });
    const s = scan({
      entries: [validClaimant, referrer],
      duplicateIds: [claim("d1", ["/store/project/a.md", "/store/project/b.md"])],
    });
    const result = computeLinkAdjacency(s, "d1");
    expect(result.target).toEqual({
      status: "ambiguous",
      id: "d1",
      claimants: ["/store/project/a.md", "/store/project/b.md"],
    });
    expect(result.outgoing).toEqual([]);
    expect(result.incoming).toEqual([referrer]);
  });

  it("resolves a target represented only by invalid claimant files as ambiguous", () => {
    const referrer = mem({ id: "0001", title: "Referrer", related: ["d9"] });
    const s = scan({
      entries: [referrer],
      duplicateIds: [claim("d9", ["/store/project/bad-1.md", "/store/project/bad-2.md"])],
      omittedFiles: 2,
    });
    const result = computeLinkAdjacency(s, "d9");
    expect(result.target).toEqual({
      status: "ambiguous",
      id: "d9",
      claimants: ["/store/project/bad-1.md", "/store/project/bad-2.md"],
    });
    expect(result.outgoing).toEqual([]);
    expect(result.incoming).toEqual([referrer]);
  });

  it("does not let diagnostics or omitted files change the adjacency result", () => {
    const entries = [
      mem({ id: "0001", title: "A", related: ["0002"] }),
      mem({ id: "0002", title: "B" }),
    ];
    const clean = scan({ entries });
    const damaged = scan({
      entries,
      diagnostics: [diag("/store/project/broken.md")],
      omittedFiles: 1,
    });
    expect(computeLinkAdjacency(damaged, "0001")).toEqual(computeLinkAdjacency(clean, "0001"));
    expect(computeLinkAdjacency(damaged, "0002")).toEqual(computeLinkAdjacency(clean, "0002"));
  });
});

/* ENG-45 R2 (deferred MINOR from 20261002-eng43): a pathological hand-rolled
 * scan may list the same id as two separate DuplicateIdClaim objects. The
 * claim map must keep the FIRST claim (the old `find` semantics, and the same
 * first-wins rule `entryById` uses), not let Map construction keep the last. */
describe("claimById first-claim guard (ENG-45 R2)", () => {
  it("keeps the first claim when a scan lists the same duplicate id twice", () => {
    const first = claim("dup1", ["/store/project/a.md", "/store/project/b.md"]);
    const second = claim("dup1", ["/store/project/c.md"]);
    const result = computeLinkAdjacency(scan({ duplicateIds: [first, second] }), "dup1");
    expect(result.target).toEqual({
      status: "ambiguous",
      id: "dup1",
      claimants: ["/store/project/a.md", "/store/project/b.md"],
    });
  });

  it("still resolves a single claim unchanged", () => {
    const result = computeLinkAdjacency(
      scan({ duplicateIds: [claim("dup2", ["/store/project/x.md"])] }),
      "dup2",
    );
    expect(result.target).toEqual({
      status: "ambiguous",
      id: "dup2",
      claimants: ["/store/project/x.md"],
    });
  });
});
