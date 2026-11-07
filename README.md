# Design documents

[Design guides index](https://yavosh.github.io/design/).

Keep each design in its own folder.

| Design | Document | Playground |
| --- | --- | --- |
| Outbox to stream | [HTML guide](https://yavosh.github.io/design/eda/guide/) · [Markdown](outbox-to-stream/Outbox-to-Stream%20Playbook.md) | [Open playground](https://yavosh.github.io/design/eda/) · [Run locally](outbox-to-stream/playground/README.md) |

The website index lives in `site/index.html`. Each published guide has its own URL.
Run `node scripts/build-site.mjs` after building the playground to assemble the website in `dist/site`.
HTML guides are generated from Markdown during the build.
