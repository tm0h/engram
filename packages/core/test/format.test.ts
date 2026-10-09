import { describe, it, expect } from "vite-plus/test";
import {
  summaryLine,
  renderList,
  renderFull,
  renderSearch,
  renderContext,
  renderLinks,
  type LinksPage,
  type LinksRow,
} from "../src/format.js";
import type { Engram } from "../src/domain.js";
import type { LinkAdjacency, LinkTargetResolution } from "../src/links.js";
import { searchEngrams } from "../src/search.js";

const mem = (over: Partial<Engram> & { id: string; title: string }): Engram => ({
  type: "note",
  tags: [],
  scope: "project",
  created: "2025-01-01T00:00:00.000Z",
  updated: "2025-01-01T00:00:00.000Z",
  author: undefined,
  pinned: false,
  schemaVersion: 1,
  aliases: [],
  body: "",
  path: "",
  ...over,
});

describe("summaryLine", () => {
  it("includes id, type, title and tag hashes", () => {
    const line = summaryLine(
      mem({ id: "0001", title: "Hello", type: "decision", tags: ["a", "b"] }),
    );
    expect(line).toContain("0001");
    expect(line).toContain("Hello");
    expect(line).toContain("#a");
    expect(line).toContain("#b");
  });
  it("marks pinned with a star", () => {
    const line = summaryLine(mem({ id: "0001", title: "X", pinned: true }));
    expect(line).toContain("★");
  });
});

describe("renderList", () => {
  it("renders each engram with id and title", () => {
    const out = renderList([
      mem({ id: "0001", title: "First" }),
      mem({ id: "0002", title: "Second", body: "some body text" }),
    ]);
    expect(out).toContain("0001");
    expect(out).toContain("First");
    expect(out).toContain("some body text");
  });
  it("shows placeholder when empty", () => {
    expect(renderList([])).toContain("no engrams");
  });
});

describe("renderFull", () => {
  it("renders title, body and metadata", () => {
    const out = renderFull(mem({ id: "0001", title: "T", body: "Body here", author: "mo" }));
    expect(out).toContain("T");
    expect(out).toContain("Body here");
    expect(out).toContain("mo");
  });

  it("renders every defined lifecycle and provenance field with exact timestamps", () => {
    const out = renderFull(
      mem({
        id: "0001",
        title: "Replaced guidance",
        status: "superseded",
        supersedes: "0000",
        reviewAfter: "2026-01-01T00:00:00.000Z",
        expires: "2026-06-01T00:00:00.000Z",
        sourceType: "file",
        sourceRef: "docs/spec.md",
      }),
    );
    expect(out).toContain("status: superseded");
    expect(out).toContain("supersedes: 0000");
    // exact instants, not date-shortened forms
    expect(out).toContain("review-after: 2026-01-01T00:00:00.000Z");
    expect(out).toContain("expires: 2026-06-01T00:00:00.000Z");
    expect(out).toContain("source: file · docs/spec.md");
  });

  it("renders sourceType and sourceRef independently", () => {
    expect(renderFull(mem({ id: "0001", title: "A", sourceType: "conversation" }))).toContain(
      "source: conversation",
    );
    expect(renderFull(mem({ id: "0001", title: "B", sourceRef: "chat log" }))).toContain(
      "source: chat log",
    );
  });

  it("omits the lifecycle block entirely for v0.4 entries", () => {
    const out = renderFull(mem({ id: "0001", title: "Plain" }));
    expect(out).not.toContain("status:");
    expect(out).not.toContain("supersedes:");
    expect(out).not.toContain("review-after:");
    expect(out).not.toContain("expires:");
    expect(out).not.toContain("source:");
  });
});

describe("renderSearch", () => {
  it("renders matches with a score", () => {
    const list = [mem({ id: "0001", title: "auth", tags: ["auth"] })];
    const results = searchEngrams(list, "auth");
    const out = renderSearch(results);
    expect(out).toContain("0001");
    expect(out).toContain("score");
  });
  it("shows placeholder when no matches", () => {
    expect(renderSearch([])).toContain("no matches");
  });
});

