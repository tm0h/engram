export type Decision = { action: "answer" | "change" | "clarify"; value: string };

type Memory = { title: string; body: string; pinned?: boolean; trigger?: string };

export interface Task {
  id: string;
  prompt: string;
  files: Record<string, string>;
  inspect: readonly string[];
  expected: Decision;
  memories: readonly Memory[];
  relevant: readonly string[];
  stale?: readonly string[];
}

function task(
  id: string,
  prompt: string,
  file: string,
  content: string,
  value: string,
  memory: Memory,
  options: {
    answer?: boolean;
    sourceRequired?: boolean;
    stale?: string;
    irrelevant?: boolean;
  } = {},
): Task {
  return {
    id,
    prompt,
    files: { [file]: content, "README.md": "Synthetic service fixture." },
    inspect: options.sourceRequired === false ? [] : [file],
    expected: { action: options.answer ? "answer" : "change", value },
    memories: [memory],
    relevant: options.irrelevant ? [] : [memory.title],
    stale: options.stale ? [options.stale] : undefined,
  };
}

const releasePrompt = "Which command runs the Quartz release? Do not run it.";
const releaseMemory = {
  title: "Quartz release command",
  body: "Use pnpm release:quartz. The release workflow is .github/workflows/release.yml.",
  pinned: true,
  trigger: releasePrompt,
};

