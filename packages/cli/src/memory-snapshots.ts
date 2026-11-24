import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { ValidationError } from "@engram/core";
import { Effect, Result } from "effect";

const exec = promisify(execFile);
const maxEntryBytes = 1024 * 1024;
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const attempt = <A>(run: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => error });
const sync = <A>(run: () => A) => Effect.try({ try: run, catch: (error) => error });
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type Commit = { readonly kind: "commit"; readonly sha: string };

interface SnapshotFile {
  readonly path: string | null;
  readonly read: () => Effect.Effect<Buffer, unknown>;
}

export interface SnapshotSource {
  readonly directory: string;
  readonly list: () => Effect.Effect<ReadonlyArray<SnapshotFile>, unknown>;
}

function gitEnvironment() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  return {
    ...env,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    // Older Git versions can attempt a promisor fetch despite NO_LAZY_FETCH.
    GIT_ALLOW_PROTOCOL: "",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function gitAt(cwd: string) {
  return (args: string[], maxBuffer = 16 * 1024 * 1024) =>
    attempt(() =>
      exec("git", ["--literal-pathspecs", "-c", "core.warnAmbiguousRefs=true", ...args], {
        cwd,
        env: gitEnvironment(),
        encoding: "buffer",
        maxBuffer,
        timeout: 10000,
      }),
    );
}

type Git = ReturnType<typeof gitAt>;

function resolveCommit(git: Git, ref: string) {
  return Effect.gen(function* () {
    const resolved = yield* Effect.result(
      git(["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"]),
    );
    if (Result.isSuccess(resolved)) {
      const sha = resolved.success.stdout.toString().trim();
      if (oid.test(sha) && resolved.success.stderr.length === 0) {
        return { kind: "commit", sha } as const;
      }
    }
    return yield* Effect.fail(
      new ValidationError({
        message:
          "Cannot resolve a unique commit. Check the refs and ensure their history is available.",
      }),
    );
  });
}

function resolveComparison(git: Git, revision?: string) {
  return Effect.gen(function* () {
    const [left, separator, right] =
      revision === undefined ? ["HEAD"] : yield* sync(() => parseRevision(revision));
    const from = yield* resolveCommit(git, left);
    if (right === undefined)
      return { mode: "working-tree", from, to: { kind: "working-tree" } } as const;
    const to = yield* resolveCommit(git, right);
    if (separator === "..") return { mode: "direct", from, to } as const;
    const base = yield* Effect.result(git(["merge-base", "--all", from.sha, to.sha]));
    const sha = Result.isSuccess(base) ? base.success.stdout.toString().trim() : "";
    if (oid.test(sha))
      return { mode: "merge-base", from: { kind: "commit", sha } as const, to } as const;
    return yield* Effect.fail(
      new ValidationError({
        message:
          "The range needs one available merge base. Fetch missing history or use an explicit two-dot range.",
      }),
    );
  });
}

function parseRevision(revision: string) {
  const parts = revision.split(/(\.{2,})/);
  if (
    (parts.length === 1 && parts[0]) ||
    (parts.length === 3 && parts[0] && parts[2] && (parts[1] === ".." || parts[1] === "..."))
  )
    return parts;
  throw new ValidationError({
    message: "Use one ref, A..B, or A...B, with both range endpoints supplied.",
  });
}

function statIfPresent(file: string) {
  return Effect.gen(function* () {
    const result = yield* Effect.result(attempt(() => lstat(file)));
    if (Result.isSuccess(result)) return result.success;
    if ((result.failure as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return yield* Effect.fail(result.failure);
  });
}

function projectPrefix(root: string, cwd: string) {
  return Effect.gen(function* () {
    const homeResult = yield* Effect.result(attempt(() => realpath(homedir())));
    const home = Result.isSuccess(homeResult) ? homeResult.success : homedir();
    const personal = join(home, ".engram");
    if (cwd === personal || cwd.startsWith(personal + sep)) {
      return yield* Effect.fail(
        new ValidationError({
          message: "Select a Git project directory outside the personal memory store.",
        }),
      );
    }
    for (let dir = cwd; dir !== root; dir = dirname(dir)) {
      if (dir === home) continue;
      const memory = join(dir, ".engram");
      const info = yield* statIfPresent(memory);
      if (info && (!info.isDirectory() || (yield* statIfPresent(join(memory, "config.json"))))) {
        return relative(root, dir).split(sep);
      }
    }
    if (root === home)
      return yield* Effect.fail(
        new ValidationError({
          message: "Select a Git project directory outside the personal memory store.",
        }),
      );
    return [];
  });
}

export function memorySnapshots(cwd: string, revision?: string) {
  return Effect.gen(function* () {
    const start = yield* attempt(() => realpath(cwd));
    const found = yield* Effect.result(
      Effect.gen(function* () {
        const { stdout } = yield* gitAt(start)(["rev-parse", "--show-toplevel"]);
        const root = yield* attempt(() => realpath(utf8.decode(stdout).replace(/\n$/, "")));
        const location = relative(root, start);
        if (location === ".." || location.startsWith(".." + sep) || isAbsolute(location)) {
          return yield* Effect.fail(new Error("Working tree outside the current directory"));
        }
        return root;
      }),
    );
    if (Result.isFailure(found))
      return yield* Effect.fail(
        new ValidationError({ message: "Run engram diff inside a Git working tree." }),
      );
    const root = found.success;
    const prefix = yield* projectPrefix(root, start);
    const segments = [...prefix, ".engram", "engrams"];
    const git = gitAt(root);
    const comparison = yield* resolveComparison(git, revision);
    const blobs = new GitBlobReader(root, git);
    return {
      close: blobs.close(),
      comparison,
      project: prefix.join("/") || ".",
      from: gitSnapshot(git, blobs, comparison.from, segments),
      to:
        comparison.to.kind === "commit"
          ? gitSnapshot(git, blobs, comparison.to, segments)
          : workingSnapshot(root, segments),
    };
  });
}

// One process serves both committed endpoints. Requests are serialized so the
// batch protocol can be parsed incrementally without buffering oversized blobs.
class GitBlobReader {
  private child: ReturnType<typeof spawn> | undefined;
  private iterator: AsyncIterator<Buffer> | undefined;
  private pending = Buffer.alloc(0);
  private cache = new Map<string, Result.Result<Buffer, unknown>>();
  private failed = false;

  constructor(
    private readonly cwd: string,
    private readonly git: Git,
  ) {}

  read(sha: string): Effect.Effect<Buffer, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const cached = self.cache.get(sha);
      if (cached)
        return yield* Result.isSuccess(cached)
          ? Effect.succeed(cached.success)
          : Effect.fail(cached.failure);
      const result = yield* Effect.result(self.readBlob(sha));
      self.cache.set(sha, result);
      return yield* Result.isSuccess(result)
        ? Effect.succeed(result.success)
        : Effect.fail(result.failure);
    });
  }

  private start() {
    if (this.child) return this.child;
    const child = spawn("git", ["cat-file", "--batch-command"], {
      cwd: this.cwd,
      env: gitEnvironment(),
      stdio: ["pipe", "pipe", "ignore"],
    });
    child.stdin!.on("error", () => {});
    child.on("error", () => {
      this.failed = true;
    });
    this.child = child;
    this.iterator = child.stdout![Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    return child;
  }

  private take(size: number) {
    const self = this;
    return Effect.gen(function* () {
      while (self.pending.length < size) {
        const chunk = yield* attempt(() => self.iterator!.next());
        if (chunk.done) return yield* Effect.fail(new Error("Git batch output ended early"));
        self.pending = Buffer.concat([self.pending, chunk.value]);
      }
      const result = self.pending.subarray(0, size);
      self.pending = self.pending.subarray(size);
      return result;
    });
  }

  private header() {
    const self = this;
    return Effect.gen(function* () {
      while (true) {
        const end = self.pending.indexOf(10);
        if (end >= 0) {
          const line = self.pending.subarray(0, end).toString("ascii");
          self.pending = self.pending.subarray(end + 1);
          return line;
        }
        if (self.pending.length > 256)
          return yield* Effect.fail(new Error("Invalid Git batch header"));
        const chunk = yield* attempt(() => self.iterator!.next());
        if (chunk.done) return yield* Effect.fail(new Error("Git batch output ended early"));
        self.pending = Buffer.concat([self.pending, chunk.value]);
      }
    });
  }

  private readBlob(sha: string): Effect.Effect<Buffer, unknown> {
    const self = this;
    return Effect.gen(function* () {
      if (self.failed) return (yield* self.git(["cat-file", "blob", sha], maxEntryBytes)).stdout;
      const child = yield* sync(() => self.start());
      let streamAligned = false;
      const exchange = Effect.gen(function* () {
        yield* sync(() => child.stdin!.write(`info ${sha}\n`));
        const info = yield* self.header();
        streamAligned = true;
        const match = /^([0-9a-f]+) blob ([0-9]+)$/.exec(info);
        if (!match || match[1] !== sha) return yield* Effect.fail(new Error("Blob unavailable"));
        const size = Number(match[2]);
        if (!Number.isSafeInteger(size) || size > maxEntryBytes)
          return yield* Effect.fail(new Error("Blob exceeds size limit"));
        streamAligned = false;
        yield* sync(() => child.stdin!.write(`contents ${sha}\n`));
        if ((yield* self.header()) !== info)
          return yield* Effect.fail(new Error("Invalid Git batch response"));
        const bytes = yield* self.take(size);
        if ((yield* self.take(1))[0] !== 10)
          return yield* Effect.fail(new Error("Invalid Git batch terminator"));
        return bytes;
      });
      const result = yield* Effect.result(exchange.pipe(Effect.timeout("10 seconds")));
      if (Result.isSuccess(result)) return result.success;
      if (!streamAligned) {
        self.failed = true;
        child.kill();
        return (yield* self.git(["cat-file", "blob", sha], maxEntryBytes)).stdout;
      }
      return yield* Effect.fail(result.failure);
    });
  }

  close() {
    return Effect.sync(() => {
      this.child?.stdin?.end();
    });
  }
}

interface TreeEntry {
  readonly name: string;
  readonly sha: string;
  readonly mode: string;
}

function decodeName(bytes: string) {
  try {
    return utf8.decode(Buffer.from(bytes, "latin1"));
  } catch {
    return null;
  }
}

function treeEntries(git: Git, tree: string, name?: string) {
  return Effect.gen(function* () {
    const { stdout } = yield* git([
      "ls-tree",
      "-z",
      tree,
      ...(name === undefined ? [] : ["--", name]),
    ]);
    return yield* sync(() =>
      stdout
        .toString("latin1")
        .split("\0")
        .filter(Boolean)
        .map((record) => {
          const match = /^([0-7]{6}) (?:blob|tree|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
          if (!match || !oid.test(match[2])) throw new Error("Invalid Git tree entry");
          return { mode: match[1], sha: match[2], name: match[3] };
        }),
    );
  });
}

function gitSnapshot(
  git: Git,
  blobs: GitBlobReader,
  commit: Commit,
  segments: string[],
): SnapshotSource {
  const directory = segments.join("/");
  return {
    directory,
    list: () =>
      Effect.gen(function* () {
        let tree = commit.sha;
        for (const segment of segments) {
          const entries = yield* treeEntries(git, tree, segment);
          if (entries.length === 0) return [];
          const [entry] = entries;
          if (
            entries.length !== 1 ||
            decodeName(entry.name) !== segment ||
            entry.mode !== "040000"
          ) {
            return yield* Effect.fail(new Error("Expected a Git tree at the store path"));
          }
          tree = entry.sha;
        }
        return (yield* treeEntries(git, tree))
          .filter(({ name }) => name.endsWith(".md"))
          .map(({ name, mode, sha }) => {
            const decoded = decodeName(name);
            return {
              path: decoded === null ? null : directory + "/" + decoded,
              read: () =>
                decoded === null || (mode !== "100644" && mode !== "100755")
                  ? Effect.fail(new Error("Expected a regular blob with a UTF-8 path"))
                  : blobs.read(sha),
            };
          });
      }),
  };
}

function readCheckoutFile(file: string) {
  return Effect.gen(function* () {
    if (
      !(yield* attempt(() => lstat(file))).isFile() ||
      (yield* attempt(() => realpath(file))) !== file
    ) {
      return yield* Effect.fail(new Error("Expected a regular project file"));
    }
    return yield* Effect.acquireUseRelease(
      attempt(() => open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)),
      (fd) =>
        Effect.gen(function* () {
          const opened = yield* attempt(() => fd.stat());
          const current = yield* attempt(() => lstat(file));
          if (
            !opened.isFile() ||
            opened.size > maxEntryBytes ||
            opened.dev !== current.dev ||
            opened.ino !== current.ino ||
            (yield* attempt(() => realpath(file))) !== file
          ) {
            return yield* Effect.fail(new Error("Expected a bounded project file"));
          }
          const data = Buffer.alloc(opened.size + 1);
          let read = 0;
          while (read < data.length) {
            const { bytesRead } = yield* attempt(() =>
              fd.read(data, read, data.length - read, read),
            );
            if (!bytesRead) break;
            read += bytesRead;
          }
          const after = yield* attempt(() => fd.stat());
          if (
            read !== opened.size ||
            after.mtimeMs !== opened.mtimeMs ||
            after.ctimeMs !== opened.ctimeMs
          ) {
            return yield* Effect.fail(new Error("Project file changed during comparison"));
          }
          return data.subarray(0, read);
        }),
      (fd) => attempt(() => fd.close()),
    );
  });
}

function workingSnapshot(root: string, segments: string[]): SnapshotSource {
  const directory = segments.join("/");
  return {
    directory,
    list: () =>
      Effect.gen(function* () {
        let dir = root;
        for (const segment of segments) {
          dir = join(dir, segment);
          const info = yield* statIfPresent(dir);
          if (!info) return [];
          if (!info.isDirectory() || (yield* attempt(() => realpath(dir))) !== dir) {
            return yield* Effect.fail(new Error("Expected a regular project directory"));
          }
        }
        const names = yield* attempt(() => readdir(dir, { encoding: "latin1" }));
        if ((yield* attempt(() => realpath(dir))) !== dir)
          return yield* Effect.fail(new Error("Project directory changed during comparison"));
        return names
          .filter((name) => name.endsWith(".md"))
          .map((bytes) => {
            const name = decodeName(bytes);
            return {
              path: name === null ? null : directory + "/" + name,
              read: () =>
                name === null
                  ? Effect.fail(new Error("Invalid UTF-8 path"))
                  : readCheckoutFile(join(dir, name)),
            };
          });
      }),
  };
}

export function decodeMemory(bytes: Buffer) {
  const content = utf8.decode(bytes);
  if (content.includes("\0")) throw new Error("Expected text memory");
  return content.replaceAll("\r\n", "\n");
}
