/** Map an OpResult to an opencode custom-tool result. */
import type { OpResult } from "../shared/types.js";

export interface OpenCodeToolResult {
  readonly title?: string;
  readonly output: string;
  readonly metadata?: Record<string, unknown>;
}

export const toOpencodeResult = (title: string, r: OpResult): OpenCodeToolResult => ({
  title,
  output: r.text,
  metadata: { ...r.details, isError: r.isError },
});
