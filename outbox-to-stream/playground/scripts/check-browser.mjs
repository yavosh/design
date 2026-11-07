import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve, join, extname, sep } from "node:path";
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

const siteRoot = resolve("../../dist/site");
const siteServer = createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const relative = pathname.slice("/design/".length);
  const file = resolve(siteRoot, relative + (pathname.endsWith("/") ? "index.html" : ""));
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  if (!pathname.startsWith("/design/") || !file.startsWith(siteRoot + sep) || !types[extname(file)]) {
    response.writeHead(404).end();
    return;
  }
  try {
    const content = readFileSync(file);
    response.writeHead(200, { "Content-Type": types[extname(file)] }).end(content);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve, reject) => {
  siteServer.once("error", reject);
  siteServer.listen(0, "127.0.0.1", resolve);
});
const indexUrl = `http://127.0.0.1:${siteServer.address().port}/design/`;

const chrome = spawn("google-chrome", [
  "--headless", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-sync", "--hide-scrollbars",
  `--user-data-dir=${join(temporary, "profile")}`, "--remote-debugging-pipe",
], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
let sequence = 0;
let buffer = "";
const pending = new Map();
const consoleErrors = [];
chrome.stdio[4].on("data", chunk => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf("\0")) !== -1) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description).join(" "));
    } else if (message.method === "Runtime.exceptionThrown") {
      consoleErrors.push(message.params.exceptionDetails.text);
    }
  }
});
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });
}
async function waitForHeading(title, sessionId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await send("Runtime.evaluate", {
      expression: `document.querySelector('h1')?.textContent === ${JSON.stringify(title)}`, returnByValue: true,
    }, sessionId);
    if (result.result.value) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Page did not render: ${title}`);
}
const timeout = setTimeout(() => { chrome.kill(); throw new Error("Browser verification timed out"); }, 90000);
try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  for (const [name, width, height] of [["desktop", 1487, 1058], ["mobile", 390, 844]]) {
    consoleErrors.length = 0;
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: name === "mobile" }, sessionId);
    await send("Page.navigate", { url: pathToFileURL(page).href }, sessionId);
    let result;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const evaluated = await send("Runtime.evaluate", {
        expression: 'document.getElementById("browser-check-result")?.textContent', returnByValue: true,
      }, sessionId);
      if (evaluated.result.value) {
        result = JSON.parse(decodeURIComponent(evaluated.result.value));
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(result, `${name}: Browser check did not complete`);
    result.consoleErrors = [...consoleErrors];
    writeFileSync(`qa/${name}.json`, JSON.stringify(result, null, 2));
    const capture = await send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 },
    }, sessionId);
    writeFileSync(resolve(`qa/${name}.png`), Buffer.from(capture.data, "base64"));
    assert.ok(result.passed, `${name}: ${result.error}`);
    assert.equal(result.viewport.width, width);
    assert.equal(result.viewport.height, height);
    assert.deepEqual(consoleErrors, []);
    console.log(`${name}: all six scenarios and core controls passed; viewport ${width} × ${height}`);

    await send("Page.navigate", { url: indexUrl }, sessionId);
    await waitForHeading("Design guides", sessionId);
    const indexState = await send("Runtime.evaluate", {
      expression: "({href: document.querySelector('[data-guide=eda]').getAttribute('href'), overflow: document.documentElement.scrollWidth > innerWidth})",
      returnByValue: true,
    }, sessionId);
    assert.equal(indexState.result.value.href, "./eda/");
    assert.equal(indexState.result.value.overflow, false);
    const indexCapture = await send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 },
    }, sessionId);
    writeFileSync(resolve(`qa/index-${name}.png`), Buffer.from(indexCapture.data, "base64"));
    await send("Runtime.evaluate", { expression: "document.querySelector('[data-guide=eda]').click()" }, sessionId);
    await waitForHeading("Outbox event flow", sessionId);
    const route = await send("Runtime.evaluate", { expression: "location.pathname", returnByValue: true }, sessionId);
    assert.equal(route.result.value, "/design/eda/");
    await send("Runtime.evaluate", { expression: "document.querySelector('.guides-link').click()" }, sessionId);
    await waitForHeading("Design guides", sessionId);
    assert.deepEqual(consoleErrors, []);
    console.log(`${name}: design index, EDA asset loading, and return navigation passed`);

    await send("Runtime.evaluate", { expression: "document.querySelector('.read-guide').click()" }, sessionId);
    await waitForHeading("Outbox-to-Stream Playbook", sessionId);
    const guideState = await send("Runtime.evaluate", {
      expression: `({
        overflow: document.documentElement.scrollWidth > innerWidth,
        sections: document.querySelectorAll('article h2').length,
        tables: document.querySelectorAll('.table-scroll table').length,
        codeBlocks: document.querySelectorAll('pre code').length,
        contentsValid: [...document.querySelectorAll('.guide-sidebar a, .mobile-toc a')].every(link => document.getElementById(link.hash.slice(1))),
        playground: new URL(document.querySelector('.playground-link').href).pathname
      })`,
      returnByValue: true,
    }, sessionId);
    assert.equal(guideState.result.value.overflow, false);
    assert.ok(guideState.result.value.sections >= 10);
    assert.ok(guideState.result.value.tables > 0);
    assert.ok(guideState.result.value.codeBlocks > 0);
    assert.equal(guideState.result.value.contentsValid, true);
    assert.equal(guideState.result.value.playground, "/design/eda/");
    if (name === "mobile") {
      await send("Runtime.evaluate", { expression: "document.querySelector('.mobile-toc summary').click()" }, sessionId);
    }
    await send("Runtime.evaluate", {
      expression: `document.querySelector('${name === "mobile" ? ".mobile-toc" : ".guide-sidebar"} a').click()`,
    }, sessionId);
    const anchor = await send("Runtime.evaluate", { expression: "location.hash", returnByValue: true }, sessionId);
    assert.ok(anchor.result.value.length > 1);
    await send("Runtime.evaluate", { expression: "document.querySelector('.mobile-toc').open = false; window.scrollTo(0, 0)" }, sessionId);
    const guideCapture = await send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 },
    }, sessionId);
    writeFileSync(resolve(`qa/guide-${name}.png`), Buffer.from(guideCapture.data, "base64"));
    await send("Runtime.evaluate", { expression: "document.querySelector('.playground-link').click()" }, sessionId);
    await waitForHeading("Outbox event flow", sessionId);
    await send("Runtime.evaluate", { expression: "document.querySelector('.guides-link').click()" }, sessionId);
    await waitForHeading("Design guides", sessionId);
    assert.deepEqual(consoleErrors, []);
    console.log(`${name}: HTML guide, contents anchors, tables, code blocks, and playground navigation passed`);
  }
} finally {
  clearTimeout(timeout);
  chrome.kill();
  siteServer.close();
}
