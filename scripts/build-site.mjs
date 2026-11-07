import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml, renderGuide } from "../outbox-to-stream/playground/scripts/render-guide.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist/site");
const eda = resolve(root, "outbox-to-stream/playground/dist/client");

if (!existsSync(resolve(eda, "index.html"))) throw new Error("Build the EDA playground before assembling the site.");
mkdirSync(output, { recursive: true });
copyFileSync(resolve(root, "site/index.html"), resolve(output, "index.html"));
cpSync(eda, resolve(output, "eda"), { recursive: true });
const guide = renderGuide(readFileSync(resolve(root, "outbox-to-stream/Outbox-to-Stream Playbook.md"), "utf8"));
const template = readFileSync(resolve(root, "site/guide.html"), "utf8");
const values = {
  title: escapeHtml(guide.title), toc: guide.toc, content: guide.html,
  styles: readFileSync(resolve(root, "site/guide.css"), "utf8"),
};
const html = template.replace(/\{\{(title|toc|content|styles)\}\}/g, (_, key) => values[key]);
mkdirSync(resolve(output, "eda/guide"), { recursive: true });
writeFileSync(resolve(output, "eda/guide/index.html"), html);
console.log("Built design index, EDA playground, and HTML playbook in dist/site/.");
