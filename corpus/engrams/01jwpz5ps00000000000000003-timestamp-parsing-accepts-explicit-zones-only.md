---
id: 01jwpz5ps00000000000000003
title: Timestamp parsing accepts explicit zones only
type: note
tags: [time, parser]
scope: project
created: 2025-06-02T03:00:00.000Z
updated: 2025-06-02T03:00:00.000Z
---

`parseTimestamp` accepts ISO 8601 with an explicit zone only; the ISO_TIME regex rejects date-only strings and naive times.
