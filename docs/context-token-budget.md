# Context token budget

Use this budget for a digest you request from the CLI or a harness tool. For
startup hooks and automatic recall, see [automatic startup context](startup-context.md).

```sh
engram context --tokens 4000
engram context --tokens 4000 --scope all --query "tag:release" --limit 5
```

## Counting contract

`--tokens` takes a positive decimal safe integer from 512 through
9,007,199,254,740,991. The 512-unit minimum leaves room for scope headings,
store warnings, omission counts, and at least the identity and truncation
marker of a matching entry when one is available. Increase the budget to
include more entries or more of a long body.

The method is `utf8-nfkd-bytes-v1`. For each Unicode code point in the emitted
text, count the greater of its UTF-8 byte length and the UTF-8 byte length of
its Unicode NFKD decomposition, then sum those counts. The ASCII fast path
charges one unit per byte. Accounting uses the decomposition data provided by
the running Node.js version. Stored text is emitted without normalization.
If a stored string contains an unpaired UTF-16 surrogate, it is emitted and
counted as U+FFFD.

This exactly bounds the complete digest under Engram's method, including
headings, separators, warnings, truncation markers, continuation text, and
the CLI's final newline. The byte allowance is conservative for byte-based
tokenizers. The additional decomposition allowance accounts for Unicode
expansion in tokenizers that normalize text. Model-specific token counts
and provider message framing can differ. A change to the accounting rule
will use a new method identifier.

## Selection and flags

- Scope resolution is the same as regular context. Use `--scope all` to
  include both stores from an initialized project. The heading identifies
  the resolved scopes and query mode. Each entry includes its scope and ID.
- `--query` uses the existing query candidate pool and includes bodies.
  Without a query, `--full` adds bodies to the otherwise compact digest.
  Inactive entries are excluded before selection unless `--all` is present.
- Among eligible entries, the existing curated startup policy promotes
  pins, decisions with importance at least 3, and preferences with
  importance at least 4. Within that group, pins come first, followed by
  descending importance, project before personal, and ID as a tie-breaker.
  Other CLI entries retain the existing per-scope search or recency order.
  The CLI applies `--limit` per scope after prioritizing, before fitting
  entries in the token budget.
- The renderer reserves space for its final diagnostics and fits entries
  in order. The CLI can emit a Unicode-safe prefix of the first entry
  that overflows if its identity and marker fit, then stops. The footer
  counts entries omitted by the budget, entries truncated, and entries
  excluded by the CLI limit. Use `engram show <id>` to read an entire entry.
- Without `--tokens`, the CLI uses its regular context format and selection.

## Pi and OpenCode

Pass `{"tokens":4000}` to the manual `engram_context` tool. The budget covers
the returned digest text. The existing tool-size ceiling also applies, so the
effective budget is at most 8,192 units. The tool uses the same curated
priority before applying its existing offset and entry limit. Other entries
retain their ordinary digest order.

If a later entry does not fit on the current page, it starts the next page.
If the first entry itself is too large, it is truncated and the continuation
advances past it. The continuation call carries the original token budget.
Tool details include a `budget` object with `method`, `requested`, `effective`,
`used`, `shown`, `omitted` (budget omissions within the candidate page) and
`truncated`. Existing pagination fields still describe the eligible result set
and `nextOffset` identifies the first entry available on the next page. The
provider's tool wrapper and structured details are outside the text budget.

## Local tokenizer comparison

The comparison measures complete rendered digests at budgets of 512 and
4,000. Fixtures cover prose, Markdown code, multilingual Unicode and emoji,
compatibility characters that expand under normalization, and an unbroken
ASCII run. It runs offline after installing the reference packages. The CLI
and tools have no runtime dependency on them.

| Local reference                                          | Largest overcount | Largest undercount | Largest ratio |
| -------------------------------------------------------- | ----------------: | -----------------: | ------------: |
| `js-tiktoken@1.0.21`, `o200k_base`                       |             3,456 |                  0 |         7.35× |
| `js-tiktoken@1.0.21`, `cl100k_base`                      |             3,455 |                  0 |         7.34× |
| `@anthropic-ai/tokenizer@0.0.4`, legacy Claude with NFKC |             3,804 |                  0 |        20.41× |

The long repeating ASCII fixture produced every maximum overcount.
The comparison uses local reference encodings representative of model
families available through the harnesses. The Claude package is a legacy
reference and used `tiktoken@1.0.22`. These measurements do not include current hosted model counts
or message framing.

```sh
reference_dir=$(mktemp -d)
npm install --prefix "$reference_dir" --no-audit --no-fund --save-exact \
  js-tiktoken@1.0.21 @anthropic-ai/tokenizer@0.0.4 tiktoken@1.0.22
node --import tsx scripts/compare-context-tokenizers.mjs "$reference_dir"
```
