// CLI handler for `ultracontext serve` — run the whole product locally, free.
//
// UltraContext is 100% free and self-hosted. `serve` starts the context API,
// the MCP endpoint, and full-text search against a local SQLite file. No Docker,
// no Postgres, no account, no network.
//
// The server itself lives in the `ultracontext-api` package (apps/api). We look
// for it in the installed tree first, then in the monorepo, and otherwise tell
// the user exactly how to run it themselves.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const isTTY = Boolean(process.stdout.isTTY);
const esc = (code) => (isTTY ? `\x1b[${code}m` : "");
const r = esc(0);
const b = esc(1);
const d = esc(2);
const cyan = "\x1b[36m";
const gray = "\x1b[2m";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// walk up from this file looking for a package that can serve
function findApiPackage() {
    // 1 — installed alongside us (published layout)
    try {
        const resolved = require.resolve("ultracontext-api/package.json");
        return path.dirname(resolved);
    } catch {
        // fall through
    }

    // 2 — monorepo: walk up until we find <dir>/api/src/serve.ts.
    // The depth is NOT fixed — from src this file lives at
    // apps/js-sdk/src/cli (3 up) but the built bundle is emitted at
    // apps/js-sdk/dist (4 up), and bundlers may relocate chunks again.
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
        const candidate = path.join(dir, "api");
        if (fs.existsSync(path.join(candidate, "src", "serve.ts"))) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    return null;
}

function run(cwd, bin, args) {
    return new Promise((resolve) => {
        const child = spawn(bin, args, { cwd, stdio: "inherit", env: process.env });
        child.on("exit", (code) => resolve(code ?? 1));
    });
}

export async function runServe(argv = []) {
    const apiDir = findApiPackage();

    if (!apiDir) {
        console.error(`${b}ultracontext serve${r} needs the context server package.\n`);
        console.error(`Run it from a clone of the repository:\n`);
        console.error(`  ${cyan}git clone https://github.com/ultracontext/ultracontext.git${r}`);
        console.error(`  ${cyan}cd ultracontext && pnpm install && pnpm ultracontext:serve${r}\n`);
        console.error(`${gray}UltraContext is free and self-hosted — the server ships with the source.${r}`);
        process.exit(1);
    }

    const portIdx = argv.indexOf("--port");
    if (portIdx !== -1) {
        const port = Number(argv[portIdx + 1]);
        if (!Number.isInteger(port) || port <= 0) {
            console.error("--port requires a positive integer");
            process.exit(1);
        }
    }

    const tsx = path.join(apiDir, "node_modules", ".bin", "tsx");
    const entry = path.join(apiDir, "src", "serve.ts");

    if (fs.existsSync(tsx) && fs.existsSync(entry)) {
        process.exit(await run(apiDir, tsx, [entry, ...argv]));
    }

    console.error(`Found the API package at ${apiDir} but could not find tsx or ${entry}.`);
    console.error(`Try: ${cyan}cd ${apiDir} && pnpm install${r}`);
    process.exit(1);
}
