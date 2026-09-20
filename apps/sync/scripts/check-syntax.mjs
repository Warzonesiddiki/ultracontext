#!/usr/bin/env node
// `pnpm --filter @ultracontext/sync check` — syntax-check every module in src/.
//
// This package is plain ESM JavaScript with no type-checker, so the only
// mechanical gate it has is `node --check`. That used to be a hand-written
// chain of 13 filenames in package.json, which silently skipped anything new:
// by ARCH-003 the src/ui/ tree (30 modules), dev.mjs and Spinner.mjs were not
// covered at all, and the six modules extracted from daemon.mjs would have had
// to be appended by hand.
//
// So the list is derived from the filesystem instead. Adding a module — here or
// anywhere else in the repo that grows one — cannot forget to register itself.

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(packageRoot, "src");

/** Every .mjs under src/, depth-first, sorted so the output is stable. */
function collectModules(dir) {
  const found = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...collectModules(full));
    else if (entry.endsWith(".mjs")) found.push(full);
  }
  return found;
}

const modules = collectModules(srcDir);
let failed = 0;

for (const file of modules) {
  const relative = path.relative(packageRoot, file);
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  const ok = result.status === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${relative}`);
  if (!ok) {
    const stderr = String(result.stderr ?? "").trim();
    if (stderr) console.error(stderr.split("\n").map((line) => `       ${line}`).join("\n"));
  }
}

if (failed > 0) {
  console.error(`\n${modules.length} module(s) checked — ${failed} failed to parse.`);
  process.exit(1);
}
console.log(`\n${modules.length} module(s) in src/ all parse.`);
