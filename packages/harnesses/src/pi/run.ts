/** Pi-specific mapping of OpResults; runOp lives in shared now. */
export { runOp, type OpEffect } from "../shared/run.js";
import type { OpResult } from "../shared/types.js";

/** Map an OpResult to a pi tool result (D16: isError for genuine failures). */
export const toToolResult = (r: OpResult) => ({
  content: [{ type: "text" as const, text: r.text }],
  isError: r.isError,
  details: r.details,
});
