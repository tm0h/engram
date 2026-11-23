import type { ImportFormat, ImportProposal } from "@engram/core";

export const DIGEST_ID = "engram-memory-digest";
export const DIGEST_BEGIN = "<!-- BEGIN: " + DIGEST_ID + " -->";
export const DIGEST_END = "<!-- END: " + DIGEST_ID + " -->";

const conventionHeading =
  /^(?:conventions|coding (?:style|standards|conventions)|style guide|development conventions|project conventions|repository guidelines|guidelines)$/i;

export function supportedImportFormat(
  format: string | undefined,
  path: string,
): ImportFormat | undefined {
  const filename = path.split("/").at(-1)?.toLowerCase();
  if (format === "hermes")
    return filename === "memory.md" || filename === "user.md" ? format : undefined;
  if (format === "openclaw") {
    return filename === "memory.md" ||
      filename === "user.md" ||
      /(?:^|\/)memory\/\d{4}-\d{2}-\d{2}(?:-[\w-]+)?\.md$/i.test(path)
      ? format
      : undefined;
  }
  let detected: ImportFormat | undefined;
  if (filename === "agents.md") detected = "agents";
  if (filename === "claude.md") detected = "claude";
  if (filename === "readme.md") detected = "readme";
  if (filename === ".cursorrules" || /(?:^|\/)\.cursor\/rules\/.+\.mdc$/i.test(path))
    detected = "cursor";
  return !format || format === detected ? detected : undefined;
}

const managedMarker = /^<!-- (BEGIN|END): (engram-[\w-]+) -->$/;
const heading = /^ {0,3}(#{1,6})[\t ]+(\S.*)$/;
const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function closesFence(open: string, delimiter: RegExpExecArray): boolean {
  return delimiter[1][0] === open[0] && delimiter[1].length >= open.length && !delimiter[2].trim();
}

/** Refuse to interpret marker-shaped user examples as a managed section. */
export function hasUnsafeDigestSection(text: string): boolean {
  let inFence: string | undefined;
  let inDigest = false;
  for (const line of text.split("\n")) {
    if (line.includes(DIGEST_ID) && /<!--.*(?:BEGIN|END)/i.test(line)) {
      const marker = line.trim();
      if (
        inFence ||
        !/^ {0,3}<!--/.test(line) ||
        (marker !== DIGEST_BEGIN && marker !== DIGEST_END)
      )
        return true;
      inDigest = marker === DIGEST_BEGIN;
      continue;
    }
    if (inDigest) continue;
    const delimiter = fence.exec(line);
    if (!delimiter) continue;
    if (!inFence) inFence = delimiter[1];
    else if (closesFence(inFence, delimiter)) inFence = undefined;
  }
  return inFence !== undefined;
}

export function parseImportMarkdown(
  text: string,
  format: ImportFormat,
  path: string,
): ImportProposal[] | undefined {
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const results: ImportProposal[] = [];
  const isProfile = /(?:^|\/)user\.md$/i.test(path);
  const type =
    format === "hermes" || format === "openclaw" ? (isProfile ? "preference" : "note") : "decision";
  const fallback =
    format === "cursor"
      ? path
          .split("/")
          .at(-1)!
          .replace(/\.mdc$/i, "")
      : {
          agents: "Agent conventions",
          claude: "Claude conventions",
          readme: "Conventions",
          hermes: "Hermes memory",
          openclaw: "OpenClaw memory",
        }[format];
  let cursorMetadata = "";
  const add = (title: string, body: string[], line: number) => {
    const content = body.join("\n").trim();
    if (content) {
      results.push({ source: { format, path, line }, title, body: cursorMetadata + content, type });
    }
  };

  if (format === "hermes") {
    let first = 0;
    for (let i = 0; i <= lines.length; i++) {
      if (i !== lines.length && !(i > 0 && i < lines.length - 1 && lines[i] === "§")) continue;
      const body = lines.slice(first, i);
      const offset = body.findIndex((line) => line.trim() !== "");
      if (offset >= 0)
        add(
          isProfile ? Array.from(body[offset].trim()).slice(0, 72).join("") : fallback,
          body,
          first + offset + 1,
        );
      first = i + 1;
    }
    return results;
  }

  const isMdc = format === "cursor" && path.toLowerCase().endsWith(".mdc");
  let start = 0;
  if (lines[0].trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (end < 0) return undefined;
    start = end + 1;
    if (isMdc && end > 1) {
      const quoted = lines
        .slice(1, end)
        .map((line) => "> " + line)
        .join("\n");
      cursorMetadata = "Cursor rule activation metadata:\n" + quoted + "\n\n";
    }
  } else if (isMdc) {
    return undefined;
  }

  let title = fallback;
  let titleLine = start + 1;
  let body: string[] = [];
  let conventionDepth = 0;
  let inFence: string | undefined;
  let managedId: string | undefined;
  const flush = () => {
    if (format !== "readme" || conventionDepth) add(title, body, titleLine);
    body = [];
  };
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const delimiter = fence.exec(line);
    if (!inFence) {
      const marker = managedMarker.exec(line.trim());
      if (marker) {
        if (marker[1] === "BEGIN" && managedId === undefined) managedId = marker[2];
        else if (marker[1] === "END" && managedId === marker[2]) managedId = undefined;
        else return undefined;
        continue;
      }
      if (managedId) continue;

      const parsed = heading.exec(line);
      if (parsed) {
        flush();
        const depth = parsed[1].length;
        title = parsed[2].replace(/[\t ]+#+[\t ]*$/, "").trim();
        titleLine = i + 1;
        if (format === "readme") {
          if (conventionDepth && depth <= conventionDepth) conventionDepth = 0;
          if (!conventionDepth && conventionHeading.test(title)) conventionDepth = depth;
        }
        continue;
      }
      if (delimiter) inFence = delimiter[1];
    } else if (delimiter && closesFence(inFence, delimiter)) {
      inFence = undefined;
    }
    body.push(line);
  }
  if (managedId) return undefined;
  flush();
  return results;
}