describe("renderContext", () => {
  it("query mode dumps bodies with a header", () => {
    const out = renderContext([mem({ id: "0001", title: "T", body: "Because reasons" })], {
      query: "reasons",
      scope: "project",
    });
    expect(out).toContain("Engram search");
    expect(out).toContain("Because reasons");
  });
  it("digest groups decisions & pinned first", () => {
    const out = renderContext(
      [
        mem({ id: "0001", title: "Decision A", type: "decision" }),
        mem({ id: "0002", title: "Note B", type: "note" }),
      ],
      { scope: "project" },
    );
    expect(out).toContain("Decisions & pinned");
    expect(out).toContain("Decision A");
    expect(out).toContain("Note B");
  });
  it("reports count", () => {
    const out = renderContext([mem({ id: "0001", title: "X" })], { scope: "personal" });
    expect(out).toContain("1 engram");
    expect(out).toContain("personal engram");
  });
});

describe("renderFull / related (ENG-42)", () => {
  it("prints one ordered related line for a populated list", () => {
    const out = renderFull(mem({ id: "0001", title: "T", related: ["0003", "0002"] }));
    expect(out).toContain("related: 0003, 0002");
    // exactly one related line, in list order
    expect(out.match(/related:/g)).toHaveLength(1);
    expect(out.indexOf("0003")).toBeLessThan(out.indexOf("0002"));
  });

  it("prints no related line when the list is absent or empty", () => {
    expect(renderFull(mem({ id: "0001", title: "T" }))).not.toContain("related:");
    expect(renderFull(mem({ id: "0001", title: "T", related: [] }))).not.toContain("related:");
  });

  it("keeps the related line inside the gray metadata block next to lifecycle labels", () => {
    const out = renderFull(
      mem({ id: "0001", title: "T", status: "superseded", related: ["0002"] }),
    );
    const blockLines = out
      .split("\n")
      .filter((l) => l.startsWith("  "))
      .map((l) => l.trim());
    expect(blockLines).toEqual(["status: superseded", "related: 0002"]);
  });
});

/* ENG-45: the link-graph formatter. Pure plain text (no chalk), driven by a
 * pre-sliced page of the flattened outgoing-then-incoming row stream. The
 * formatter never resolves ids and never touches the store. */
