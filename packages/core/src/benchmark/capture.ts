import { fileURLToPath } from "node:url";
import { CAPTURE_RULES_VERSION, evaluateCapture } from "../capture-admission.js";
import { loadCaptureCorpus, scoreCapture } from "../capture-corpus.js";

const root = fileURLToPath(new URL("../../../../corpus/capture/", import.meta.url));
const { sessions, manifest } = loadCaptureCorpus(root);
const emissions = sessions.map(({ id, messages, existingMemory }) => ({
  id,
  proposals: evaluateCapture({ messages }, existingMemory),
}));

// Independently reviewed claims for corpus v1.0.0. The exact emitted body,
// including rationale and qualifications, must match before assigning a label.
const adjudication: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  "mixed-release": [
    [
      "release-day",
      "Correction for Lantern: production publishes on Thursdays, not Fridays. Keep Thursday as the release day.",
    ],
    [
      "snapshot-format",
      "For Lantern, we decided to publish complete index snapshots instead of deltas so mirrors can recover after missing an update.",
    ],
  ],
  "personal-remember": [
    [
      "patch-summary-style",
      "when summarizing a patch, put the changed behavior first and use short headings.",
    ],
  ],
  "repeated-gotcha": [
    [
      "locale-index",
      "Yesterday the Lantern preview skipped the Japanese sample. It was following an old locale index again.\n\nThe same thing happened today with the French sample. We fixed both by rebuilding the locale index after adding translations and before previewing.",
    ],
  ],
  "workspace-setup": [
    [
      "fixture-port",
      "Lantern's dev fixtures use port 4319 on every checkout. The preview runner expects it there.",
    ],
    [
      "snapshot-suffix",
      "Our convention is to name every snapshot test file with the .snapshot.test.ts suffix.",
    ],
  ],
};

let duplicateSuggestions = 0;
let unsupportedAssertions = 0;
const graded = Object.fromEntries(
  emissions.map(({ id, proposals }, index) => {
    const { expected, rejected } = sessions[index];
    const seen = new Set<string>();
    const rows = proposals.map(({ body, scope, evidence }) => {
      const candidateId =
        (Object.hasOwn(adjudication, id) ? adjudication[id] : []).find(
          ([, reviewedBody]) => reviewedBody === body,
        )?.[0] ?? null;
      const gold = expected.find((candidate) => candidate.id === candidateId);
      if (
        evidence.some(({ messageId }) =>
          rejected.some((row) => row.messageId === messageId && row.reason === "duplicate"),
        ) ||
        (candidateId !== null && seen.has(candidateId))
      ) {
        duplicateSuggestions++;
      } else if (
        !gold ||
        evidence.length !== gold.evidence.length ||
        !gold.evidence.every((ref) =>
          evidence.some(
            ({ messageId, origin }) => messageId === ref.messageId && origin === ref.origin,
          ),
        )
      ) {
        unsupportedAssertions++;
      }
      if (candidateId !== null) seen.add(candidateId);
      return { candidateId, scope, evidence };
    });
    return [id, rows];
  }),
);
console.log(
  JSON.stringify(
    {
      corpusVersion: manifest.corpusVersion,
      rulesVersion: CAPTURE_RULES_VERSION,
      ...scoreCapture(sessions, graded),
      duplicateSuggestions,
      unsupportedAssertions,
      proposalsBySessionId: graded,
    },
    null,
    2,
  ),
);
