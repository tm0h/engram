import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Effect, Option, Result, Schedule } from "effect";
import { FileSystem, type File } from "effect/FileSystem";
import { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { ValidationError } from "./errors.js";

const busy = new ValidationError({ message: "Project capture controls are busy." });
const unavailable = new ValidationError({ message: "Project capture lock is unavailable." });
const legacy = new ValidationError({
  message:
    "Project capture has a legacy lock. Stop all capture processes before removing .engram/capture/.lock.",
});

let namespace: string | undefined;
const processNamespace = Effect.fnUntraced(function* () {
  if (namespace) return namespace;
  let identity = hostname();
  if (process.platform === "linux") {
    const fs = yield* FileSystem;
    const derived = yield* Effect.result(
      Effect.all([
        fs.readFileString("/proc/sys/kernel/random/boot_id"),
        fs.readLink("/proc/self/ns/pid"),
      ]),
    );
    // If the PID namespace cannot be identified, another process cannot
    // safely prove that this owner is gone.
    identity = Result.isSuccess(derived) ? identity + derived.success.join("") : randomUUID();
  }
  namespace ??= createHash("sha256").update(identity).digest("hex");
  return namespace;
});

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

const alreadyExists = (error: PlatformError) => error.reason._tag === "AlreadyExists";
const isContention = (error: PlatformError) =>
  alreadyExists(error) || errorCode(error.reason.cause) === "ENOTEMPTY";

export const withCaptureLock = <A, E, R>(
  directory: string,
  actor: number,
  operation: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    const protocol = path.join(directory, ".lock");
    const target = path.join(directory, ".holder");
    const local = yield* processNamespace();
    const name = `${process.pid}-${local}-${randomUUID()}`;
    const isPrivate = (stat: File.Info) =>
      Option.getOrUndefined(stat.uid) === actor && (stat.mode & 0o077) === 0;
    const acquire = Effect.gen(function* () {
      // Reserve the old mkdir lock path so older processes cannot acquire it
      // alongside this protocol. An existing ownerless directory is ambiguous.
      yield* fs
        .writeFileString(protocol, "", { flag: "wx", mode: 0o600 })
        .pipe(Effect.catchIf(alreadyExists, () => Effect.void));
      const marker = yield* fs.stat(protocol);
      if (marker.type === "Directory") return yield* Effect.fail(legacy);
      if (
        marker.type !== "File" ||
        !isPrivate(marker) ||
        Option.getOrUndefined(marker.nlink) !== 1 ||
        Number(marker.size) !== 0 ||
        (yield* fs.realPath(protocol)) !== protocol
      ) {
        return yield* Effect.fail(unavailable);
      }

      yield* Effect.acquireUseRelease(
        fs.makeTempDirectory({ directory, prefix: ".holder-tmp-" }),
        (staging) =>
          Effect.gen(function* () {
            yield* fs.writeFileString(path.join(staging, name), "", { flag: "wx", mode: 0o600 });
            yield* Effect.gen(function* () {
              // POSIX rename replaces an absent or empty directory atomically.
              // A live holder's unique marker makes its directory non-empty.
              const claim = yield* Effect.result(fs.rename(staging, target));
              if (Result.isSuccess(claim)) return;
              if (!isContention(claim.failure)) return yield* Effect.fail(claim.failure);
              const holder = yield* fs.stat(target);
              if (
                holder.type !== "Directory" ||
                !isPrivate(holder) ||
                (yield* fs.realPath(target)) !== target
              ) {
                return yield* Effect.fail(unavailable);
              }
              const owners = yield* fs.readDirectory(target);
              const owner = owners[0];
              if (owners.length === 1 && exited(owner, local)) {
                // Only remove this generation's marker. A delayed reclaimer
                // can never remove a new owner's marker or its directory.
                yield* fs.remove(path.join(target, owner), { force: true });
              }
              return yield* Effect.fail(busy);
            }).pipe(
              Effect.retry({
                times: 80,
                schedule: Schedule.spaced("25 millis"),
                while: (error) => error === busy,
              }),
            );
          }),
        (staging) => fs.remove(staging, { force: true, recursive: true }).pipe(Effect.ignore),
      );
    });

    return yield* Effect.acquireUseRelease(
      acquire,
      () => operation,
      () => fs.remove(path.join(target, name), { force: true }).pipe(Effect.ignore),
    );
  });
