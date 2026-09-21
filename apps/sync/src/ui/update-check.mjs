// === ui/update-check.mjs — silent npm registry update check for the TUI ===
// Owns: reading the running TUI's version from package.json (dev builds fall
// back to the js-sdk package), fetching the latest published version from the
// npm registry with a 3s abort budget, the semver-ish isNewerVersion compare,
// and the silent check that raises the in-UI update prompt. Extracted verbatim
// from tui.mjs (ARCH-005); APP_ROOT and the ui/renderDashboard closure became
// the factory's injected dependencies. There is deliberately no cache — every
// invocation checks, like Claude Code.

import fsSync from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * Version of the running TUI. `appRoot` is the package root whose
 * package.json carries the version; under ULTRACONTEXT_DEV the js-sdk
 * (the published package) is preferred over the sync package itself.
 */
export function readTuiVersion(appRoot) {
  try {
    // in dev, read from js-sdk (the published package)
    const candidates = process.env.ULTRACONTEXT_DEV
      ? [path.resolve(appRoot, "..", "js-sdk", "package.json"), path.resolve(appRoot, "package.json")]
      : [path.resolve(appRoot, "package.json")];
    for (const p of candidates) {
      try { return JSON.parse(fsSync.readFileSync(p, "utf8")).version ?? "unknown"; } catch {}
    }
    return "unknown";
  } catch { return "unknown"; }
}

export async function fetchLatestVersion() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch("https://registry.npmjs.org/ultracontext/latest", { signal: controller.signal });
    const data = await res.json();
    return data.version ?? null;
  } catch { return null; }
  finally { clearTimeout(timeout); }
}

export function isNewerVersion(latest, current) {
  const l = latest.split(".").map(Number);
  const c = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

export const UPDATE_PROMPT_OPTIONS = [
  { id: "install", label: "Install now" },
  { id: "skip", label: "Skip" },
];

/** Silent update check; mutates ui.updatePrompt and forces a rerender on a hit. */
export function createUpdateChecker({ appRoot, ui, renderDashboard }) {

  async function checkForUpdateSilent() {
    if (process.env.ULTRACONTEXT_DEV) return;
    const current = readTuiVersion(appRoot);
    if (current === "unknown") return;

    const notifyUpdate = (latest) => {
      ui.updateAvailable = latest;
      ui.updatePrompt.active = true;
      ui.updatePrompt.selectedIndex = 0;
      ui.updatePrompt.latestVersion = latest;
      renderDashboard();
    };

    // fetch from registry every invocation
    const latest = await fetchLatestVersion();
    if (latest && isNewerVersion(latest, current)) {
      notifyUpdate(latest);
    }
  }

  return { checkForUpdateSilent };
}
