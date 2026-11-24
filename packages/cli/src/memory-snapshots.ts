import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { ValidationError } from "@engram/core";

const exec = promisify(execFile);
const maxEntryBytes = 1024 * 1024;
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type Commit = { readonly kind: "commit"; readonly sha: string };

interface SnapshotFile {
  readonly path: string | null;
  readonly read: () => Promise<Buffer>;
}

export interface SnapshotSource {
  readonly directory: string;
  readonly list: () => Promise<ReadonlyArray<SnapshotFile>>;
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
    exec("git", ["--literal-pathspecs", "-c", "core.warnAmbiguousRefs=true", ...args], {
      cwd,
      env: gitEnvironment(),
      encoding: "buffer",
      maxBuffer,
      timeout: 10000,
    });
}

type Git = ReturnType<typeof gitAt>;

async function resolveCommit(git: Git, ref: string): Promise<Commit> {
  try {
    const { stdout, stderr } = await git([
      "rev-parse",
      "--verify",
      "--end-of-options",
      ref + "^{commit}",
    ]);
    const sha = stdout.toString().trim();
    if (!oid.test(sha) || stderr.length > 0) throw new Error();
    return { kind: "commit", sha };
  } catch {
    throw new ValidationError({
      message:
        "Cannot resolve a unique commit. Check the refs and ensure their history is available.",
    });
  }
}

