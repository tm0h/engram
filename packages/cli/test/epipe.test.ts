/**
 * EPIPE regression guard (ENG-39): piping CLI output to an early-closing
 * consumer (`| head`) used to crash with an unhandled "write EPIPE" error
 * event after the store mutation had already completed, so exit codes lied.
 *
 * The guard is tested through its injectable seam with fake streams and a spy
 * exit callback: no real pipes, no spawned `head`, and no mutation of the
 * real process.stdout/process.stderr (emitting "error" on the real streams
 * would kill the vitest worker on both broken and fixed code).
 */
import { describe, it, expect } from "vite-plus/test";
import { EventEmitter } from "node:events";
import { installEpipeGuard } from "../src/io.js";

const errWithCode = (code: string | undefined, message: string): NodeJS.ErrnoException => {
  const err = new Error(message) as NodeJS.ErrnoException;
  if (code !== undefined) err.code = code;
  return err;
};

const epipe = (): NodeJS.ErrnoException =>
  Object.assign(errWithCode("EPIPE", "write EPIPE"), { errno: -32, syscall: "write" });

const fakeStream = (): EventEmitter => new EventEmitter();

describe("installEpipeGuard", () => {
  it("exits 141 (conventional SIGPIPE) on an EPIPE error, without throwing", () => {
    const stream = fakeStream();
    const exitCalls: number[] = [];
    installEpipeGuard(stream, { exit: (code) => exitCalls.push(code) });
    expect(() => stream.emit("error", epipe())).not.toThrow();
    expect(exitCalls).toEqual([141]);
  });

  it("covers the stderr surface the same way (A3, Socket case)", () => {
    const stream = fakeStream();
    const exitCalls: number[] = [];
    installEpipeGuard(stream, { exit: (code) => exitCalls.push(code) });
    stream.emit("error", epipe());
    expect(exitCalls).toEqual([141]);
  });

  it("does not swallow non-EPIPE stream errors: they surface and never exit", () => {
    const stream = fakeStream();
    const exitCalls: number[] = [];
    installEpipeGuard(stream, { exit: (code) => exitCalls.push(code) });
    // codeless errors are treated like any non-EPIPE failure
    expect(() => stream.emit("error", errWithCode(undefined, "boom"))).toThrow("boom");
    expect(() => stream.emit("error", errWithCode("EACCES", "permission denied"))).toThrow(
      "permission denied",
    );
    expect(exitCalls).toEqual([]);
  });

  it("routes non-EPIPE errors to the onOtherError hook when one is provided", () => {
    const stream = fakeStream();
    const exitCalls: number[] = [];
    const seen: NodeJS.ErrnoException[] = [];
    installEpipeGuard(stream, {
      exit: (code) => exitCalls.push(code),
      onOtherError: (err) => seen.push(err),
    });
    const err = errWithCode("EACCES", "permission denied");
    expect(() => stream.emit("error", err)).not.toThrow();
    expect(seen).toEqual([err]);
    expect(exitCalls).toEqual([]);
    // an EPIPE arriving later still takes the SIGPIPE path
    stream.emit("error", epipe());
    expect(exitCalls).toEqual([141]);
  });

  it("attaches exactly one error listener per stream", () => {
    const stream = fakeStream();
    installEpipeGuard(stream, { exit: () => {} });
    expect(stream.listenerCount("error")).toBe(1);
  });
});
