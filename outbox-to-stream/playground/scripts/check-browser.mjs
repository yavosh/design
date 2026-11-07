import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { scenarios } from "../src/simulation.js";

// Run in CI with an isolated Chrome profile. No browser automation dependency is required.
async function checkPage(scenarios) {
  const errors = [];
  window.addEventListener("error", event => errors.push(event.message));
  window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
  const pause = () => new Promise(resolve => setTimeout(resolve, 50));
  function check(condition, message) { if (!condition) throw new Error(message); }
  async function waitFor(predicate, message) {
    for (let i = 0; i < 100; i += 1) {
      if (predicate()) return;
      await pause();
    }
    throw new Error(message);
  }
  async function select(key) {
    const select = document.querySelector("#scenario");
    select.value = key;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await pause();
  }
  async function inspect(selector) {
    document.querySelector(selector).click();
    await pause();
    check(document.querySelector(".inspector-dialog").open, "State inspector did not open");
    const value = JSON.parse(document.querySelector(".inspector-dialog pre").textContent);
    document.querySelector('[aria-label="Close state inspector"]').click();
    await pause();
    return value;
  }
  const result = { passed: false, scenarios: [], viewport: { width: innerWidth, height: innerHeight, density: devicePixelRatio } };
  try {
    await waitFor(() => document.querySelector(".primary-button"), "Application did not render");
    check(document.querySelector("h1").textContent === "Outbox event flow", "Wrong title");
    document.querySelector(".failure-button").click();
    await pause();
    check(document.querySelector(".scenario-dialog").open, "Failure scenarios did not open");
    check(document.querySelectorAll(".scenario-options button").length === 5, "Missing failure scenarios");
    document.querySelector('[aria-label="Close scenarios"]').click();
    for (const [key, scenario] of Object.entries(scenarios)) {
      await select(key);
      for (let i = 0; i < scenario.steps.length; i += 1) {
        document.querySelector(".primary-button").click();
        await pause();
        check(document.documentElement.scrollWidth <= innerWidth, `Horizontal overflow: ${key}, step ${i + 1}`);
      }
      check(document.querySelector(".primary-button").disabled, `Scenario did not finish: ${key}`);
      const producer = await inspect(".producer");
      const stream = await inspect(".stream");
      const readModel = await inspect(".consumers .consumer:first-child");
      const jobs = await inspect(".consumers .consumer:last-child");
      if (key === "rollback") {
        check(!producer.businessCommitted && producer.outbox === null && stream.length === 0, "Rollback created durable work");
      } else {
        check(producer.outbox.status === "SENT", "Outbox did not finish");
        check(readModel.effects === 1 && jobs.effects === 1, "Incorrect consumer effects");
        check(stream.every(entry => entry.payload.type === "RecordUpdated"), "Event type is not generic");
      }
      if (key === "duplicate") {
        check(stream.length === 2 && stream[0].eventId === stream[1].eventId, "Retry changed the event identity");
        check(readModel.duplicates === 1 && jobs.duplicates === 1, "Duplicate was not ignored");
      }
      if (scenario.steps.length > 3) {
        document.querySelector(".timeline .text-button").click();
        await pause();
        check(document.querySelectorAll(".timeline li").length === scenario.steps.length, "Timeline expansion failed");
      }
      result.scenarios.push(key);
    }
    await select("normal");
    document.querySelectorAll(".playback-controls button")[1].click();
    await waitFor(() => document.querySelector(".stage-label").textContent.includes("1 / 5"), "Playback did not advance");
    document.querySelectorAll(".playback-controls button")[1].click();
    const pausedStage = document.querySelector(".stage-label").textContent;
    await new Promise(resolve => setTimeout(resolve, 2000));
    check(document.querySelector(".stage-label").textContent === pausedStage, "Pause did not stop playback");
    document.querySelectorAll(".playback-controls button")[2].click();
    await pause();
    check(document.querySelector(".stage-label").textContent.includes("0 / 5"), "Reset failed");
    document.querySelector(".primary-button").click();
    await pause();
    document.querySelector(".primary-button").click();
    await pause();
    check(errors.length === 0, errors.join("; "));
    result.passed = true;
    result.controls = ["next", "play", "pause", "reset", "scenario selection", "failure dialog", "state inspection", "timeline"];
    result.errors = errors;
  } catch (error) {
    result.error = String(error);
  }
  document.activeElement?.blur();
  window.scrollTo(0, 0);
  const output = document.createElement("output");
  output.id = "browser-check-result";
  output.hidden = true;
  output.textContent = encodeURIComponent(JSON.stringify(result));
  document.body.append(output);
}

mkdirSync("qa", { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), "outbox-browser-"));
const html = readFileSync("dist/playground.html", "utf8");
const harness = `<script type="module">(${checkPage.toString()})(${JSON.stringify(scenarios)});</script>`;
const page = join(temporary, "check.html");
writeFileSync(page, html.replace("</body>", `${harness}</body>`));

for (const [name, width, height] of [["desktop", 1487, 1058], ["mobile", 390, 844]]) {
  const output = execFileSync("google-chrome", [
    "--headless", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-sync", "--hide-scrollbars",
    "--force-device-scale-factor=1", `--user-data-dir=${join(temporary, name)}`,
    `--window-size=${width},${height}`, "--virtual-time-budget=20000", "--dump-dom",
    `--screenshot=${resolve(`qa/${name}.png`)}`, pathToFileURL(page).href,
  ], { encoding: "utf8", maxBuffer: 5 * 1024 * 1024, timeout: 60000 });
  const encoded = output.match(/<output id="browser-check-result"[^>]*>([^<]+)<\/output>/)?.[1];
  assert.ok(encoded, `${name}: Browser check did not complete`);
  const result = JSON.parse(decodeURIComponent(encoded));
  writeFileSync(`qa/${name}.json`, JSON.stringify(result, null, 2));
  assert.ok(result.passed, `${name}: ${result.error}`);
  console.log(`${name}: all six scenarios and core controls passed; viewport ${result.viewport.width} × ${result.viewport.height}`);
}
