# Automatic context compaction

Pi and OpenCode fit a single Engram block against the system content and active
user text visible to their hooks. Both use the conservative
[`utf8-nfkd-bytes-v1` estimator](context-token-budget.md), with no provider
tokenizer dependency. The configured `autoContextMaxChars` value also caps
these units, which keeps the rendered block within its character limit.
`autoContextLimit` caps the number of newly injected memories. The CLI and
manual tool budget contract is documented separately.

| Harness  | Model headroom                                                                                                                                                                     | New block framing                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Pi       | Context window minus the model output allowance, the larger of the visible system cost and Pi's prior context estimate, and the current user text plus 16 units                    | Two newlines before the block                                                                                        |
| OpenCode | The lower of the input limit, when supplied, and the context window minus the output allowance. Subtract visible system parts with framing and the active user text plus 16 units. | Two newline units for joining an existing system part and a 16-unit allowance for a separate system-message envelope |

Both charge the complete memory wrapper, its trust instruction, quoted and
escaped rows, and row separators. The output reserve defaults to 256 when the
model exposes a context limit without a usable output limit. If no usable
limit is available, the injection allowance is capped at 2,048 units.
An incomplete-store warning can be delivered by itself when it fits. Budgets
apply to the injection and host-visible inputs. History, tool schemas, and provider serialization
outside these hooks can affect the provider's full-request token count.

## Selection and fallback

Active pinned or high-importance memories (`importance` 4 or 5) come first.
Use those attributes on safety-critical memories. Within priority tiers,
confident matches win ties, then project scope and ID determine order. Up to
five confident query matches supply short stored excerpts. Other eligible
critical rows supply an opening excerpt. On a weak query, OpenCode can also
pack title-only candidates from the configured bootstrap policy. The bootstrap
eligibility settings still apply to that fallback.

The whole critical prefix fits whenever the effective allowance covers the
framing plus its complete rows and the entry limit admits them. For example,
512 available units cover both critical rows in the paired evaluation below
with either harness. Longer or more numerous critical entries require the
sum of their row costs, one unit per joining newline, and the framing above.
When full rows exceed the allowance, the fallback retains provenance and as
much original title and excerpt as fits on grapheme boundaries. An ellipsis
marks a cut within quoted text. The trust instruction stays intact whenever a
block is injected. A tight budget can omit entries or facts beyond an excerpt.
Use the manual Engram tools to read the full entries.

The renderer checks the visible system text and active user text for
matching evidence on each invocation. Already-present rows and standalone
verbatim excerpts are skipped. A bare ID or a mention inside another
sentence does not suppress a row. The next request can receive the same
memory when its prompt lacks that evidence. The hooks cache retrieval inputs
independently of compaction and recalculate fit against the live prompt.

`ENGRAM_DEBUG=1` emits one JSON record per compaction to stderr. It reports
the method, headroom source, effective and used units, selected, deduplicated,
omitted and truncated scoped IDs, and counts for skipped files and candidate
windows. These records contain no titles, excerpts, or prompt text.
`engram stats` counts fitted deliveries and their UTF-8 payload sizes.

## Paired evaluation

Run the fixture comparison with:

```sh
ENGRAM_PRINT_COMPACTION_EVAL=1 pnpm exec vp test run packages/harnesses/test/automatic-compaction-application.test.ts
```

Each adapter receives the same four tasks and store in both arms. The
uncompacted arm uses the previous bounded recall renderer and OpenCode
bootstrap fallback. Both arms must fit the same effective budget. Cost is
measured from the delivered block, including adapter framing. Recall@5
counts the required scoped memory facts that appear in the first five rows
or are supplied verbatim in the existing system prompt. Task success requires
the exact expected configuration patch from the assembled prompt, including
an empty patch when there is no requested setting to apply.

| Case                                         | Pi baseline | Pi compacted | OpenCode baseline | OpenCode compacted |
| -------------------------------------------- | ----------: | -----------: | ----------------: | -----------------: |
| Small window, two settings including Unicode |         366 |          282 |               382 |                298 |
| Changed topic, archived value excluded       |         257 |          215 |               273 |                231 |
| Required evidence already in system prompt   |         256 |            0 |               272 |                  0 |
| Weak query, no requested setting known       |           0 |          279 |               364 |                295 |
| **Total injected units**                     |     **879** |      **776** |         **1,291** |            **824** |
| **Required-memory Recall@5**                 |     **4/4** |      **4/4** |           **4/4** |            **4/4** |
| **Successful configuration patches**         |     **4/4** |      **4/4** |           **4/4** |            **4/4** |

The weak Pi request carries critical memories and still produces an empty
patch. These results measure the hooks and a deterministic local consumer
that reads assignments from their prompts. Provider-backed task-success
evidence is unavailable.