export const corpus: readonly Task[] = [
  task(
    "release-agrees",
    releasePrompt,
    ".github/workflows/release.yml",
    "steps:\n  - run: pnpm release:quartz",
    "pnpm release:quartz",
    releaseMemory,
    { answer: true },
  ),
  task(
    "release-contradicts",
    releasePrompt,
    ".github/workflows/release.yml",
    "steps:\n  - run: pnpm publish:quartz",
    "pnpm publish:quartz",
    releaseMemory,
    { answer: true, stale: "pnpm release:quartz" },
  ),
  task(
    "release-preview",
    "Propose the command for an Alder preview deployment.",
    "scripts/preview.sh",
    "#!/bin/sh\npnpm deploy:preview",
    "pnpm deploy:preview",
    {
      title: "Alder preview deployment",
      body: "The preview command is pnpm deploy:preview.",
      pinned: true,
    },
  ),
  task(
    "release-test",
    "Which command runs the Lark migration tests?",
    "package.json",
    '{"scripts":{"test:migrations":"vitest run migrations","migrate":"node apply.js"}}',
    "pnpm test:migrations",
    {
      title: "Lark migration tests",
      body: "Run pnpm test:migrations. Do not apply migrations.",
    },
    { answer: true },
  ),
  task(
    "boundary-notification",
    "Choose the module for new Cedar notification delivery.",
    "docs/boundaries.md",
    "Outbound Cedar notifications belong in src/adapters/notify.ts.",
    "src/adapters/notify.ts",
    {
      title: "Cedar notification boundary",
      body: "Place notification delivery in src/adapters/notify.ts.",
    },
  ),
  task(
    "boundary-parser",
    "Choose the module for the Elm pure parser.",
    "docs/architecture.md",
    "Elm parsing stays in src/domain/parse.ts. The HTTP layer delegates to it.",
    "src/domain/parse.ts",
    {
      title: "Elm pure parser",
      body: "Put the pure parser in src/domain/parse.ts rather than HTTP handlers.",
      pinned: true,
    },
  ),
  task(
    "boundary-scoped-exception",
    "Choose the database module for the Cypress worker.",
    "workers/cypress/README.md",
    "Cypress's offline worker exclusively uses workers/cypress/local-db.ts.",
    "workers/cypress/local-db.ts",
    {
      title: "Cypress database module",
      body: "Use src/shared/db.ts for server jobs. Offline workers have their own documented exceptions.",
      pinned: true,
    },
    { stale: "src/shared/db.ts" },
  ),
  task(
    "boundary-clock",
    "Which clock abstraction should Dune retry logic use?",
    "src/time.ts",
    "export const Clock = { now: () => Date.now() }; // Inject Clock in retry logic",
    "Clock",
    { title: "Dune retry clock", body: "Inject the Clock abstraction in retry logic." },
    { answer: true },
  ),
  task(
    "dependency-color",
    "Choose the approved dependency for Orchid terminal colors.",
    "docs/dependencies.md",
    "Approved: chalk. Rejected: colors.",
    "chalk",
    { title: "Orchid terminal colors", body: "Use chalk. The colors package was rejected." },
  ),
  task(
    "dependency-uuid",
    "Choose the approved API for Birch UUID creation.",
    "docs/runtime.md",
    "Use crypto.randomUUID() for new IDs. Do not install uuid.",
    "crypto.randomUUID()",
    {
      title: "Birch UUID creation",
      body: "Choose crypto.randomUUID() over the uuid dependency.",
      pinned: true,
    },
  ),
  task(
    "dependency-validation",
    "Choose the active validator for Sable request schemas.",
    "src/validate.ts",
    "import { z } from 'zod'; // Sable's supported request validator",
    "zod",
    {
      title: "Sable request validator",
      body: "Use valibot for Sable request schemas.",
      pinned: true,
    },
    { stale: "valibot" },
  ),
  task(
    "dependency-datetime",
    "Choose the approved API for Aster date formatting.",
    "docs/dependencies.md",
    "Approved: Intl.DateTimeFormat. Rejected: moment.",
    "Intl.DateTimeFormat",
    {
      title: "Aster date formatting",
      body: "Use Intl.DateTimeFormat for date formatting.",
    },
  ),
  task(
    "location-migrations",
    "Choose the directory for new Harbor SQL migrations.",
    "drizzle.config.ts",
    "export default { out: 'db/changes' };",
    "db/changes",
    { title: "Harbor SQL migrations", body: "Place SQL migrations in db/changes." },
  ),
  task(
    "location-fixtures",
    "Choose the directory for new Spruce parser fixtures.",
    "test/parser.test.ts",
    "const fixtureDir = 'test/data/spruce';",
    "test/data/spruce",
    {
      title: "Spruce parser fixtures",
      body: "Keep parser fixtures in test/data/spruce.",
      pinned: true,
    },
  ),
  task(
    "location-assets",
    "Choose the directory for generated Fern schemas.",
    "scripts/generate.ts",
    "const generatedDir = 'src/generated/fern';",
    "src/generated/fern",
    { title: "Fern schema output", body: "Write generated Fern schemas into src/generated/fern." },
  ),
  task(
    "location-near-match",
    "Which directory stores Maple thumbnail snapshots?",
    "test/snapshots.ts",
    "const thumbnailSnapshots = 'test/images/maple';",
    "test/images/maple",
    {
      title: "Maple database snapshots",
      body: "Store Maple database snapshots in db/snapshots.",
      pinned: true,
    },
    { answer: true, irrelevant: true },
  ),
  task(
    "debug-queue",
    "Propose the retry limit for the stalled Violet queue.",
    "logs/queue.log",
    "worker: retries exhausted; see the project recovery decision",
    "4",
    {
      title: "Violet queue retry limit",
      body: "The approved Violet queue recovery setting is 4 retries.",
      trigger: "Propose the retry limit for the stalled Violet queue.",
    },
  ),
  task(
    "debug-cache",
    "Propose the TTL in seconds for the flaky Rowan cache.",
    "logs/cache.log",
    "Rowan cache expired early; existing TTL is unset.",
    "900",
    {
      title: "Rowan cache TTL",
      body: "The Rowan cache recovery TTL is 900 seconds.",
      pinned: true,
      trigger: "Propose the TTL in seconds for the flaky Rowan cache.",
    },
  ),
  task(
    "debug-header",
    "Which header diagnoses the Amber proxy loop?",
    "logs/proxy.log",
    "Amber detected a proxy loop; inspect the deployment diagnostic header.",
    "X-Amber-Hop",
    {
      title: "Amber proxy loop",
      body: "Inspect X-Amber-Hop when debugging the Amber proxy loop.",
      trigger: "Which header diagnoses the Amber proxy loop?",
    },
    { answer: true },
  ),
  {
    id: "debug-conflicting-sources",
    prompt: "Propose the port for the Indigo indexer.",
    files: {
      "compose.yml": "services:\n  indexer:\n    ports: [8120]",
      "deploy/indexer.yml": "service: indexer\nport: 8121",
    },
    inspect: ["compose.yml", "deploy/indexer.yml"],
    expected: { action: "clarify", value: "8120|8121" },
    memories: [
      { title: "Indigo indexer port", body: "Indigo uses 8120. See compose.yml.", pinned: true },
      {
        title: "Indigo deploy port",
        body: "Indigo uses 8121. See deploy/indexer.yml.",
        pinned: true,
      },
    ],
    relevant: ["Indigo indexer port", "Indigo deploy port"],
  },
];

export const distractor = {
  title: "Juniper documentation policy",
  body: "Keep the Juniper team glossary in docs/glossary.md.",
  pinned: true,
};
