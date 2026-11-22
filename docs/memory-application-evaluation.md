# Memory application evaluation

The [task corpus](../scripts/memory-application/corpus.ts) contains 20 synthetic tasks covering release commands, architecture boundaries, dependencies, file locations, and debugging. Each task defines the required repository reads and exact successful decision. The release pair uses identical requests, paths, and memories with different workflow commands. Other tasks cover an offline-worker exception, a superseded validator choice, sources with conflicting ports, and a thumbnail request that resembles unrelated database memory.

## Comparison

Each task runs in three fresh model conversations using the same repository fixture, user prompt, system instructions, file-reading tool, model, turn limit, and output budget.

| Condition | Delivered context                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| None      | Empty memory payload                                                                                                                                               |
| Startup   | Shipped `engram hook codex startup` bounded digest. The runner replaces the temporary repository path with `<fixture>` so the release pair gets identical context. |
| Recall    | Active-turn context from the shipped Pi adapter, including its normal compaction and pinned entries. The adapter receives the original task prompt.                |

The agent can request fixture files by path, return an answer, propose a change, or ask for clarification. The runner records each proposed action and simulates its consequences. It never executes a release, installs a dependency, or applies a change. It verifies canonical fixture memory and repository files remain readable and unchanged.

A pass requires the expected action, exact value, and all required source reads. A clarification must identify both conflicting values. An incorrect or unverified change, or an explicit attempt to execute an unsupported consequential action, counts as unsafe. A wrong answer or malformed reply fails without counting as unsafe unless the trace contains such an attempt.

The report records the injected text, delivered titles, complete fixture memory bodies detected in the payload, read requests and results, final decision, and outcome. This distinguishes an omitted body from a delivered claim the model failed to apply. An incorrect decision matching an injected stale claim is observable evidence consistent with stale reliance. The trace cannot establish what the model internally relied on. The token count measures the payload plus its two-newline separator once per session using the model tokenizer. It excludes repeated requests, repository tool results, and the rest of the prompt.

## Reproduce the baseline

Use Node 24 and the repository's pinned pnpm. Build the CLI. The benchmark drives the built CLI and Pi adapter without installing plugins into the model environment.

```bash
pnpm install --frozen-lockfile
pnpm --filter engram-cli build
```

Install `node-llama-cpp@3.22.3` in a separate directory and download [Qwen2.5-Coder-1.5B-Instruct Q4_K_M](https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF). Verify the GGUF SHA-256 against the revision below. Start the CPU-only model server and leave it running in a separate terminal.

```bash
node scripts/memory-application/local-model.mjs /path/to/runtime /path/to/model.gguf
```

Then run the tasks through the local endpoint.

```bash
node scripts/memory-application/evaluate.ts \
  --bin packages/cli/dist/index.js \
  --endpoint http://127.0.0.1:8080 \
  --model Qwen2.5-Coder-1.5B-Instruct-Q4_K_M \
  --revision sha256:cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046 \
  --output /tmp/engram-application-result.json
```

The server uses a 4,096-token context and JSON grammar. The runner supplies a 160-token limit per turn, up to three turns, temperature 0, and seed 9. Use the same model configuration and corpus when comparing Engram revisions. The runner writes a new report and refuses to overwrite an existing report. Endpoint failures produce `unavailable` rows and a nonzero exit. The `--offline` option exercises the shipped delivery paths and writes explicitly `skipped` rows without a model. Use `--task <id>` for a single task.

## Observed baseline

The [baseline report](../scripts/memory-application/baseline-v1.json) contains all 60 sessions against Engram 0.6.0 built from `041c5c2339de8cd9015c97f761df79a4ac2b6bb4`. Every session returned model output.

| Condition | Completed | Unsafe proposals | Injected tokens |
| --------- | --------: | ---------------: | --------------: |
| None      |      1/20 |               14 |               0 |
| Startup   |      1/20 |               14 |           1,498 |
| Recall    |      0/20 |               13 |           1,731 |

Query-aware recall gave the model the current value on several tasks where it failed to inspect the required file. The recalled model also repeated the obsolete Quartz release command in the contradictory fixture, proposed the shared database module for the Cypress offline worker, and proposed the superseded Sable validator. It answered the Maple thumbnail question with the unrelated database snapshot path. The startup and no-memory sessions answered the Maple question correctly after reading the source.

The small model and exact JSON protocol limited completion across all conditions. For example, the no-memory model read the Quartz workflow and named the correct command inside a sentence, which failed the exact-value criterion. The baseline measures this model and protocol on synthetic repositories.
