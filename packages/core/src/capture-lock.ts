import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import { lstat, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { Effect, Schedule } from "effect";
import { ValidationError } from "./errors.js";

const busy = new ValidationError({ message: "Project capture controls are busy." });
const unavailable = new ValidationError({ message: "Project capture lock is unavailable." });
const legacy = new ValidationError({
  message:
    "Project capture has a legacy lock. Stop all capture processes before removing .engram/capture/.lock.",
});

let namespace: string | undefined;
function processNamespace() {
  if (namespace) return namespace;
  let identity = hostname();
  if (process.platform === "linux") {
    try {
      identity +=
        readFileSync("/proc/sys/kernel/random/boot_id", "utf8") + readlinkSync("/proc/self/ns/pid");
    } catch {
      // If the PID namespace cannot be identified, another process cannot
      // safely prove that this owner is gone.
      identity = randomUUID();
    }
  }
  namespace = createHash("sha256").update(identity).digest("hex");
  return namespace;
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

function exited(value: string, local: string) {
  const parsed = /^(\d+)-([a-f0-9]{64})-[a-f0-9-]{36}$/.exec(value);
  if (parsed?.[2] !== local) return false;
  const pid = Number(parsed[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fff_ffff) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM and unrecognized errors leave the holder in place.
    return errorCode(error) === "ESRCH";
  }
}

const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => (error instanceof ValidationError ? error : unavailable),
  });

export const withCaptureLock = <A, E, R>(
  directory: string,
  actor: number,
  operation: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const protocol = join(directory, ".lock");
    const target = join(directory, ".holder");
    const local = processNamespace();
    const name = `${process.pid}-${local}-${randomUUID()}`;
    const acquire = Effect.gen(function* () {
      yield* io(async () => {
        // Reserve the old mkdir lock path so older processes cannot acquire it
        // alongside this protocol. An existing ownerless directory is ambiguous.
        try {
          await writeFile(protocol, "", { flag: "wx", mode: 0o600 });
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
        }
        const marker = await lstat(protocol);
        if (marker.isDirectory()) throw legacy;
        if (
          !marker.isFile() ||
          marker.uid !== actor ||
          marker.mode & 0o077 ||
          marker.nlink !== 1 ||
          marker.size !== 0
        ) {
          throw unavailable;
        }
      });

      yield* Effect.acquireUseRelease(
        io(() => mkdtemp(join(directory, ".holder-tmp-"))),
        (staging) =>
          Effect.gen(function* () {
            yield* io(() => writeFile(join(staging, name), "", { flag: "wx", mode: 0o600 }));
            yield* io(async () => {
              try {
                // POSIX rename replaces an absent or empty directory atomically.
                // A live holder's unique marker makes its directory non-empty.
                await rename(staging, target);
                return;
              } catch (error) {
                if (errorCode(error) !== "ENOTEMPTY" && errorCode(error) !== "EEXIST") throw error;
              }
              const holder = await lstat(target);
              if (!holder.isDirectory() || holder.uid !== actor || holder.mode & 0o077)
                throw unavailable;
              const owners = await readdir(target);
              const owner = owners[0];
              if (owners.length === 1 && exited(owner, local)) {
                // Only remove this generation's marker. A delayed reclaimer
                // can never remove a new owner's marker or its directory.
                await rm(join(target, owner), { force: true });
              }
              throw busy;
            }).pipe(
              Effect.retry({
                times: 80,
                schedule: Schedule.spaced("25 millis"),
                while: (error) => error === busy,
              }),
            );
          }),
        (staging) => io(() => rm(staging, { force: true, recursive: true })).pipe(Effect.ignore),
      );
    });

    return yield* Effect.acquireUseRelease(
      acquire,
      () => operation,
      () => io(() => rm(join(target, name), { force: true })).pipe(Effect.ignore),
    );
  });
