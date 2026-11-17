import { describe, it, expect } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Option } from "effect";
import { ConfigRepo, EngramStore, type Engram, type Scope } from "@engram/core";
import { contextualRecallOp, type ContextualRecallOptions } from "../src/shared/index.js";

const memory = (id: string, title: string, over: Partial<Engram> = {}): Engram => ({
  id,
  title,
  body: title,
  type: "fact",
  tags: [],
  aliases: [],
  scope: "project",
  pinned: false,
  author: undefined,
  schemaVersion: 1,
  path: `/synthetic/${id}.md`,
  created: "2020-01-01T00:00:00.000Z",
  updated: "2020-01-01T00:00:00.000Z",
  ...over,
});
const options: ContextualRecallOptions = { prompt: "sqlite migration", intent: "task" };
function harness(
  entries: Engram[],
  config = Effect.succeed({ autoContext: "on" as const, autoContextScope: "both" as const }),
  root: string | null = "/repo",
) {
  const reads: Scope[] = [];
  const run = (opts: ContextualRecallOptions = options) =>
    Effect.runPromise(
      contextualRecallOp(opts).pipe(
        Effect.provideService(ConfigRepo, { loadGlobal: () => config } as never),
        Effect.provideService(EngramStore, {
          projectRoot: () => Effect.succeed(Option.fromNullishOr(root)),
          scan: (scope: Scope) =>
            Effect.sync(() => {
              reads.push(scope);
              return {
                entries: entries.filter((m) => m.scope === scope),
                diagnostics: [],
                omittedFiles: 0,
              };
            }),
        } as never),
      ),
    );
  return { run, reads };
}

