import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml, renderGuide } from "../outbox-to-stream/playground/scripts/render-guide.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist/site");
const guides = [
  {
    slug: "eda", folder: "outbox-to-stream", markdown: "Outbox-to-Stream Playbook.md", section: "EDA",
    description: "A practical guide to transactional outbox design, durable stream delivery, retries, and idempotent consumers.",
  },
  {
    slug: "workflow", folder: "durable-workflow", markdown: "Durable Workflow Engine Playbook.md", section: "DWE",
    description: "A practical guide to a database-backed durable workflow engine: step runs, outcomes, timers, worker groups, and versioned flow definitions.",
  },
];

for (const { slug, folder } of guides) {
  if (!existsSync(resolve(root, folder, "playground/dist/client/index.html"))) throw new Error(`Build the ${slug} playground before assembling the site.`);
}
mkdirSync(output, { recursive: true });
copyFileSync(resolve(root, "site/index.html"), resolve(output, "index.html"));
const template = readFileSync(resolve(root, "site/guide.html"), "utf8");
const styles = readFileSync(resolve(root, "site/guide.css"), "utf8");
for (const { slug, folder, markdown, section, description } of guides) {
  cpSync(resolve(root, folder, "playground/dist/client"), resolve(output, slug), { recursive: true });
  const guide = renderGuide(readFileSync(resolve(root, folder, markdown), "utf8"));
  const values = {
    title: escapeHtml(guide.title), toc: guide.toc, content: guide.html, styles,
    description: escapeHtml(description), section: escapeHtml(section),
    source: `https://github.com/yavosh/design/blob/main/${folder}/${encodeURIComponent(markdown)}`,
  };
  const html = template.replace(/\{\{(title|toc|content|styles|description|section|source)\}\}/g, (_, key) => values[key]);
  mkdirSync(resolve(output, slug, "guide"), { recursive: true });
  writeFileSync(resolve(output, slug, "guide/index.html"), html);
}
console.log("Built design index, playgrounds, and HTML playbooks in dist/site/.");
