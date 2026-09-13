#!/usr/bin/env node
// CI: verify every declared `bin` path exists on disk.
// Run after the build step — some bins (e.g. ultracontext-mcp → dist/stdio.mjs)
// only exist once their package has been built.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const PACKAGES = [
  "packages/core",
  "packages/storage",
  "packages/parsers",
  "apps/sync",
  "apps/api",
  "apps/js-sdk",
  "apps/mcp-server",
];

let checked = 0;
let failed = false;

for (const pkg of PACKAGES) {
  const manifestPath = path.join(root, pkg, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest.bin) continue;

  const bins = typeof manifest.bin === "string"
    ? { [manifest.name]: manifest.bin }
    : manifest.bin;

  for (const [name, rel] of Object.entries(bins)) {
    const file = path.join(root, pkg, rel);
    const ok = existsSync(file);
    checked++;
    console.log(`${ok ? "ok  " : "FAIL"} ${manifest.name}: bin "${name}" → ${rel}`);
    if (!ok) failed = true;
  }
}

if (failed) {
  console.error(`\n${checked} bin path(s) checked — at least one missing.`);
  process.exit(1);
}
console.log(`\n${checked} declared bin path(s) all exist.`);
