// Install the reference packages outside the workspace. See docs/context-token-budget.md.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  countContextTokens,
  renderBudgetedContext,
} from "../packages/harnesses/src/shared/context-budget.ts";

const reference = createRequire(resolve(process.argv[2], "package.json"));
const { getEncoding } = reference("js-tiktoken");
const { countTokens: countClaude } = reference("@anthropic-ai/tokenizer");
const o200k = getEncoding("o200k_base");
const cl100k = getEncoding("cl100k_base");

const fixtures = {
  prose: "Keep project memory local. Run the release checks before updating the lockfile.",
  code: [
    "Use the checked-in migration runner:",
    "",
    "```ts",
    "const env = process.env.NODE_ENV;",
    'if (env === "test") await migrate({ dryRun: true });',
    "```",
  ].join("\n"),
  multilingual: "تهران، دسترسی محلی. 東京で同期する。 café, e\u0301, 🧑🏽‍💻, 👩‍🚀, 𐐀.",
  compatibility: "ﷺ㌖Ⅷ㍿㋿".repeat(12),
  unbroken: "x".repeat(4096),
};

const measure = (text) => {
  const accounted = countContextTokens(text);
  return {
    accounted,
    o200k: o200k.encode(text).length,
    cl100k: cl100k.encode(text).length,
    claude: countClaude(text),
  };
};

const rows = Object.entries(fixtures).flatMap(([name, body], index) =>
  [512, 4000].map((tokens) => {
    const digest = renderBudgetedContext(
      [
        {
          id: String(index + 1).padStart(4, "0"),
          scope: "project",
          type: "decision",
          title: `Fixture: ${name}`,
          created: "2026-01-01T00:00:00Z",
          updated: "2026-01-01T00:00:00Z",
          tags: ["test"],
          pinned: true,
          aliases: [],
          body,
        },
      ],
      {
        tokens,
        scopes: ["project", "personal"],
        full: true,
        omittedFiles: 2,
        duplicateIds: 1,
        trailingNewline: true,
      },
    );
    const row = measure(digest.text + "\n");
    if (row.accounted !== digest.budget.used || row.accounted > tokens) {
      throw new Error(`Budget accounting mismatch on ${name}/${tokens}`);
    }
    return { name, tokens, ...row };
  }),
);

console.table(rows);
for (const tokenizer of ["o200k", "cl100k", "claude"]) {
  const differences = rows.map((row) => row.accounted - row[tokenizer]);
  const ratios = rows.map((row) => row.accounted / row[tokenizer]);
  console.log(
    `${tokenizer}: max overcount ${Math.max(...differences)}; ` +
      `max undercount ${Math.max(0, -Math.min(...differences))}; max ratio ${Math.max(...ratios).toFixed(2)}x`,
  );
}
