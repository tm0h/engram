---
id: 01jwq37py0000000000000002a
title: Scheduler misses jobs during sleep
type: issue
tags: [scheduler, bug]
scope: project
created: 2026-01-21T00:00:00.000Z
updated: 2026-01-21T00:00:00.000Z
---

After laptop sleep the scheduler skips jobs whose window passed; a wake handler should run them once.
