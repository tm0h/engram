---
id: 01jwq41b80000000000000002r
title: renderPage streams the shell first
type: note
tags: [renderer, api]
scope: project
created: 2026-02-04T00:00:00.000Z
updated: 2026-02-04T00:00:00.000Z
---

`renderPage` streams the HTML shell before data resolves, so first paint waits on nothing.
