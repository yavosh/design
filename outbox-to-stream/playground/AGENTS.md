# Prototype Instructions

The user selected option 1, stored at `../design-options/1.png`.
Preserve its light background, horizontal event pipeline, blue controls, and plain explanations.
Keep the simulation vendor-neutral and separate from live infrastructure.
Use simple, direct titles. Avoid slogans and promotional language.
Use generic record examples and event types. Avoid payment-specific terminology.
Publish the website with GitHub Pages.
The public site root is a design-guide index. Publish this playground at `/design/eda/` and link back to the index.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
