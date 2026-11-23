import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import {
  ENGRAM_TYPES,
  SUPPORTED_ENTRY_SCHEMA_VERSION,
  packEntryPath,
  packSlug,
  parseTimestamp,
  scanContent,
  type ImportProposal,
} from "@engram/core";

const maxFileBytes = 256 * 1024;
const maxProposalBytes = 8 * 1024;
const slug = z
  .string()
  .regex(packSlug)
  .refine((value) => !scanContent(value).length);
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: slug,
  version: z.number().int().min(1).max(999_999_999),
  entries: z
    .array(z.strictObject({ id: slug, file: z.string() }))
    .min(1)
    .max(50),
});
const timestamp = z.string().refine((value) => parseTimestamp(value) !== undefined);
const entrySchema = z.strictObject({
  schemaVersion: z.literal(SUPPORTED_ENTRY_SCHEMA_VERSION),
  type: z.enum(ENGRAM_TYPES),
  title: z
    .string()
    .trim()
    .min(1)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u),
  body: z
    .string()
    .trim()
    .min(1)
    .transform((value) => value.replace(/\r\n?/g, "\n")),
  status: z.literal("active").optional(),
  reviewAfter: timestamp.optional(),
  expires: timestamp.optional(),
});

type PackInput =
  | { proposal: ImportProposal }
  | {
      path: string;
      entryId?: string;
      packName?: string;
      packVersion?: number;
      status: "failed" | "rejected";
      reason: string;
    };

class PackReadError extends Error {}

const reportReadError = (error: unknown) =>
  error instanceof PackReadError ? error.message : "source_unavailable";

async function readPackJson(root: string, file: string): Promise<unknown> {
  const target = path.join(root, file);
  // The root is canonical and file is a validated relative path. Checking
  // the resolved target also rejects symlinked intermediate directories.
  if ((await realpath(target)) !== target) throw new PackReadError("symlink_source");
  const initial = await lstat(target);
  if (!initial.isFile()) throw new PackReadError("not_regular_file");
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new PackReadError("not_regular_file");
    if (
      initial.dev !== info.dev ||
      initial.ino !== info.ino ||
      (await realpath(target)) !== target
    ) {
      throw new PackReadError("source_changed");
    }
    if (info.size > maxFileBytes) throw new PackReadError("file_too_large");
    const buffer = Buffer.allocUnsafe(maxFileBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxFileBytes) throw new PackReadError("file_too_large");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    } catch {
      throw new PackReadError("invalid_utf8");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new PackReadError("malformed_json");
    }
  } finally {
    await handle.close();
  }
}

const readPackInputs = async (
  name: string,
  configured: string | undefined,
): Promise<PackInput[]> => {
  const manifestFile = "pack.json";
  const manifestError = (reason: string): PackInput[] => [
    { path: manifestFile, status: "failed", reason },
  ];
  if (!slug.safeParse(name).success) return manifestError("invalid_pack_name");
  if (!configured) return manifestError("pack_directory_required");
  if (!path.isAbsolute(configured)) return manifestError("pack_directory_must_be_absolute");

  let root: string;
  let manifest: z.output<typeof manifestSchema>;
  try {
    root = path.join(await realpath(configured), name);
    const info = await lstat(root);
    if (info.isSymbolicLink()) return manifestError("symlink_source");
    if (!info.isDirectory()) return manifestError("pack_not_directory");
    const decoded = manifestSchema.safeParse(await readPackJson(root, manifestFile));
    if (!decoded.success) return manifestError("invalid_manifest");
    manifest = decoded.data;
  } catch (error) {
    return manifestError(reportReadError(error));
  }
  if (manifest.name !== name) return manifestError("pack_name_mismatch");
  if (new Set(manifest.entries.map(({ id }) => id)).size !== manifest.entries.length)
    return manifestError("duplicate_entry_id");

  const results: PackInput[] = [];
  for (const { id, file } of manifest.entries) {
    const identity = { entryId: id, packName: name, packVersion: manifest.version };
    if (
      file === manifestFile ||
      file.length > 240 ||
      !packEntryPath.test(file) ||
      scanContent(file).length
    ) {
      results.push({
        path: "[invalid path]",
        ...identity,
        status: "rejected",
        reason: "unsafe_entry_path",
      });
      continue;
    }
    const location = { path: file, ...identity };
    try {
      const entry = entrySchema.safeParse(await readPackJson(root, file));
      if (!entry.success) {
        results.push({ ...location, status: "rejected", reason: "invalid_pack_entry" });
        continue;
      }
      const { title, body, type, expires, reviewAfter } = entry.data;
      const expiry = expires === undefined ? undefined : parseTimestamp(expires);
      const review = reviewAfter === undefined ? undefined : parseTimestamp(reviewAfter);
      if (
        expiry !== undefined &&
        (expiry <= Date.now() || (review !== undefined && review > expiry))
      ) {
        results.push({ ...location, status: "rejected", reason: "invalid_pack_lifecycle" });
        continue;
      }
      if (Buffer.byteLength(title + body) > maxProposalBytes) {
        results.push({ ...location, status: "failed", reason: "candidate_too_large" });
        continue;
      }
      if (body.includes("\0")) {
        results.push({ ...location, status: "rejected", reason: "invalid_pack_entry" });
        continue;
      }
      const fields = {
        title,
        body,
        type,
        ...(reviewAfter === undefined ? {} : { reviewAfter }),
        ...(expires === undefined ? {} : { expires }),
      };
      const digest = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
      results.push({
        proposal: {
          ...fields,
          source: {
            format: "pack",
            path: file,
            entryId: id,
            name,
            version: manifest.version,
            digest,
          },
        },
      });
    } catch (error) {
      results.push({ ...location, status: "failed", reason: reportReadError(error) });
    }
  }
  return results;
};

export const loadPack = (name: string) =>
  Effect.promise(() => readPackInputs(name, process.env.ENGRAM_PACK_DIR));
