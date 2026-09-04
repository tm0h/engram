/**
 * Shared I/O helpers for commands.
 */
import { Effect, Console } from "effect";
import process from "node:process";

/** Read all of stdin as a string; resolves to "" if stdin is a TTY (no pipe). */
export const readStdin = (): Effect.Effect<string> =>
  Effect.promise(
    () =>
      new Promise<string>((resolve) => {
        if (process.stdin.isTTY) {
          resolve("");
          return;
        }
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (c: string) => {
          data += c;
        });
        process.stdin.once("end", () => resolve(data));
        process.stdin.once("error", () => resolve(data));
      }),
  );

export const out = (s: string): Effect.Effect<void> => Console.log(s);
export const err = (s: string): Effect.Effect<void> => Console.error(s);

/** Minimal surface of an output stream that the EPIPE guard needs. */
export interface ErrorEventEmitter {
  on(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown;
}

export interface EpipeGuardOptions {
  /** Exit callback, injectable for tests. Defaults to process.exit. */
  readonly exit?: (code: number) => void;
  /**
   * Receives non-EPIPE stream errors when provided. The default rethrows them
   * so real I/O failures still surface.
   */
  readonly onOtherError?: (err: NodeJS.ErrnoException) => void;
}

/**
 * Handle EPIPE from an output stream with conventional SIGPIPE semantics
 * (exit 141 = 128 + SIGPIPE[13]) instead of crashing on the unhandled
 * "error" event. This is what lets `engram add ... | head -1` exit cleanly.
 *
 * EPIPE-only: any other stream error is re-raised (or handed to
 * onOtherError) so real I/O failures still surface loudly.
 *
 * Invariant (keep it): every command completes its store mutation BEFORE it
 * emits output, so exiting on EPIPE never truncates a half-done mutation.
 * process.exit(141) may truncate queued pipe output; that is accepted,
 * standard SIGPIPE behavior.
 *
 * Scope note: this covers the piped-Socket case for both streams. stderr
 * redirected to a file uses synchronous writes, whose failures surface at
 * the write call site through the normal error path (exit 1) instead.
 */
export const installEpipeGuard = (
  stream: ErrorEventEmitter,
  options: EpipeGuardOptions = {},
): void => {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err?.code === "EPIPE") {
      exit(141);
      return;
    }
    if (options.onOtherError) {
      options.onOtherError(err);
      return;
    }
    throw err;
  });
};
