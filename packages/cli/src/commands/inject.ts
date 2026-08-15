/** `engram inject` — print the agent-injection snippet for a system prompt. */
import { Effect } from "effect";
import chalk from "chalk";
import { injectSnippet } from "@engram/core";
import { out } from "../io.js";

export const injectCommand = () =>
  Effect.gen(function* () {
    chalk.level = 0; // plain text, for copy/paste
    yield* out(injectSnippet());
  });