describe("renderLinks (ENG-45)", () => {
  const res = (r: LinkTargetResolution): LinkTargetResolution => r;

  const foundAdjacency = (over: Partial<LinkAdjacency> = {}): LinkAdjacency => ({
    target: {
      status: "found",
      id: "0012",
      entry: mem({ id: "0012", title: "Root entry", type: "decision" }),
    },
    outgoing: [],
    incoming: [],
    ...over,
  });

  const page = (rows: ReadonlyArray<LinksRow>, offset = 0, total = rows.length): LinksPage => ({
    offset,
    total,
    rows,
  });

  it("renders a stable target header for a found target", () => {
    const out = renderLinks(foundAdjacency(), page([]));
    expect(out.startsWith("Links for 0012 - Root entry (decision)")).toBe(true);
  });

  it("marks a missing target in the header", () => {
    const out = renderLinks(
      foundAdjacency({ target: { status: "missing", id: "9999" } }),
      page([]),
    );
    expect(out).toContain("Links for 9999 - MISSING");
  });

  it("marks an ambiguous target with bounded claimant context", () => {
    const out = renderLinks(
      foundAdjacency({
        target: {
          status: "ambiguous",
          id: "0004",
          claimants: ["/s/0004-a.md", "/s/0004-b.md", "/s/0004-c.md", "/s/0004-d.md"],
        },
      }),
      page([]),
    );
    expect(out).toContain("Links for 0004 - AMBIGUOUS (4 claimants)");
    expect(out).toContain("/s/0004-a.md");
    expect(out).toContain("/s/0004-b.md");
    expect(out).toContain("/s/0004-c.md");
    expect(out).not.toContain("/s/0004-d.md");
    expect(out).toContain("+1 more");
  });

  it("renders (none) for genuinely empty sections", () => {
    const out = renderLinks(foundAdjacency(), page([]));
    expect(out).toContain("Outgoing\n  (none)");
    expect(out).toContain("Incoming\n  (none)");
  });

  it("keeps authored outgoing order and renders MISSING/AMBIGUOUS markers", () => {
    const out = renderLinks(
      foundAdjacency({
        outgoing: [
          res({
            status: "found",
            id: "0003",
            entry: mem({ id: "0003", title: "Auth decision", type: "decision", tags: ["auth"] }),
          }),
          res({ status: "missing", id: "9999" }),
          res({
            status: "ambiguous",
            id: "0004",
            claimants: ["/s/0004-a.md", "/s/0004-b.md"],
          }),
          res({ status: "found", id: "0002", entry: mem({ id: "0002", title: "Older note" }) }),
        ],
      }),
      page([
        {
          direction: "outgoing",
          resolution: res({
            status: "found",
            id: "0003",
            entry: mem({ id: "0003", title: "Auth decision", type: "decision", tags: ["auth"] }),
          }),
        },
        { direction: "outgoing", resolution: res({ status: "missing", id: "9999" }) },
        {
          direction: "outgoing",
          resolution: res({
            status: "ambiguous",
            id: "0004",
            claimants: ["/s/0004-a.md", "/s/0004-b.md"],
          }),
        },
        {
          direction: "outgoing",
          resolution: res({
            status: "found",
            id: "0002",
            entry: mem({ id: "0002", title: "Older note" }),
          }),
        },
      ]),
    );
    expect(out.indexOf("0003")).toBeLessThan(out.indexOf("9999"));
    expect(out.indexOf("9999")).toBeLessThan(out.indexOf("0004"));
    expect(out.indexOf("0004")).toBeLessThan(out.indexOf("0002"));
    expect(out).toContain("9999 MISSING");
    expect(out).toContain("0004 AMBIGUOUS (2 claimants)");
    expect(out).toContain("/s/0004-a.md");
    expect(out).toContain("/s/0004-b.md");
    expect(out).toContain("0003 decision Auth decision #auth");
    expect(out.indexOf("Outgoing")).toBeGreaterThan(-1);
  });

  it("renders incoming rows in chronological order with created-then-id tie-break", () => {
    const earlier = mem({ id: "0007", title: "Early link", created: "2025-08-15T10:00:00.000Z" });
    const tieB = mem({ id: "0009", title: "Tie B", created: "2025-08-16T10:00:00.000Z" });
    const tieA = mem({ id: "0008", title: "Tie A", created: "2025-08-16T10:00:00.000Z" });
    const later = mem({ id: "0006", title: "Late link", created: "2025-08-17T10:00:00.000Z" });
    const incoming = [earlier, tieB, tieA, later];
    const out = renderLinks(
      foundAdjacency({ incoming }),
      page(incoming.map((entry) => ({ direction: "incoming" as const, entry }))),
    );
    expect(out.indexOf("0007")).toBeLessThan(out.indexOf("0009"));
    expect(out.indexOf("0009")).toBeLessThan(out.indexOf("0008"));
    expect(out.indexOf("0008")).toBeLessThan(out.indexOf("0006"));
    expect(out).toContain("(created 2025-08-16)");
  });

  it("renders only the labels for directions present on the page", () => {
    const outgoingRow: LinksRow = {
      direction: "outgoing",
      resolution: res({ status: "found", id: "0002", entry: mem({ id: "0002", title: "Older" }) }),
    };
    const outgoingOnly = renderLinks(foundAdjacency(), page([outgoingRow], 0, 2));
    expect(outgoingOnly).toContain("Outgoing");
    expect(outgoingOnly).not.toContain("Incoming");

    const incomingEntry = mem({ id: "0007", title: "Early link" });
    const incomingOnly = renderLinks(
      foundAdjacency(),
      page([{ direction: "incoming", entry: incomingEntry }], 1, 2),
    );
    expect(incomingOnly).toContain("Incoming");
    expect(incomingOnly).not.toContain("Outgoing");
  });

  it("renders both labels in fixed order on a page spanning the boundary", () => {
    const outgoingRow: LinksRow = {
      direction: "outgoing",
      resolution: res({ status: "found", id: "0002", entry: mem({ id: "0002", title: "Older" }) }),
    };
    const incomingRow: LinksRow = {
      direction: "incoming",
      entry: mem({ id: "0007", title: "Early link" }),
    };
    const out = renderLinks(foundAdjacency(), page([outgoingRow, incomingRow], 0, 2));
    expect(out.indexOf("Outgoing")).toBeLessThan(out.indexOf("Incoming"));
    expect(out.indexOf("0002")).toBeLessThan(out.indexOf("0007"));
  });

  it("bounds the repeated target header title (P1b)", () => {
    const longTitle = "T".repeat(3000);
    const out = renderLinks(
      foundAdjacency({
        target: {
          status: "found",
          id: "0012",
          entry: mem({ id: "0012", title: longTitle, type: "note" }),
        },
      }),
      page([]),
    );
    expect(out).toContain(longTitle.slice(0, 1024));
    expect(out).toContain("… (+1976 chars)");
    expect(out).not.toContain(longTitle);
  });

  it("keeps the target header single-line for short titles containing newlines (F4)", () => {
    const out = renderLinks(
      foundAdjacency({
        target: {
          status: "found",
          id: "0012",
          entry: mem({ id: "0012", title: "bad\n\nmulti", type: "note" }),
        },
      }),
      page([]),
    );
    expect(out.startsWith("Links for 0012 - bad … (+7 chars) (note)\n")).toBe(true);
  });

  it("renders an explicit offset note when the window is at or past the total", () => {
    const out = renderLinks(foundAdjacency(), page([], 25, 4));
    expect(out).toContain("offset 25");
    expect(out).toContain("4 rows total");
    expect(out).not.toContain("(none)");
    expect(out).not.toContain("Outgoing");
  });

  it("emits plain text without ANSI", () => {
    const out = renderLinks(
      foundAdjacency({
        outgoing: [
          res({
            status: "found",
            id: "0003",
            entry: mem({
              id: "0003",
              title: "Auth",
              type: "decision",
              tags: ["auth"],
              pinned: true,
            }),
          }),
          res({ status: "missing", id: "9999" }),
          res({ status: "ambiguous", id: "0004", claimants: ["/s/a.md"] }),
        ],
        incoming: [mem({ id: "0007", title: "Early link", type: "fact", tags: ["x"] })],
      }),
      page([
        {
          direction: "outgoing",
          resolution: res({
            status: "found",
            id: "0003",
            entry: mem({
              id: "0003",
              title: "Auth",
              type: "decision",
              tags: ["auth"],
              pinned: true,
            }),
          }),
        },
        { direction: "outgoing", resolution: res({ status: "missing", id: "9999" }) },
        {
          direction: "outgoing",
          resolution: res({ status: "ambiguous", id: "0004", claimants: ["/s/a.md"] }),
        },
        {
          direction: "incoming",
          entry: mem({ id: "0007", title: "Early link", type: "fact", tags: ["x"] }),
        },
      ]),
    );
    // eslint-disable-next-line no-control-regex -- intentionally detecting ANSI escapes
    expect(out).not.toMatch(/\u001b\[/);
  });
});

/* ENG-46: the aliases line in renderFull */

describe("renderFull / aliases (ENG-46)", () => {
  it("prints one ordered aliases line for a populated list", () => {
    const out = renderFull(mem({ id: "0001", title: "T", aliases: ["postgres", "pg"] }));
    expect(out).toContain("aliases: postgres, pg");
    expect(out.match(/aliases:/g)).toHaveLength(1);
  });

  it("prints no aliases line when the list is empty", () => {
    expect(renderFull(mem({ id: "0001", title: "T", aliases: [] }))).not.toContain("aliases:");
  });

  it("sits right after the related line in the gray metadata block", () => {
    const out = renderFull(
      mem({ id: "0001", title: "T", status: "superseded", related: ["0002"], aliases: ["pg"] }),
    );
    const blockLines = out
      .split("\n")
      .filter((line) => line.startsWith("  ") && line.trim().length > 0)
      .map((line) => line.trim());
    expect(blockLines).toEqual(["status: superseded", "related: 0002", "aliases: pg"]);
  });
});
