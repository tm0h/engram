---
id: 01jwq5t3n0000000000000003q
title: Stop and start the dev server to clear module state
type: decision
tags: [dev-server, workflow]
scope: project
created: 2026-02-22T00:00:00.000Z
updated: 2026-02-22T00:00:00.000Z
---

When module state goes stale between runs, stop the dev server fully and start it again; hot reload does not clear it.
