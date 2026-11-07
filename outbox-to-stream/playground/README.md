# Outbox Playground

Follow one event from a database transaction through a relay, stream, and two independent consumer groups.
Use **Next step** or **Play** to advance. Select any component to inspect its simulated state.

[Open the public playground](https://yavosh.github.io/design/).

The playground includes six scenarios:

- Normal delivery.
- Transaction rollback.
- Broker outage and retry backoff.
- Relay crash, lease recovery, stale claim rejection, and duplicate delivery.
- Independent consumer failure and recovery.
- Missed notification and fallback polling.

## Run locally

```sh
npm ci
npm run dev -- --host 127.0.0.1 --port 4173
```

Open `http://localhost:4173`.

## Build a standalone preview

```sh
npm run build
open dist/playground.html
```

The HTML preview includes its JavaScript, CSS, and icons. It runs without a server.
The playbook link opens GitHub.

## Check

```sh
npm test
npm run build
npm run test:sites
```

See [design-qa.md](design-qa.md) for the visual verification status.

## Model boundaries

The simulation uses deterministic, in-memory steps and a virtual clock.
It illustrates the design; it does not test a real database, broker, or concurrent relay implementation.
Reloading clears the simulation.

The read model effect is a local record. The delivery consumer effect is a durable job insertion.
External job execution is outside the simulation.

Retention expiry, manual replay, retry exhaustion, and bounded batch draining remain in the [playbook](../Outbox-to-Stream%20Playbook.md).
Delivery guarantees depend on retained history and deduplication evidence. The base design permits reordering.

## Publish

GitHub Actions runs the tests, builds the static client, and deploys it to GitHub Pages.
The workflow runs on changes to this playground on `main` and `feat/outbox-playground`.
Pull requests run the build and tests without deploying.

The published files come from `dist/client`. Relative asset URLs support the repository's `/design/` path.

## Visual source

[Selected design](../design-options/1.png). Icons use the [Tabler MIT license](src/icons/LICENSE).
