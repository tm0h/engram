# Hermes native memory provider feasibility

Defer a native Engram provider. Hermes Agent v0.23.3 can load a provider for a
profile, but selecting Engram would displace any selected external provider.
A provider also receives model-facing query and conversation data, and its
recall can reach the inference provider. The profile skill takes a separate
user-run route.

## Pinned contract and prototype

The disposable, in-process prototype used the loader, memory manager, and
agent teardown from [v0.23.3 at `caafe5389ae585ef77387a962aee05b1bcf17029`](https://github.com/NousResearch/hermes-agent/tree/caafe5389ae585ef77387a962aee05b1bcf17029).
Two local synthetic providers recorded their calls and returned synthetic
strings. They made no inference requests and wrote no Engram records.

| Hook                              | Host input and timing                                                                                                                                                                                | Observed behavior                                                                                                                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prefetch(query, session_id=...)` | At the start of a nontrivial turn. The manager strips skill scaffolding and applies egress redaction. The callback receives query text and the session ID.                                           | Recall returned to the caller. Exceptions and timeouts returned empty recall. With the prototype timeout set to 50 ms, the callback was still running after the caller returned. The pinned external prefetch default is 8 seconds. |
| `on_session_end(messages)`        | Receives redacted conversation messages, which can include tool results. On the queued session boundary the hook ran before session rebinding. Teardown calls the hook before shutdown.              | A synthetic exception was logged and shutdown continued. A slow in-process teardown callback kept the caller waiting until it returned. The background drain bound is separate from that synchronous call.                          |
| `on_pre_compress(messages)`       | Before compression. Version 1 receives the redacted transcript after withheld prompts are filtered. A checkpoint-capable provider can receive normalized evidence and the `require_checkpoint` flag. | The regular callback returned context for compression. A regular failure yielded empty context. The required checkpoint path propagated the failure to the host, which keeps the uncompressed transcript.                           |

The [contract](https://github.com/NousResearch/hermes-agent/blob/caafe5389ae585ef77387a962aee05b1bcf17029/agent/memory_provider.py),
[loader](https://github.com/NousResearch/hermes-agent/blob/caafe5389ae585ef77387a962aee05b1bcf17029/plugins/memory/__init__.py),
[manager](https://github.com/NousResearch/hermes-agent/blob/caafe5389ae585ef77387a962aee05b1bcf17029/agent/memory_manager.py),
[turn context](https://github.com/NousResearch/hermes-agent/blob/caafe5389ae585ef77387a962aee05b1bcf17029/agent/turn_context.py),
[compression caller](https://github.com/NousResearch/hermes-agent/blob/caafe5389ae585ef77387a962aee05b1bcf17029/agent/conversation_compression.py),
and [teardown](https://github.com/NousResearch/hermes-agent/blob/caafe5389ae585ef77387a962aee05b1bcf17029/run_agent.py)
define these boundaries. The prototype exercised provider callbacks in process.
Isolated plugin-host RPC and hosted inference were outside the experiment.

## Selection and maintenance

The default `memory.provider` is empty and Hermes enables native personal memory
and the user profile by default. Agent initialization sets up the native memory
store separately and resolves at most one external provider. The prototype
registered one external provider and the manager refused the second. Restoring
the previous `memory.provider` in the synthetic profile resolved the previous
provider on the next load. A real opt-in would require restarting the affected
Hermes sessions after selecting or restoring the provider. See the pinned
[agent initialization](https://github.com/NousResearch/hermes-agent/blob/caafe5389ae585ef77387a962aee05b1bcf17029/agent/agent_init.py)
and [defaults](https://github.com/NousResearch/hermes-agent/blob/caafe5389ae585ef77387a962aee05b1bcf17029/hermes_cli/config_defaults.py).

A maintained provider would need per-profile installation and fresh instances
bound to the profile and session. Provider callbacks do not supply a verified
task checkout and local inference route with each call. Recall is added to the
model request, including when the callback itself only uses local storage.
Viable support would require a reliable local-inference gate, stable checkout
binding across session changes, bounded callbacks, and versioned compatibility
tests for hook payloads, checkpoint behavior, and plugin isolation. Any capture
experiment should pass supported evidence through Engram's admission gates and
write eligible candidates only to the pending queue. The profile skill performs no automatic capture.