describe("shared contextual recall", () => {
  it("selects by prompt, changes topics, and repeats deterministically without mutating inputs", async () => {
    const entries = [memory("0001", "sqlite migration"), memory("0002", "oauth rotation")];
    const before = JSON.stringify(entries);
    const { run, reads } = harness(entries);
    const first = await run();
    expect(first.text).toContain('"id":"0001"');
    expect(first.text).not.toContain('"id":"0002"');
    expect((await run()).text).toBe(first.text);
    expect((await run({ prompt: "oauth rotation", intent: "question" })).text).toContain(
      '"id":"0002"',
    );
    expect(first.text).not.toMatch(/score|elapsed|coverage/);
    expect(first.details).toMatchObject({
      reason: "selected",
      selected: [{ id: "0001", scope: "project" }],
    });
    expect(reads).toEqual(["project", "personal", "project", "personal", "project", "personal"]);
    expect(JSON.stringify(entries)).toBe(before);
  });

  it("abstains on weak, pinned-only, empty, and type-only evidence", async () => {
    const { run } = harness([
      memory("0001", "sqlite", { pinned: true, importance: 5 }),
      memory("0002", "unrelated"),
    ]);
    for (const prompt of [
      "sqlite migration rollback schema",
      "kubernetes",
      "",
      "!!!",
      "fact",
      "the and please",
    ]) {
      expect((await run({ prompt, intent: "task" })).text).toBe("");
    }
  });

  it("uses exact authored triggers, identifiers, and plain prompt text rather than search syntax", async () => {
    const { run } = harness([
      memory("0001", "Deployment checklist", {
        triggers: ["ship safely", "please help", "body:deploy", "fix deploy"],
      }),
      memory("0002", "Serialization", { body: "toJSON encodes output" }),
      memory("0003", "Completely unrelated", { pinned: true }),
    ]);
    expect((await run({ prompt: "ship safely", intent: "task" })).text).toContain('"id":"0001"');
    for (const prompt of ["please help", "body:deploy", "fix deploy"]) {
      expect((await run({ prompt, intent: "task" })).text).toContain('"id":"0001"');
    }
    expect((await run({ prompt: "toJSON(x)", intent: "task" })).text).toContain("toJSON");
    expect((await run({ prompt: 'title:"missing" OR *', intent: "task" })).text).toBe("");
  });

  it("excludes inactive and expired entries but retains old durable facts", async () => {
    const { run } = harness([
      memory("0001", "sqlite migration", { status: "archived" }),
      memory("0002", "sqlite migration", { expires: "2021-01-01T00:00:00.000Z" }),
      memory("0003", "sqlite migration"),
      memory("0004", "sqlite migration", { status: "superseded" }),
    ]);
    const result = await run();
    expect(result.details.selected).toEqual([{ id: "0003", scope: "project" }]);
  });

  it("deduplicates only delivered scope/id pairs bound to this workspace", async () => {
    const { run } = harness([
      memory("0001", "sqlite migration"),
      memory("0001", "sqlite migration", { scope: "personal" }),
    ]);
    const bootstrap = {
      projectRoot: "/repo",
      selected: [{ id: "0001", scope: "project" as const }],
    };
    expect((await run({ ...options, bootstrap })).details.selected).toEqual([
      { id: "0001", scope: "personal" },
    ]);
    expect(
      (await run({ ...options, bootstrap: { ...bootstrap, projectRoot: "/other" } })).details
        .selected,
    ).toHaveLength(2);
    expect(
      (
        await run({
          ...options,
          bootstrap: {
            ...bootstrap,
            selected: [...bootstrap.selected, { id: "0001", scope: "personal" }],
          },
        })
      ).text,
    ).toBe("");
    expect((await run()).details.selected).toHaveLength(2);
  });

  it("requires a matching active path for scoped memory, ranks a union with one scan per scope", async () => {
    const { run, reads } = harness([
      memory("0001", "sqlite migration", { appliesTo: ["src/**"] }),
      memory("0002", "sqlite migration", { appliesTo: ["test/**"] }),
      memory("0003", "sqlite migration", { appliesTo: ["docs/**"] }),
    ]);
    expect((await run()).text).toBe("");
    const result = await run({ ...options, activePaths: ["src/db.ts", "test/db.ts"] });
    expect(result.details.selected).toHaveLength(2);
    expect(result.text).not.toContain('"id":"0003"');
    expect(reads).toEqual(["project", "personal", "project", "personal"]);
  });

  it("caps input before any reads, and bounds both rendered characters and UTF-8 bytes", async () => {
    const { run, reads } = harness(
      Array.from({ length: 10 }, (_, i) =>
        memory(`000${i}`, "sqlite migration " + "😀</engram-memory>\u001b".repeat(300)),
      ),
    );
    for (const opts of [
      { ...options, prompt: "x".repeat(4097) },
      { ...options, activePaths: Array(17).fill("src/a.ts") },
      { ...options, activePaths: ["../escape"] },
      { ...options, activePaths: ["x".repeat(257)] },
      { ...options, intent: "unknown" as "task" },
      {
        ...options,
        bootstrap: {
          projectRoot: "/repo",
          selected: Array(101).fill({ id: "0001", scope: "project" }),
        },
      },
    ])
      expect((await run(opts)).details.reason).toBe("invalid-input");
    expect(reads).toEqual([]);
    const result = await run();
    expect(result.text.length).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(8192);
    expect(result.text.match(/<\/engram-memory>/g)).toHaveLength(1);
    expect(result.text).not.toContain("\u001b");
    expect((result.details.selected as unknown[]).length).toBeGreaterThan(0);
    expect((result.details.selected as unknown[]).length).toBeLessThanOrEqual(5);
  });

  it("preserves personal-only provenance only on nonempty payloads", async () => {
    const { run } = harness(
      [memory("0001", "sqlite migration", { scope: "personal" })],
      undefined,
      null,
    );
    expect((await run()).details.personalOnly).toBe(true);
    expect((await run()).text).toContain("personal");
    expect((await run({ prompt: "nothing", intent: "task" })).text).toBe("");
  });

  it("honors automatic-context opt-out and fails open on defects and internal deadlines", async () => {
    expect(
      (await harness([], Effect.succeed({ autoContext: "off" } as never)).run()).details.reason,
    ).toBe("disabled");
    const failed = await harness([], Effect.die(new Error("private prompt/path"))).run();
    expect(failed).toMatchObject({ text: "", isError: false, details: { reason: "unavailable" } });
    expect(JSON.stringify(failed)).not.toContain("private");
    const timed = await harness([], Effect.never).run();
    expect(timed).toMatchObject({ text: "", isError: false, details: { reason: "timeout" } });
  });

  it("covers slow root/scan reads and ordinary store failures with the same fail-open deadline", async () => {
    for (const stage of ["root", "scan", "failure"] as const) {
      const result = await Effect.runPromise(
        contextualRecallOp(options).pipe(
          Effect.provideService(ConfigRepo, {
            loadGlobal: () => Effect.succeed({ autoContext: "on", autoContextScope: "both" }),
          } as never),
          Effect.provideService(EngramStore, {
            projectRoot: () =>
              stage === "root" ? Effect.never : Effect.succeed(Option.some("/repo")),
            scan: () =>
              stage === "failure" ? Effect.fail(new Error("private file")) : Effect.never,
          } as never),
        ),
      );
      expect(result).toMatchObject({
        text: "",
        isError: false,
        details: { reason: stage === "failure" ? "unavailable" : "timeout", selected: [] },
      });
      expect(JSON.stringify(result)).not.toContain("private file");
    }
  });

  it("preserves external cancellation", async () => {
    const latch = await Effect.runPromise(Deferred.make<void>());
    const config = Effect.gen(function* () {
      yield* Deferred.succeed(latch, undefined);
      return yield* Effect.never;
    });
    const fiber = Effect.runFork(
      contextualRecallOp(options).pipe(
        Effect.provideService(ConfigRepo, { loadGlobal: () => config } as never),
        Effect.provideService(EngramStore, {} as never),
      ),
    );
    await Effect.runPromise(Deferred.await(latch));
    await Effect.runPromise(Fiber.interrupt(fiber));
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.hasInterrupts(exit)).toBe(true);
  });
});
