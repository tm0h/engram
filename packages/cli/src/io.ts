/**
 * Shared I/O helpers for commands.
 */
import { Effect, Console } from "effect";

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
