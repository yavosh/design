import { cpSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist/site");
const eda = resolve(root, "outbox-to-stream/playground/dist/client");

if (!existsSync(resolve(eda, "index.html"))) throw new Error("Build the EDA playground before assembling the site.");
mkdirSync(output, { recursive: true });
copyFileSync(resolve(root, "site/index.html"), resolve(output, "index.html"));
cpSync(eda, resolve(output, "eda"), { recursive: true });
console.log("Built design index at dist/site/index.html and EDA guide at dist/site/eda/.");
