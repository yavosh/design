import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve, join, extname, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { scenarios } from "../src/simulation.js";

// Run in CI with an isolated browser profile. No browser automation dependency is required.
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
  function checkLayout(label) {
    check(document.documentElement.scrollWidth <= innerWidth, `Horizontal overflow: ${label}`);
    if (innerWidth < 1000 || innerHeight < 600) return;
    check(document.documentElement.scrollHeight <= innerHeight + 1, `Vertical overflow: ${label}`);
    for (const selector of [".masthead", ".intro", ".scenario-bar", ".instance", ".pipeline", ".controls", ".explanation", ".timeline", ".page-footer"]) {
      const element = document.querySelector(selector);
      const rect = element.getBoundingClientRect();
      check(rect.top >= 0 && rect.bottom <= innerHeight + 1 && rect.height > 0, `Outside viewport: ${selector}, ${label}`);
    }
    for (const element of document.querySelectorAll(".pipeline > .node")) {
      check(element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1, `Clipped component: ${element.className}, ${label}`);
    }
    const chips = document.querySelector(".chips").getBoundingClientRect();
    const current = document.querySelector(".chip-current").getBoundingClientRect();
    check(current.left >= chips.left - 1 && current.right <= chips.right + 1, `Current step is hidden: ${label}`);
    check(document.querySelector(".explanation").clientHeight >= 100, `Explanation too short: ${label}`);
    check(document.querySelector(".timeline").clientHeight >= 100, `Timeline too short: ${label}`);
  }
  const result = { passed: false, scenarios: [], viewport: { width: innerWidth, height: innerHeight, density: devicePixelRatio } };
  try {
    await waitFor(() => document.querySelector(".primary-button"), "Application did not render");
    check(document.querySelector("h1").textContent === "Workflow step flow", "Wrong title");
    check(document.querySelectorAll("#scenario option").length === Object.keys(scenarios).length, "Missing scenarios");
    document.querySelector(".failure-button").click();
    await pause();
    check(document.querySelector(".scenario-dialog").open, "Failure scenarios did not open");
    check(document.querySelectorAll(".scenario-options button").length === Object.values(scenarios).filter(scenario => scenario.failure).length, "Missing failure scenarios");
    document.querySelector('[aria-label="Close scenarios"]').click();
    for (const [key, scenario] of Object.entries(scenarios)) {
      await select(key);
      checkLayout(`${key}, start`);
      const controlsTop = document.querySelector(".controls").getBoundingClientRect().top;
      for (let i = 0; i < scenario.steps.length; i += 1) {
        document.querySelector(".primary-button").click();
        await pause();
        checkLayout(`${key}, step ${i + 1}`);
        if (innerWidth >= 1000 && innerHeight >= 600) check(Math.abs(document.querySelector(".controls").getBoundingClientRect().top - controlsTop) < 1, `Controls moved: ${key}, step ${i + 1}`);
        if (key === "crash" && i === 2) check(document.querySelector(".status-due"), "Due RUNNING row has no DUE badge");
      }
      check(document.querySelector(".primary-button").disabled, `Scenario did not finish: ${key}`);
      const { instance, auditLog } = await inspect(".instance");
      const rows = await inspect(".step-row");
      const dispatcher = await inspect(".dispatcher");
      const handler = await inspect(".handler");
      const external = await inspect(".external");
      const row = step => rows.find(item => item.step === step);
      check(rows.filter(item => !["COMPLETED", "FAILED"].includes(item.status)).length <= 1, `Two active steps: ${key}`);
      check(handler.outcome === null && handler.lock === null, `Handler did not finish: ${key}`);
      check(Object.values(external.effects).every(count => count === 1), `An effect repeated: ${key}`);
      if (key === "normal" || key === "flow") check(instance.status === "COMPLETED", `Instance did not complete: ${key}`);
      if (key === "flow") check(rows.length === 10 && row("REVIEW/REQUEST").deferCount === 1, "Flow did not follow the playbook table");
      if (key === "retry") check(row("WORKSPACE/RELEASE_NAME").attempts === 1, "Retry did not charge one attempt");
      if (key === "defer") check(row("WORKSPACE/RELEASE_NAME").deferCount === 1 && row("WORKSPACE/RELEASE_NAME").attempts === 0, "Defer charged an attempt");
      if (key === "park") check(dispatcher.virtualSeconds === 21600 && row("SCHEDULE/PARK").status === "COMPLETED", "Park did not wait for its time");
      if (key === "branch") check(auditLog.filter(entry => entry.wasOverride).length === 1, "Expected one undeclared transition");
      if (key === "crash") {
        const step = "WORKSPACE/IMPORT_DATA";
        check(external.calls[step] === 1 && row(step).dispatchCount === 2, "Crash recovery repeated the external call");
        check(auditLog.every(entry => entry.step !== step || entry.dispatch !== 1), "Crashed dispatch has an audit entry");
      }
      if (key === "exhausted") {
        check(row("WORKSPACE/RELEASE_NAME").status === "COMPLETED" && instance.status === "ACTIVE", "Operator retry did not resume the flow");
        check(auditLog.some(entry => entry.actor === "operator"), "Operator retry is not in the audit log");
      }
      if (key === "failed") {
        check(instance.status === "FAILED" && row("VERIFICATION/VERIFY").status === "FAILED", "Handler failure did not stop the flow");
        check(row("VERIFICATION/VERIFY").attempts === 0 && row("VERIFICATION/VERIFY").nextAt === null, "Handler failure charged an attempt or left a timer");
      }
      if (key === "timeout") check(!dispatcher.workers[0].alive && row("WORKSPACE/RELEASE_NAME").lastError === "timeout", "Timeout was not recorded");
      if (key === "unhosted") check(dispatcher.workers.length === 3 && dispatcher.unhostedStages.length === 0, "Stage is still unhosted");
      if (scenario.steps.length > 3) {
        document.querySelector(".timeline .text-button").click();
        await pause();
        check(document.querySelectorAll(".timeline li").length === scenario.steps.length, "Timeline expansion failed");
        checkLayout(`${key}, timeline`);
        const timeline = document.querySelector(".timeline");
        if (innerWidth >= 1000 && innerHeight >= 600) {
          timeline.scrollTop = timeline.scrollHeight;
          const last = timeline.querySelector("li:last-child").getBoundingClientRect();
          check(last.bottom <= timeline.getBoundingClientRect().bottom + 1, "Latest timeline entry is unreachable");
        }
      }
      result.scenarios.push(key);
    }
    await select("normal");
    document.querySelectorAll(".playback-controls button")[1].click();
    await waitFor(() => document.querySelector(".stage-label").textContent.includes("1 / 4"), "Playback did not advance");
    document.querySelectorAll(".playback-controls button")[1].click();
    const pausedStage = document.querySelector(".stage-label").textContent;
    await new Promise(resolve => setTimeout(resolve, 2000));
    check(document.querySelector(".stage-label").textContent === pausedStage, "Pause did not stop playback");
    document.querySelectorAll(".playback-controls button")[2].click();
    await pause();
    check(document.querySelector(".stage-label").textContent.includes("0 / 4"), "Reset failed");
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
const temporary = mkdtempSync(join(tmpdir(), "workflow-browser-"));
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
    try {
      const result = await send("Runtime.evaluate", {
        expression: `document.readyState === 'complete' && document.querySelector('h1')?.textContent === ${JSON.stringify(title)}`, returnByValue: true,
      }, sessionId);
      if (result.result.value) return;
    } catch (error) {
      if (!/Cannot find context|Execution context was destroyed|Inspected target navigated/.test(error.message)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Page did not render: ${title}`);
}
const timeout = setTimeout(() => { chrome.kill(); throw new Error("Browser verification timed out"); }, 180000);
try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  const evaluate = async expression => (await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result.value;
  async function capture(file, width, height) {
    const image = await send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 },
    }, sessionId);
    writeFileSync(resolve(`qa/${file}.png`), Buffer.from(image.data, "base64"));
  }
  for (const [name, width, height] of [["desktop", 1487, 1058], ["laptop", 1366, 768], ["compact", 1024, 640], ["mobile", 390, 844]]) {
    consoleErrors.length = 0;
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: name === "mobile" }, sessionId);
    await send("Page.navigate", { url: pathToFileURL(page).href }, sessionId);
    let result;
    for (let attempt = 0; attempt < 1200; attempt += 1) {
      const value = await evaluate('document.getElementById("browser-check-result")?.textContent');
      if (value) {
        result = JSON.parse(decodeURIComponent(value));
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(result, `${name}: Browser check did not complete`);
    result.consoleErrors = [...consoleErrors];
    writeFileSync(`qa/${name}.json`, JSON.stringify(result, null, 2));
    await capture(name, width, height);
    assert.ok(result.passed, `${name}: ${result.error}`);
    assert.equal(result.viewport.width, width);
    assert.equal(result.viewport.height, height);
    assert.deepEqual(consoleErrors, []);
    console.log(`${name}: all ${Object.keys(scenarios).length} scenarios and core controls passed; viewport ${width} × ${height}`);

    await send("Page.navigate", { url: indexUrl }, sessionId);
    await waitForHeading("Design guides", sessionId);
    const indexState = await evaluate("({href: document.querySelector('[data-guide=workflow]').getAttribute('href'), overflow: document.documentElement.scrollWidth > innerWidth})");
    assert.equal(indexState.href, "./workflow/");
    assert.equal(indexState.overflow, false);
    await capture(`index-${name}`, width, height);
    await evaluate("document.querySelector('[data-guide=workflow]').click()");
    await waitForHeading("Workflow step flow", sessionId);
    assert.equal(await evaluate("location.pathname"), "/design/workflow/");
    await evaluate("document.querySelector('.guides-link').click()");
    await waitForHeading("Design guides", sessionId);
    assert.deepEqual(consoleErrors, []);
    console.log(`${name}: design index, workflow asset loading, and return navigation passed`);

    await evaluate("document.querySelector('[data-guide=workflow]').parentElement.querySelector('.read-guide').click()");
    await waitForHeading("Durable Workflow Engine Playbook", sessionId);
    const guideState = await evaluate(`({
      overflow: document.documentElement.scrollWidth > innerWidth,
      sections: document.querySelectorAll('article h2').length,
      tables: document.querySelectorAll('.table-scroll table').length,
      codeBlocks: document.querySelectorAll('pre code').length,
      stepBoxes: document.querySelectorAll('.steps > li').length,
      contentsValid: [...document.querySelectorAll('.guide-sidebar a, .mobile-toc a')].every(link => document.getElementById(link.hash.slice(1))),
      section: document.querySelector('.breadcrumbs span').textContent,
      playground: new URL(document.querySelector('.playground-link').href).pathname
    })`);
    assert.equal(guideState.overflow, false);
    assert.ok(guideState.sections >= 10);
    assert.ok(guideState.tables > 0);
    assert.ok(guideState.codeBlocks > 0);
    assert.equal(guideState.stepBoxes, 2);
    assert.equal(guideState.contentsValid, true);
    assert.equal(guideState.section, "DWE");
    assert.equal(guideState.playground, "/design/workflow/");
    if (name === "mobile") await evaluate("document.querySelector('.mobile-toc summary').click()");
    await evaluate(`document.querySelector('${name === "mobile" ? ".mobile-toc" : ".guide-sidebar"} a').click()`);
    assert.ok((await evaluate("location.hash")).length > 1);
    await evaluate("document.querySelector('.mobile-toc').open = false; window.scrollTo(0, 0)");
    await capture(`guide-${name}`, width, height);
    await evaluate("document.querySelector('.playground-link').click()");
    await waitForHeading("Workflow step flow", sessionId);
    await evaluate("document.querySelector('.guides-link').click()");
    await waitForHeading("Design guides", sessionId);
    assert.deepEqual(consoleErrors, []);
    console.log(`${name}: HTML guide, contents anchors, tables, code blocks, and playground navigation passed`);
  }
  await send("Page.navigate", { url: indexUrl + "workflow/" }, sessionId);
  await waitForHeading("Workflow step flow", sessionId);
  for (const [width, height] of [[601, 844], [1024, 500]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await new Promise(resolve => setTimeout(resolve, 100));
    const controls = await evaluate(`({
      overflow: document.documentElement.scrollWidth > innerWidth,
      visible: [...document.querySelectorAll('.controls button')].every(button => {
        const rect = button.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
      })
    })`);
    assert.equal(controls.overflow, false, `${width} × ${height}: horizontal overflow`);
    assert.equal(controls.visible, true, `${width} × ${height}: controls outside viewport`);
  }
  await send("Emulation.setDeviceMetricsOverride", { width: 1800, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Runtime.evaluate", {
    expression: `(async () => {
      const pause = () => new Promise(resolve => setTimeout(resolve, 50));
      const select = document.querySelector('#scenario');
      select.value = 'flow';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await pause();
      for (let step = 0; step < ${scenarios.flow.steps.length}; step += 1) {
        document.querySelector('.primary-button').click();
        await pause();
      }
    })()`, awaitPromise: true,
  }, sessionId);
  assert.equal(await evaluate("document.querySelector('.primary-button').disabled"), true);
  await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 640, deviceScaleFactor: 1, mobile: false }, sessionId);
  await new Promise(resolve => setTimeout(resolve, 100));
  const currentVisible = await evaluate(`(() => {
    const strip = document.querySelector('.chips').getBoundingClientRect();
    const chip = document.querySelector('.chip-current').getBoundingClientRect();
    return chip.left >= strip.left - 1 && chip.right <= strip.right + 1;
  })()`);
  assert.equal(currentVisible, true, "Current step hidden after resizing a completed flow");
  assert.deepEqual(consoleErrors, []);
  console.log("Window resize: narrow and short controls and the completed flow's current step remain visible");
} finally {
  clearTimeout(timeout);
  chrome.kill();
  siteServer.close();
}
