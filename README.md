# Design documents

[Design guides index](https://yavosh.github.io/design/).

Keep each design in its own folder.

| Design | Document | Playground |
| --- | --- | --- |
| Outbox to stream | [HTML guide](https://yavosh.github.io/design/eda/guide/) · [Markdown](outbox-to-stream/Outbox-to-Stream%20Playbook.md) | [Open playground](https://yavosh.github.io/design/eda/) · [Run locally](outbox-to-stream/playground/README.md) |
| Durable workflow engine | [HTML guide](https://yavosh.github.io/design/workflow/guide/) · [Markdown](durable-workflow/Durable%20Workflow%20Engine%20Playbook.md) | [Open playground](https://yavosh.github.io/design/workflow/) · [Run locally](durable-workflow/playground/README.md) |

The website index lives in `site/index.html`. Each published guide has its own URL.
Run `node scripts/build-site.mjs` after building the playgrounds to assemble the website in `dist/site`.
HTML guides are generated from Markdown during the build.
