/**
 * `engram hook <host> <event>` — lifecycle hook entry point (ENG-58).
 *
 * Fail-open contract (leader ruling A2; bounds in the shared constants
 * module at @engram/harnesses/installer):
 * - Valid invocations ALWAYS exit 0; any failure produces empty output.
 * - Injected stdout is capped at HOOK_STDOUT_CAP_BYTES with TRUNCATION_MARKER.
 * - Context loading is bounded by HOOK_TIMEOUT_MS wall clock.
 * - stderr is suppressed unless HOOK_DEBUG_ENV (ENGRAM_DEBUG) is set.
 *   Console output from the digest pipeline is buffered and only flushed in
 *   debug mode, so injected stdout is exactly the digest.
 *
 * A5: installed hook entries invoke `engram` bare; the host shell resolves
 * PATH at hook runtime. Nothing here depends on install-time paths.
 */
import { Console, Duration, Effect, Option } from "effect";
import type { Console as ConsoleService } from "effect/Console";
import process from "node:process";
import chalk from "chalk";
import {
  HOOK_DEBUG_ENV,
  HOOK_STDOUT_CAP_BYTES,
  HOOK_TIMEOUT_MS,
  TRUNCATION_MARKER,
} from "@engram/harnesses/installer";
import { buildContextDigest } from "./context.js";

export const HOOK_HOSTS = ["claude-code", "codex"] as const;
export const HOOK_EVENTS = ["startup", "resume", "compact"] as const;

export interface HookOptions {
  readonly host: string;
  readonly event: string;
  /** Test override; defaults to HOOK_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

/** Byte-accurate cap: cuts at the last complete UTF-8 codepoint that fits. */
export const capToBytes = (text: string, cap: number, marker: string): string => {
  if (Buffer.byteLength(text, "utf8") <= cap) return text;
  const allowed = Math.max(0, cap - Buffer.byteLength(marker, "utf8"));
  const cut = Buffer.from(text, "utf8").subarray(0, allowed).toString("utf8");
  return `${cut.replace(/\uFFFD+$/, "")}${marker}`;
};

/** A Console service that buffers output instead of writing it. */
interface BufferedConsole {
  readonly console: ConsoleService;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

const bufferedConsole = (): BufferedConsole => {
  const outBuf: string[] = [];
  const errBuf: string[] = [];
  const push =
    (buf: string[]) =>
    (...args: ReadonlyArray<any>): void => {
      buf.push(args.map(String).join(" "));
    };
  const noop = (): void => {};
  const console: ConsoleService = {
    assert: noop,
    clear: noop,
    count: noop,
    countReset: noop,
    debug: push(outBuf),
    dir: noop,
    dirxml: noop,
    error: push(errBuf),
    group: noop,
    groupCollapsed: noop,
    groupEnd: noop,
    info: push(outBuf),
    log: push(outBuf),
    table: noop,
    time: noop,
    timeEnd: noop,
    timeLog: noop,
    trace: noop,
    warn: push(errBuf),
  };
  return { console, stdout: () => outBuf.join(""), stderr: () => errBuf.join("") };
};

export const hookCommand = ({ host, event, timeoutMs = HOOK_TIMEOUT_MS }: HookOptions) =>
  Effect.gen(function* () {
    if (
      !HOOK_HOSTS.includes(host as (typeof HOOK_HOSTS)[number]) ||
      !HOOK_EVENTS.includes(event as (typeof HOOK_EVENTS)[number])
    ) {
      // Usage errors are command errors, not hook runtime errors: they may
      // fail loudly. Valid hook invocations never reach this branch.
      return yield* Effect.fail(
        new Error(`usage: engram hook <${HOOK_HOSTS.join("|")}> <${HOOK_EVENTS.join("|")}>`),
      );
    }
    // Hook output is context injection -> force plain text.
    chalk.level = 0;
    const debug = Boolean(process.env[HOOK_DEBUG_ENV]);
    const buffered = bufferedConsole();
    let failure: string | null = null;
    const digest = yield* buildContextDigest({}).pipe(
      Effect.provideService(Console.Console, buffered.console),
      Effect.timeoutOption(Duration.millis(timeoutMs)),
      Effect.catch((e) => {
        failure = e instanceof Error ? e.message : String(e);
        return Effect.succeedNone;
      }),
      Effect.catchDefect((d) => {
        failure = d instanceof Error ? d.message : String(d);
        return Effect.succeedNone;
      }),
    );
    const text = Option.isSome(digest)
      ? capToBytes(digest.value, HOOK_STDOUT_CAP_BYTES, TRUNCATION_MARKER)
      : "";
    // The trailing newline is part of the cap budget: injected stdout never
    // exceeds HOOK_STDOUT_CAP_BYTES bytes (the truncation marker ends with a
    // newline, so capped output is written as-is).
    if (text !== "") {
      const withNewline = text.endsWith("\n") ? text : `${text}\n`;
      process.stdout.write(
        Buffer.byteLength(withNewline, "utf8") <= HOOK_STDOUT_CAP_BYTES ? withNewline : text,
      );
    }
    if (debug) {
      const notes = `${buffered.stdout()}${buffered.stderr()}`;
      if (notes !== "") process.stderr.write(notes);
      if (Option.isNone(digest)) {
        const reason = failure !== null ? failure : "no result";
        process.stderr.write(
          failure !== null
            ? `engram hook: context load failed: ${reason}\n`
            : `engram hook: context load timed out after ${timeoutMs}ms\n`,
        );
      }
    }
  }).pipe(Effect.catchDefect(() => Effect.void));
