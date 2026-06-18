# Project Wiki

Welcome. This page is the wiki landing page (`docs/index.md` → the wiki's
`Home`). `docs/` is the **single source of truth** — it renders on github.com as
a normal folder of markdown, and `publish-wiki` mirrors it into the project's
GitHub wiki.

## Editing the docs

- Add a page by dropping a markdown file anywhere under `docs/`. It is picked up
  automatically — there is no page list to maintain.
- Link between pages with normal relative links (e.g.
  `[the workflow](development/workflow.md)`); `build-wiki` rewrites them to wiki
  slugs and **fails the build** on a broken link or anchor.
- Group pages in the sidebar by putting them in a subdirectory
  (`docs/development/…` → a "Development" group).

## Where to start

- [Development workflow](development/workflow.md) — how commits get signed and
  how the wiki is published.
