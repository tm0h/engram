/**
 * The engram Pi extension.
 *
 * Registers the engram_* tools (LLM-facing) and the /engram dispatcher
 * (human-facing) over the @engram/harnesses shared ops. Everything runs
 * in-process against @engram/core; no CLI binary or network required.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAutoContext } from "./context-hook.js";
import { registerEngramCommand } from "./commands.js";
import { registerEngramTools } from "./tools.js";

export default function engramExtension(pi: ExtensionAPI): void {
  const autoContext = registerAutoContext(pi);
  registerEngramTools(pi, { onWriteSuccess: autoContext.invalidate });
  registerEngramCommand(pi, { onWriteSuccess: autoContext.invalidate });
}
