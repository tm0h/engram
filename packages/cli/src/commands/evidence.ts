import { execFile } from "node:child_process";
import { constants, open, realpath, stat as statFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect, Option } from "effect";
import {
  correctionBaseline,
  effectiveStatus,
  EngramStore,
  enqueuePendingCandidate,
  parseRepositoryReference,
  scanContent,
  ValidationError,
} from "@engram/core";
import { out } from "../io.js";

const maxBytes = 64 * 1024;
const exec = promisify(execFile);

async function git(root: string, ...args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const { stdout } = await exec("git", ["--literal-pathspecs", ...args], {
    cwd: root,
    env: { ...env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" },
    maxBuffer: maxBytes,
    timeout: 2000,
    encoding: "buffer",
  });
  return stdout;
}

async function committedFile(root: string, revision: string, path: string) {
  const commit = (await git(root, "rev-parse", "--verify", revision + "^{commit}"))
    .toString()
    .trim();
  if (commit !== revision) throw new Error("Expected an exact commit");
  const entry = (await git(root, "ls-tree", "-z", revision, "--", path)).toString();
  const match = /^100(?:644|755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/.exec(entry);
  if (!match || match[2] !== path) throw new Error("Expected a tracked regular file");
  return git(root, "cat-file", "blob", match[1]);
}

async function checkoutFile(root: string, path: string) {
  const file = join(root, path);
  if ((await realpath(file)) !== file) throw new Error("Symbolic links are not evidence");
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    const resolved = await realpath(file);
    const atPath = await statFile(file);
    if (
      !stat.isFile() ||
      stat.size > maxBytes ||
      resolved !== file ||
      stat.dev !== atPath.dev ||
      stat.ino !== atPath.ino
    )
      throw new Error("Expected a bounded repository file");
    const buffer = Buffer.alloc(maxBytes + 1);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await fd.read(buffer, read, buffer.length - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    if (read > maxBytes) throw new Error("Repository file exceeded limit");
    return buffer.subarray(0, read);
  } finally {
    await fd.close();
  }
}

function text(bytes: Buffer) {
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(decoded))
    throw new Error("Expected text evidence");
  return decoded;
}

async function convertsLineEndings(root: string, path: string) {
  // Read settings only. Git clean filters may execute repository-configured programs.
  const attributes = (await git(root, "check-attr", "-z", "text", "eol", "--", path))
    .toString()
    .split("\0");
  const [, , textAttr, , , eol] = attributes;
  if (textAttr === "unset") return false;
  if (textAttr === "set" || textAttr === "auto" || eol === "lf" || eol === "crlf") return true;
  try {
    return /^(?:true|yes|on|[1-9][0-9]*|input)$/i.test(
      (await git(root, "config", "--get", "core.autocrlf")).toString().trim(),
    );
  } catch {
    return false;
  }
}

function comparableCheckout(committed: string, checkout: string, convert: boolean) {
  // A historical blob may intentionally contain CRLF. Keep its bytes authoritative.
  return convert && !committed.includes("\r\n") ? checkout.replaceAll("\r\n", "\n") : checkout;
}

function excerpt(body: string, fullText = body) {
  return scanContent(fullText).length || (body !== fullText && scanContent(body).length)
    ? { text: null, truncated: false }
    : { text: body.slice(0, 4096), truncated: body.length > 4096 };
}

function changedLines(before: string, after: string, checkoutText: string) {
  const old = before.split("\n");
  const next = after.split("\n");
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  let end = 0;
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - 1 - end] === next[next.length - 1 - end]
  )
    end++;
  return {
    line: start + 1,
    reviewed: excerpt(old.slice(start, old.length - end).join("\n"), before),
    checkout: excerpt(next.slice(start, next.length - end).join("\n"), checkoutText),
  };
}

const unavailable = (reason: string) => ({ status: "unavailable", reason }) as const;

