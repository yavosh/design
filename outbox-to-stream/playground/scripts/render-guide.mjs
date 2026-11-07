import { Marked, Renderer } from "marked";

export function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

export function renderGuide(markdown) {
  const start = markdown.search(/^# /m);
  if (start < 0) throw new Error("A guide needs a level-one title.");
  // Replace the Markdown's manually maintained contents with links to actual headings.
  const source = markdown.slice(start);
  const headings = [];
  const identifiers = new Map();
  const principles = new Set(["Atomic", "At least once", "Effect once", "Independent", "Loosely ordered", "Durable"]);
  const callouts = new Set(["Principle", "Trap", "Contract", "Don't copy", "Offset-based brokers"]);
  const renderer = new Renderer();
  renderer.heading = function (token) {
    const slug = token.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
    const count = identifiers.get(slug) ?? 0;
    identifiers.set(slug, count + 1);
    const id = count ? `${slug}-${count}` : slug;
    if (token.depth === 2) headings.push({ id, text: token.text });
    return `<h${token.depth} id="${id}">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
  };
  renderer.table = function (token) {
    return `<div class="table-scroll" role="region" aria-label="Reference table" tabindex="0">${Renderer.prototype.table.call(this, token)}</div>\n`;
  };
  renderer.paragraph = function (token) {
    if (principles.has(token.text)) return `<p class="principle-label">${escapeHtml(token.text)}</p>\n`;
    if (callouts.has(token.text)) {
      const kind = token.text === "Trap" || token.text === "Don't copy" ? "warning" : "note";
      return `<p class="callout-label ${kind}">${escapeHtml(token.text)}</p>\n`;
    }
    return Renderer.prototype.paragraph.call(this, token);
  };
  const html = new Marked({ renderer, gfm: true }).parse(source);
  const title = source.split("\n")[0].slice(2).trim();
  const toc = headings.map(({ id, text }) => `<li><a href="#${id}">${escapeHtml(text)}</a></li>`).join("\n");
  return { html, toc, title };
}
