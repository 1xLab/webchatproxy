#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ResourceCatalog } from "./providers/chatgpt/resource-catalog.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeDir = process.env.WEBCHAT_RUNTIME_DIR || join(here, "runtime");
const catalog = await new ResourceCatalog({ runtimeDir }).init();
const [command = "list", arg] = process.argv.slice(2);

if (command === "list") {
  process.stdout.write(`${JSON.stringify({ projects: catalog.listProjects() }, null, 2)}\n`);
  process.exit(0);
}

if (command === "import") {
  if (!arg) {
    console.error("Usage: node catalog.mjs import <projects.json>");
    process.exit(2);
  }
  const input = JSON.parse(await readFile(resolve(arg), "utf8"));
  const result = await catalog.importProjects(input, { source: "admin_cli" });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

if (command === "resolve") {
  if (!arg) {
    console.error("Usage: node catalog.mjs resolve <project-id|alias|url>");
    process.exit(2);
  }
  const project = catalog.resolveProject(arg);
  process.stdout.write(`${JSON.stringify({ project }, null, 2)}\n`);
  process.exit(project ? 0 : 1);
}

console.error("Usage: node catalog.mjs [list|import <projects.json>|resolve <project>]");
process.exit(2);