async function review(
  root: string,
  source: NonNullable<ReturnType<typeof parseRepositoryReference>>,
) {
  try {
    root = await realpath(root);
    if ((await git(root, "rev-parse", "--show-toplevel")).toString().trimEnd() !== root)
      return unavailable("project_is_not_repository_root");
  } catch {
    return unavailable("repository_unavailable");
  }

  let before: string;
  try {
    before = text(await committedFile(root, source.revision, source.path));
  } catch {
    return unavailable("reviewed_file_unavailable");
  }

  let checkout: string;
  let convert = false;
  try {
    checkout = text(await checkoutFile(root, source.path));
    if (checkout.includes("\r\n")) convert = await convertsLineEndings(root, source.path);
  } catch {
    return unavailable("checkout_file_unavailable");
  }
  const after = comparableCheckout(before, checkout, convert);
  if (before === after) return { status: "unchanged" } as const;

  // Before staging a correction, anchor the reviewed checkout to immutable bytes.
  let checkoutRevision: string | null = null;
  try {
    const head = (await git(root, "rev-parse", "--verify", "HEAD")).toString().trim();
    if (/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) {
      const committed = text(await committedFile(root, head, source.path));
      if (committed === comparableCheckout(committed, checkout, convert)) checkoutRevision = head;
    }
  } catch {
    // The working tree still provides evidence for inspection.
  }
  return {
    status: "changed",
    change: changedLines(before, after, checkout),
    checkoutRevision,
  } as const;
}

export const evidenceCommand = (id: string, opts: { json?: boolean; propose?: string }) =>
  Effect.gen(function* () {
    const store = yield* EngramStore;
    const root = yield* store.projectRoot();
    if (Option.isNone(root))
      return yield* Effect.fail(
        new ValidationError({ message: "Initialize the project with engram init." }),
      );
    const entry = yield* store.get("project", id);
    const ref =
      entry.sourceType === "file" ? parseRepositoryReference(entry.sourceRef ?? "") : undefined;
    const evidence = ref
      ? yield* Effect.promise(() => review(root.value, ref))
      : unavailable(
          entry.sourceType === "file" ? "missing_or_invalid_reviewed_revision" : "not_file_backed",
        );
    const base = {
      schemaVersion: 1,
      id: entry.id,
      title: excerpt(entry.title),
      claim: excerpt(entry.body),
      source: ref && !scanContent(ref.path).length ? ref : null,
      ...evidence,
    };
    if (opts.propose !== undefined) {
      const body = opts.propose.trim();
      if (
        effectiveStatus(entry, Date.now()) !== "active" ||
        !body ||
        !ref ||
        evidence.status !== "changed" ||
        evidence.checkoutRevision === null
      ) {
        return yield* Effect.fail(
          new ValidationError({
            message:
              "Staging requires an active memory, a replacement claim, and changed source bytes committed in the current checkout.",
          }),
        );
      }
      const candidate = yield* enqueuePendingCandidate({
        scope: "project",
        proposed: { title: entry.title, type: entry.type, tags: entry.tags, body },
        provenanceClass: "file",
        sourceExcerpt: "Repository source changed since the previous review.",
        correction: {
          originalId: entry.id,
          originalDigest: correctionBaseline(entry),
          sourceRef: `git:${evidence.checkoutRevision}:${ref.path}`,
        },
        duplicates: [],
        conflicts: [],
      });
      yield* out(
        opts.json
          ? JSON.stringify({ ...base, pendingId: candidate.id })
          : `Staged project:${candidate.id}. Preview with engram pending approve ${candidate.id} --dry-run.`,
      );
      return;
    }
    if (opts.json) {
      yield* out(JSON.stringify(base));
      return;
    }
    yield* out(
      `Project memory ${entry.id} — ${evidence.status}\nClaim: ${JSON.stringify(base.claim)}`,
    );
    if (base.source) yield* out(`Reviewed source: ${JSON.stringify(base.source)}`);
    if (evidence.status === "unavailable") yield* out(evidence.reason);
    if (evidence.status === "changed") {
      yield* out("Source text changed. Review the claim against the evidence.");
      yield* out(
        `From line ${evidence.change.line}\nReviewed: ${JSON.stringify(evidence.change.reviewed)}\nCheckout: ${JSON.stringify(evidence.change.checkout)}`,
      );
    }
  });
