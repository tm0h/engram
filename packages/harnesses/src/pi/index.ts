/**
 * The engram Pi extension.
 *
 * Registers the engram_* tools (LLM-facing) and the /engram dispatcher
 * (human-facing) over the @engram/harnesses shared ops. Everything runs
 * in-process against @engram/core; no CLI binary or network required.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEngramCommand } from "./commands.js";
import { registerEngramTools } from "./tools.js";

export default function engramExtension(pi: ExtensionAPI): void {
  registerEngramTools(pi);
  registerEngramCommand(pi);
}
