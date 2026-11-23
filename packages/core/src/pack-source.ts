import { Schema } from "effect";
import type { Engram } from "./domain.js";

export const packSlug = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const packEntryPath = /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.json$/;
const slug = Schema.String.check(Schema.isPattern(packSlug));
const version = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999_999 }));

export const PackImportSource = Schema.Struct({
  format: Schema.Literal("pack"),
  path: Schema.String.check(Schema.isPattern(packEntryPath), Schema.isMaxLength(240)),
  name: slug,
  version,
  entryId: slug,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});

export type PackImportSource = typeof PackImportSource.Type;
type PackIdentity = Pick<PackImportSource, "name" | "version" | "entryId" | "digest">;

export const samePackEntry = (a: PackIdentity, b: PackIdentity) =>
  a.name === b.name && a.entryId === b.entryId;

export const packSourceRef = ({ name, version, entryId, digest }: PackIdentity) =>
  `pack:${name}@${version}/${entryId}#${digest}`;

export const packRejectionFile = ({ name, version, entryId, digest }: PackIdentity) =>
  `pack-rejected.${name}.${version}.${entryId}.${digest}`;

const parseIdentity = (match: RegExpExecArray | null): PackIdentity | undefined =>
  match
    ? { name: match[1], version: Number(match[2]), entryId: match[3], digest: match[4] }
    : undefined;

export const parsePackRejection = (file: string) =>
  parseIdentity(
    /^pack-rejected\.([a-z0-9][a-z0-9-]{0,63})\.([1-9]\d{0,8})\.([a-z0-9][a-z0-9-]{0,63})\.([a-f0-9]{64})$/.exec(
      file,
    ),
  );

export const canonicalPackSource = (entry: Engram) =>
  entry.sourceType === "file" && entry.sourceRef
    ? parseIdentity(
        /^pack:([a-z0-9][a-z0-9-]{0,63})@([1-9]\d{0,8})\/([a-z0-9][a-z0-9-]{0,63})#([a-f0-9]{64})$/.exec(
          entry.sourceRef,
        ),
      )
    : undefined;
