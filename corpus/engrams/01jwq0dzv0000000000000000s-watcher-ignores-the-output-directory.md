---
id: 01jwq0dzv0000000000000000s
title: Watcher ignores the output directory
type: note
tags: [watcher, dev-server]
scope: project
created: 2025-06-03T01:00:00.000Z
updated: 2025-06-03T01:00:00.000Z
---

The file watcher skips the dist output directory and dot directories; a rebuild loop was traced to generated fragments inside dist.
