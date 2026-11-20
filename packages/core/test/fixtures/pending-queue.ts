import { NodeServices } from "@effect/platform-node";
import { Effect, Result } from "effect";
import { enqueuePendingCandidate, readPendingCandidate } from "../../src/pending-store.js";

const [action, scope, value] = process.argv.slice(2);
if (scope !== "project" && scope !== "personal") throw new Error("Invalid fixture scope");

const candidate =
  action === "read"
    ? readPendingCandidate(scope, value)
    : enqueuePendingCandidate({
        scope,
        proposed: {
          title: "quartzpending " + (value ?? "example"),
          type: "decision",
          tags: ["capture"],
          body: "Use the synthetic violet adapter.",
        },
        sourceExcerpt:
          action === "sensitive"
            ? "password = synthetic-private-value"
            : "A violet adapter was discussed.",
        provenanceClass: "conversation",
        duplicates: [{ scope, id: "0001", kind: "exact_duplicate" }],
        conflicts: [{ scope, id: "0002", kind: "possible_conflict" }],
      });

const result = await Effect.runPromise(
  Effect.result(candidate).pipe(Effect.provide(NodeServices.layer)),
);
if (Result.isSuccess(result)) {
  console.log(JSON.stringify(result.success));
} else {
  const error = result.failure;
  if (error._tag === "SecretScanBlockedError") {
    console.error("Pending candidate blocked:", JSON.stringify(error.findings));
  } else {
    console.error(error.message);
  }
  process.exitCode = 1;
}
