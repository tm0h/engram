---
id: 01jwq1d3y0000000000000001a
title: Cache shards move to var directories
type: decision
tags: [cache, storage]
scope: project
created: 2025-08-10T00:00:00.000Z
updated: 2025-10-12T00:00:00.000Z
status: superseded
supersedes: 01jwq1b9b00000000000000019
---

Shard roots resolve under the per-workspace var tree, which keeps shards out of tmp cleanup passes.
