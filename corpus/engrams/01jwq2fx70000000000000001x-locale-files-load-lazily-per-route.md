---
id: 01jwq2fx70000000000000001x
title: Locale files load lazily per route
type: decision
tags: [i18n, locales]
scope: project
created: 2026-01-10T00:00:00.000Z
updated: 2026-01-10T00:00:00.000Z
supersedes: 01jwq2hqt0000000000000001y
---

Locale data loads per route on demand, so a page only pays for its own strings.