async function resolveComparison(git: Git, revision?: string) {
  const [left, separator, right] = revision === undefined ? ["HEAD"] : parseRevision(revision);
  const from = await resolveCommit(git, left);
  if (right === undefined) {
    return { mode: "working-tree", from, to: { kind: "working-tree" } } as const;
  }
  const to = await resolveCommit(git, right);
  if (separator === "..") return { mode: "direct", from, to } as const;
  try {
    const { stdout } = await git(["merge-base", "--all", from.sha, to.sha]);
    const sha = stdout.toString().trim();
    if (!oid.test(sha)) throw new Error();
    return { mode: "merge-base", from: { kind: "commit", sha } as const, to } as const;
  } catch {
    throw new ValidationError({
      message:
        "The range needs one available merge base. Fetch missing history or use an explicit two-dot range.",
    });
  }
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

async function statIfPresent(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function projectPrefix(root: string, cwd: string) {
  const home = await realpath(homedir()).catch(() => homedir());
  // Follow the nearest initialized project, with a repository-root fallback
  // for comparisons before initialization or after deletion of the store.
  const personal = join(home, ".engram");
  if (cwd === personal || cwd.startsWith(personal + sep)) {
    throw new ValidationError({
      message: "Select a Git project directory outside the personal memory store.",
    });
  }
  for (let dir = cwd; dir !== root; dir = dirname(dir)) {
    if (dir === home) continue;
    const memory = join(dir, ".engram");
    const info = await statIfPresent(memory);
    if (info && (!info.isDirectory() || (await statIfPresent(join(memory, "config.json"))))) {
      return relative(root, dir).split(sep);
    }
  }
  if (root === home) {
    throw new ValidationError({
      message: "Select a Git project directory outside the personal memory store.",
    });
  }
  return [];
}

export async function memorySnapshots(cwd: string, revision?: string) {
  const start = await realpath(cwd);
  let root: string;
  try {
    const { stdout } = await gitAt(start)(["rev-parse", "--show-toplevel"]);
    root = await realpath(utf8.decode(stdout).replace(/\n$/, ""));
    const location = relative(root, start);
    if (location === ".." || location.startsWith(".." + sep) || isAbsolute(location)) {
      throw new Error("Working tree outside the current directory");
    }
  } catch {
    throw new ValidationError({ message: "Run engram diff inside a Git working tree." });
  }
  const prefix = await projectPrefix(root, start);
  const segments = [...prefix, ".engram", "engrams"];
  const git = gitAt(root);
  const comparison = await resolveComparison(git, revision);
  const blobs = new GitBlobReader(root, git);
  return {
    close: () => blobs.close(),
    comparison,
    project: prefix.join("/") || ".",
    from: gitSnapshot(git, blobs, comparison.from, segments),
    to:
      comparison.to.kind === "commit"
        ? gitSnapshot(git, blobs, comparison.to, segments)
        : workingSnapshot(root, segments),
  };
}

// One process serves both committed endpoints. Requests are serialized so the
// batch protocol can be parsed incrementally without buffering oversized blobs.
class GitBlobReader {
  private child: ReturnType<typeof spawn> | undefined;
  private iterator: AsyncIterator<Buffer> | undefined;
  private pending = Buffer.alloc(0);
  private queue: Promise<void> = Promise.resolve();
  private cache = new Map<string, Promise<Buffer>>();
  private failed = false;

  constructor(
    private readonly cwd: string,
    private readonly git: Git,
  ) {}

  read(sha: string): Promise<Buffer> {
    const cached = this.cache.get(sha);
    if (cached) return cached;
    const result = this.queue.then(() => this.readBlob(sha));
    this.cache.set(sha, result);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private start() {
    if (this.failed) throw new Error("Git blob reader unavailable");
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

  private async take(size: number) {
    while (this.pending.length < size) {
      const chunk = await this.iterator!.next();
      if (chunk.done) throw new Error("Git batch output ended early");
      this.pending = Buffer.concat([this.pending, chunk.value]);
    }
    const result = this.pending.subarray(0, size);
    this.pending = this.pending.subarray(size);
    return result;
  }

  private async header() {
    while (true) {
      const end = this.pending.indexOf(10);
      if (end >= 0) {
        const line = this.pending.subarray(0, end).toString("ascii");
        this.pending = this.pending.subarray(end + 1);
        return line;
      }
      if (this.pending.length > 256) throw new Error("Invalid Git batch header");
      const chunk = await this.iterator!.next();
      if (chunk.done) throw new Error("Git batch output ended early");
      this.pending = Buffer.concat([this.pending, chunk.value]);
    }
  }

  private async readBlob(sha: string): Promise<Buffer> {
    if (this.failed) return (await this.git(["cat-file", "blob", sha], maxEntryBytes)).stdout;
    const child = this.start();
    const timeout = setTimeout(() => {
      this.failed = true;
      child.kill();
    }, 10000);
    let streamAligned = false;
    try {
      child.stdin!.write(`info ${sha}\n`);
      const info = await this.header();
      streamAligned = true;
      const match = /^([0-9a-f]+) blob ([0-9]+)$/.exec(info);
      if (!match || match[1] !== sha) throw new Error("Blob unavailable");
      const size = Number(match[2]);
      if (!Number.isSafeInteger(size) || size > maxEntryBytes) {
        throw new Error("Blob exceeds size limit");
      }
      streamAligned = false;
      child.stdin!.write(`contents ${sha}\n`);
      if ((await this.header()) !== info) throw new Error("Invalid Git batch response");
      const bytes = await this.take(size);
      if ((await this.take(1))[0] !== 10) throw new Error("Invalid Git batch terminator");
      return bytes;
    } catch (error) {
      if (!streamAligned) {
        // Older Git versions lack --batch-command. A protocol failure also
        // makes the stream unusable, so fall back to bounded individual reads.
        this.failed = true;
        child.kill();
        return (await this.git(["cat-file", "blob", sha], maxEntryBytes)).stdout;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async close() {
    await this.queue;
    this.child?.stdin?.end();
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

async function treeEntries(git: Git, tree: string, name?: string): Promise<TreeEntry[]> {
  const { stdout } = await git([
    "ls-tree",
    "-z",
    tree,
    ...(name === undefined ? [] : ["--", name]),
  ]);
  return stdout
    .toString("latin1")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^([0-7]{6}) (?:blob|tree|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
      if (!match || !oid.test(match[2])) throw new Error("Invalid Git tree entry");
      return { mode: match[1], sha: match[2], name: match[3] };
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
    async list() {
      let tree = commit.sha;
      for (const segment of segments) {
        const entries = await treeEntries(git, tree, segment);
        if (entries.length === 0) return [];
        const [entry] = entries;
        if (entries.length !== 1 || decodeName(entry.name) !== segment || entry.mode !== "040000") {
          throw new Error("Expected a Git tree at the store path");
        }
        tree = entry.sha;
      }
      return (await treeEntries(git, tree))
        .filter(({ name }) => name.endsWith(".md"))
        .map(({ name, mode, sha }) => {
          const decoded = decodeName(name);
          return {
            path: decoded === null ? null : directory + "/" + decoded,
            async read() {
              if (decoded === null || (mode !== "100644" && mode !== "100755")) {
                throw new Error("Expected a regular blob with a UTF-8 path");
              }
              return blobs.read(sha);
            },
          };
        });
    },
  };
}

async function readCheckoutFile(file: string) {
  // Refuse symlinks and nonregular files, and verify the descriptor still
  // matches the checked path before reading anything through it.
  if (!(await lstat(file)).isFile() || (await realpath(file)) !== file) {
    throw new Error("Expected a regular project file");
  }
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await fd.stat();
    const current = await lstat(file);
    if (
      !opened.isFile() ||
      opened.size > maxEntryBytes ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      (await realpath(file)) !== file
    )
      throw new Error("Expected a bounded project file");

    const data = Buffer.alloc(opened.size + 1);
    let read = 0;
    while (read < data.length) {
      const { bytesRead } = await fd.read(data, read, data.length - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    const after = await fd.stat();
    if (
      read !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error("Project file changed during comparison");
    }
    return data.subarray(0, read);
  } finally {
    await fd.close();
  }
}

function workingSnapshot(root: string, segments: string[]): SnapshotSource {
  const directory = segments.join("/");
  return {
    directory,
    async list() {
      let dir = root;
      for (const segment of segments) {
        dir = join(dir, segment);
        const info = await statIfPresent(dir);
        if (!info) return [];
        if (!info.isDirectory() || (await realpath(dir)) !== dir) {
          throw new Error("Expected a regular project directory");
        }
      }
      const names = await readdir(dir, { encoding: "latin1" });
      if ((await realpath(dir)) !== dir)
        throw new Error("Project directory changed during comparison");
      return names
        .filter((name) => name.endsWith(".md"))
        .map((bytes) => {
          const name = decodeName(bytes);
          return {
            path: name === null ? null : directory + "/" + name,
            read: () => {
              if (name === null) throw new Error("Invalid UTF-8 path");
              return readCheckoutFile(join(dir, name));
            },
          };
        });
    },
  };
}

export function decodeMemory(bytes: Buffer) {
  const content = utf8.decode(bytes);
  if (content.includes("\0")) throw new Error("Expected text memory");
  return content.replaceAll("\r\n", "\n");
}
