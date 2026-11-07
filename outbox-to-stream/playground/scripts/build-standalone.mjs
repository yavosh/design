import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve("dist/client");
let html = readFileSync(resolve(root, "index.html"), "utf8");
html = html.replace(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g, (_, source) => {
  const script = readFileSync(resolve(root, source.replace(/^\//, "")), "utf8");
  return `<script type="module">${script}</script>`;
});
html = html.replace(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/g, (_, source) => {
  return `<style>${readFileSync(resolve(root, source.replace(/^\//, "")), "utf8")}</style>`;
});
writeFileSync(resolve("dist/playground.html"), html);
console.log("Prepared standalone preview: dist/playground.html");
