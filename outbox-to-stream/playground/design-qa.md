# Outbox Playground design QA

final result: blocked

## Evidence

- Source visual: `/Users/yavosh/Projects/yavosh/design/outbox-to-stream/design-options/1.png`.
- Source dimensions: 1487 × 1058 pixels.
- Accepted changes: the user requested the title "Outbox event flow", generic record examples and event types, and a link back to the design-guide index.
- Implementation: https://yavosh.github.io/design/eda/.
- Browser evidence: [CI run 42336538176](https://github.com/yavosh/design/actions/runs/42336538176).
- Screenshots: `desktop.png` and `mobile.png` in the [browser QA artifact](https://github.com/yavosh/design/actions/runs/42336538176/artifacts/13559945633).
- Desktop viewport and capture: 1487 × 1058 CSS pixels, device scale factor 1.
- Mobile viewport and capture: 390 × 844 CSS pixels, device scale factor 1.
- Capture state: normal delivery, step 2, current claim `claim_01`.
- Density normalization: none needed; capture dimensions match their CSS viewports.

## Remaining blocker

Chrome rendering and interaction checks now run successfully on GitHub Actions.
Artifact downloads fail in the local session with a network connection error.
The screenshots could not be opened alongside the source for visual comparison.
Full-view and focused-region comparison therefore remain blocked.

## Required fidelity surfaces

- Fonts and typography: implemented from the selected source; visual comparison pending.
- Spacing and layout rhythm: horizontal desktop layout and stacked narrow layout implemented. Browser checks find no horizontal overflow across all scenario steps at either viewport.
- Colors and tokens: ivory, navy, blue, mint, and amber tokens implemented; visual comparison pending.
- Images and icons: source-library Tabler icons bundled with their license; no raster artwork required by this design.
- Copy and content: simpler title and generic record examples override the original mock, as requested.

These are implementation and automated-check facts, not visual acceptance findings.

## Completed checks

- Seven simulation tests pass across all six scenarios.
- Production build passes and emits a standalone HTML preview.
- Four worker and packaging checks pass.
- Browser checks pass at both exact viewports for all scenarios, next step, play, pause, reset, scenario selection, failure dialog, state inspection, and timeline expansion.
- Browser assertions verify rollback, final outbox status, generic event types, duplicate identity, deduplication, and consumer effects.
- No uncaught page errors, unhandled rejections, or browser console errors were recorded by the checks.
- The deployment workflow verifies the published page returns a successful HTTP response.
- Manual visual comparison and keyboard focus review remain pending.

## Comparison history

The first Chrome CLI capture used 1487 × 915 and 500 × 701 viewports.
The capture script now uses the DevTools protocol to enforce exact viewport dimensions.
The rerun passed at 1487 × 1058 and 390 × 844 and saved matching screenshots.
No source-to-implementation visual comparison has run or been claimed.

## Remaining checks

1. Download the browser QA artifact and open its screenshots alongside the source.
2. Compare the full view, diagram details, and typography while accounting for accepted copy changes.
3. Review keyboard focus behavior.
4. Fix actionable visual issues before marking visual QA passed.
