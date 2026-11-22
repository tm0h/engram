import type { CorpusCase, LoadedCorpus } from "@engram/core/corpus";

const mothlightCases: ReadonlyArray<readonly [id: string, query: string, requiredId?: string]> = [
  ["buy-cdn-domain", "can we purchase a custom domain for the CDN alias"],
  ["coedit-websocket", "can our team edit together over the dev server websocket"],
  ["thumbnail-encryption", "does the image cache encrypt thumbnail files"],
  ["preview-robots", "are preview hosts excluded by the robots file", "01jwq3vvf0000000000000002n"],
  [
    "websocket-restart",
    "why does the dev server websocket reconnect after restart",
    "01jwq06nf0000000000000000n",
  ],
  [
    "thumbnail-retention",
    "how long does the image cache keep old thumbnails",
    "01jwq1jkq0000000000000001d",
  ],
];

const skylarkCases: typeof mothlightCases = [
  ["domain-purchase-policy", "can I buy a custom domain from Skylark", "0001"],
  ["shared-draft-policy", "does Skylark support collaborative editing of drafts", "0002"],
  ["hostname-setup", "where do I enter an existing custom domain in Skylark", "0001"],
  ["draft-history", "does Skylark keep a history of who changed each draft"],
];

const skylarkNotes = [
  {
    id: "0001",
    title: "Skylark custom domain setup",
    body: "Skylark only accepts hostnames you already own. Get a new name through an independent DNS provider first. Enter the existing custom domain under Settings, Hostnames.",
  },
  {
    id: "0002",
    title: "Skylark shared drafts",
    body: "Two teammates can change the same draft at once. Each sees the other person's changes as they type.",
  },
];

function label([id, query, requiredId]: (typeof mothlightCases)[number]): CorpusCase {
  return {
    id,
    query,
    scope: "project",
    category: requiredId ? "paraphrase" : "abstention",
    requiredIds: requiredId ? [requiredId] : [],
    supportingIds: [],
    forbiddenIds: [],
    applicablePaths: [],
    expectEmpty: requiredId === undefined,
    notes: "Held-out synthetic evaluation, outside the versioned retrieval corpus.",
  };
}

export function heldOutSuites(corpus: LoadedCorpus): Record<string, LoadedCorpus> {
  return {
    mothlight: { ...corpus, cases: mothlightCases.map(label) },
    skylark: {
      ...corpus,
      cases: skylarkCases.map(label),
      engrams: skylarkNotes.map((note) => ({
        file: `${note.id}.md`,
        engram: {
          ...note,
          type: "fact",
          scope: "project",
          tags: [],
          aliases: [],
          author: undefined,
          schemaVersion: 1,
          path: `/synthetic/${note.id}.md`,
          pinned: false,
          created: "2025-12-01T00:00:00.000Z",
          updated: "2025-12-01T00:00:00.000Z",
        },
      })),
    },
  };
}
