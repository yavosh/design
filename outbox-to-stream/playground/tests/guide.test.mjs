import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderGuide } from "../scripts/render-guide.mjs";

test("the playbook renders its sections, tables, code, and callouts", () => {
  const markdown = readFileSync(new URL("../../Outbox-to-Stream Playbook.md", import.meta.url), "utf8");
  const { html, toc, title } = renderGuide(markdown);
  assert.equal(title, "Outbox-to-Stream Playbook");
  assert.equal((html.match(/<h1 /g) ?? []).length, 1);
  assert.equal((html.match(/<h2 /g) ?? []).length, (markdown.match(/^## /gm) ?? []).length);
  assert.ok(html.includes('<div class="table-scroll"'));
  assert.ok(html.includes('<code class="language-json">'));
  assert.ok(html.includes('<code>claim_token</code>'));
  assert.ok(html.includes('class="callout-label warning">Trap'));
  const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map(match => match[1]));
  for (const [, id] of toc.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(id), `Missing target: ${id}`);
  assert.ok(!html.includes('href="#why"'), "The old contents links must not survive conversion");
});

test("the workflow playbook renders its sections, tables, code, and callouts", () => {
  const markdown = readFileSync(new URL("../../../durable-workflow/Durable Workflow Engine Playbook.md", import.meta.url), "utf8");
  const { html, toc, title } = renderGuide(markdown);
  assert.equal(title, "Durable Workflow Engine Playbook");
  assert.ok(html.includes('<ol class="steps">'));
  assert.equal((html.match(/<h1 /g) ?? []).length, 1);
  assert.equal((html.match(/<h2 /g) ?? []).length, (markdown.match(/^## /gm) ?? []).length);
  assert.ok(html.includes('<div class="table-scroll"'));
  assert.ok(html.includes('<code class="language-json">'));
  assert.ok(html.includes('class="callout-label warning">Trap'));
  const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map(match => match[1]));
  for (const [, id] of toc.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(id), `Missing target: ${id}`);
});

test("a steps block renders titled boxes with numbered steps instead of a code block", () => {
  const { html } = renderGuide("# Guide\n\n```steps\nFirst <box>\n  One & two.\n\n  Three.\nSecond box\n  Four.\n```\n\n```text\nPlain.\n```\n");
  const steps = html.slice(html.indexOf('<ol class="steps">'), html.indexOf("<pre>"));
  assert.equal((steps.match(/<p class="steps-title">/g) ?? []).length, 2);
  assert.equal((steps.match(/<li>/g) ?? []).length, 5);
  assert.ok(steps.includes('<p class="steps-title">First &lt;box&gt;</p><ol><li>One &amp; two.</li><li>Three.</li></ol>'));
  assert.equal((html.match(/<pre>/g) ?? []).length, 1);
  assert.ok(html.includes('<pre><code class="language-text">Plain.'));
  assert.throws(() => renderGuide("# Guide\n\n```steps\n  No box yet.\n```\n"), /box title/);
});

test("repeated headings receive unique, matching contents targets", () => {
  const { html, toc } = renderGuide("# Guide\n\n## Same heading\n\nFirst.\n\n## Same heading\n\nSecond.\n");
  assert.ok(html.includes('id="same-heading"'));
  assert.ok(html.includes('id="same-heading-1"'));
  assert.ok(toc.includes('href="#same-heading"'));
  assert.ok(toc.includes('href="#same-heading-1"'));
});

test("code examples remain escaped instead of becoming page markup", () => {
  const { html } = renderGuide('# Guide\n\n```html\n<button>example & text</button>\n```\n');
  assert.ok(html.includes('&lt;button&gt;example &amp; text&lt;/button&gt;'));
  assert.ok(!html.includes('<button>'));
});
