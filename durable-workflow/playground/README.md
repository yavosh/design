# Workflow Playground

Follow one account through onboarding in a durable workflow engine: a step row, a dispatcher, a handler, and an external system.
Use **Next step** or **Play** to advance. Select any component to inspect its simulated state.

[Open the public playground](https://yavosh.github.io/design/workflow/) or browse the [design guides](https://yavosh.github.io/design/).
Read the formatted [HTML playbook](https://yavosh.github.io/design/workflow/guide/).

The desktop layout fits windows at least 1000 pixels wide and 600 pixels tall.
The explanation and timeline scroll within their panels.
Smaller windows scroll the page and keep controls at the bottom of the screen.

The playground includes eleven scenarios:

- One step run: claim, work, and record.
- A full flow, step by step.
- External system failure and retry backoff.
- A handler rejection that fails the step and its instance.
- A busy lock and a deferral.
- A planned wait with a park.
- A declared branch and an undeclared override.
- A process that dies mid-handler.
- An exhausted retry budget and an operator retry.
- A handler that ignores cancellation.
- A stage that no worker hosts.

## Run locally

```sh
npm ci
npm run dev -- --host 127.0.0.1 --port 4174
```

Open `http://localhost:4174`.

## Build a standalone preview

```sh
npm run build
open dist/playground.html
```

The HTML preview includes its JavaScript, CSS, and icons. It runs without a server.
The navigation links open the published guide and index when using the standalone preview.

## Check

```sh
npm test
npm run build
```

The browser check needs the assembled site and the browser binary that `scripts/check-browser.mjs` starts:

```sh
npm --prefix ../../outbox-to-stream/playground ci
npm --prefix ../../outbox-to-stream/playground run build
node ../../scripts/build-site.mjs
npm run test:browser
```

## Model boundaries

The simulation uses deterministic, in-memory steps and a virtual clock.
It illustrates the design; it does not test a real database, real locks, or concurrency.
Reloading clears the simulation.

Every step uses the same handler shape: lock, completeness check, external call, then one local commit.
Each scenario starts with its earlier steps already completed.
The retry-budget scenario also runs nine failed attempts before its first visible step.
Step names, delays, and limits are example settings.

Definition publishing, drafts, versioning, payloads, and metrics are covered only in the [playbook](../Durable%20Workflow%20Engine%20Playbook.md).

## Publish

The repository workflow runs the tests, builds the static client, and deploys the site.
Pull requests run the build and tests without deploying.

The workflow checks browser interactions at 1487 × 1058, 1366 × 768, 1024 × 640, and 390 × 844 pixels.
Screenshots and browser results are saved as workflow artifacts.

The playground builds into `dist/client`.
The repository's `scripts/build-site.mjs` combines the design index and the playgrounds into the root `dist/site` directory.
The playground is published at `/design/workflow/`.
The playbook is generated from Markdown at `/design/workflow/guide/`.

## Icons

Icons use the [MIT license](src/icons/LICENSE).
