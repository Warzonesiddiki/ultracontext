// === ui/config-editor.mjs — the Configs tab controller ===
// Owns: the toggle-item model rendered by the Configs tab (sync profile enum,
// resume terminal enum, bootstrap-reset action), selection movement, and the
// toggle semantics — enum cycles mutate cfg then persist via the TUI prefs
// writer, the reset action persists prefs first and then stamps the one-shot
// bootstrapReset command into the daemon's config.json via writeConfigKey.
// Extracted verbatim from tui.mjs (ARCH-005); the cfg/ui closures became the
// factory's injected dependencies and persistConfigPrefs arrives via `prefs`
// (createTuiConfigPrefs) so the editor and the file I/O share one writer.

import { normalizeBootstrapModeWithPrompt } from "../config.mjs";
import { errorDetails } from "../logger.mjs";
import {
  CONFIG_BOOTSTRAP_MODES,
  CONFIG_RESUME_TERMINALS,
  bootstrapModeConfigLabel,
  normalizeResumeTerminal,
  resumeTerminalConfigLabel,
  writeConfigKey,
} from "./config-file.mjs";

export function createConfigEditor({ cfg, ui, prefs, renderDashboard }) {

  function configToggleItems() {
    const normalizedBootstrapMode = normalizeBootstrapModeWithPrompt(cfg.bootstrapMode) || "prompt";
    return [
      {
        key: "bootstrapMode",
        kind: "enum",
        label: "Sync profile",
        description: "Defines bootstrap strategy for next daemon startup/reset.",
        value: normalizedBootstrapMode,
        valueLabel: bootstrapModeConfigLabel(normalizedBootstrapMode),
        blockedByMaster: false
      },
      {
        key: "resumeTerminal",
        kind: "enum",
        label: "Resume terminal",
        description: "Choose where resume opens (Terminal, Ghostty, or Warp).",
        value: normalizeResumeTerminal(cfg.resumeTerminal),
        valueLabel: resumeTerminalConfigLabel(cfg.resumeTerminal),
        blockedByMaster: false
      },
      {
        key: "bootstrapResetState",
        kind: "action",
        label: "Reset bootstrap state",
        description: "Clears daemon bootstrap state so re-bootstrap can run again.",
        value: "run",
        valueLabel: "RUN",
        blockedByMaster: false
      }
    ];
  }

  function moveConfigSelection(delta) {
    const items = configToggleItems();
    const total = items.length;
    if (!total) return;
    const next = ui.configEditor.selectedIndex + delta;
    if (next < 0) {
      ui.configEditor.selectedIndex = total - 1;
      return;
    }
    if (next >= total) {
      ui.configEditor.selectedIndex = 0;
      return;
    }
    ui.configEditor.selectedIndex = next;
  }

  async function toggleSelectedConfig() {
    const items = configToggleItems();
    if (items.length === 0) return;

    const selected = Math.max(Math.min(ui.configEditor.selectedIndex, items.length - 1), 0);
    const item = items[selected];

    try {
      // bootstrap reset — persist prefs first, then add flag on top so it isn't clobbered
      if (item.kind === "action" && item.key === "bootstrapResetState") {
        await prefs.persistConfigPrefs();
        const ok = writeConfigKey("bootstrapReset", true);
        ui.resume.notice = ok
          ? "Bootstrap reset requested. Daemon will apply next cycle."
          : "Failed to write config.";
        renderDashboard();
        return;
      }

      // bootstrap mode cycle — spawn CLI config set
      if (item.kind === "enum" && item.key === "bootstrapMode") {
        const currentIndex = Math.max(CONFIG_BOOTSTRAP_MODES.findIndex((entry) => entry.id === item.value), 0);
        const next = CONFIG_BOOTSTRAP_MODES[(currentIndex + 1) % CONFIG_BOOTSTRAP_MODES.length];
        cfg.bootstrapMode = next.id;
        cfg.bootstrapReset = next.id === "prompt";

        const saved = await prefs.persistConfigPrefs();
        ui.resume.notice = `Sync profile set: ${next.label}${saved.fileSaved ? " (saved)" : ""}.`;
        renderDashboard();
        return;
      }

      // resume terminal cycle — local only
      if (item.kind === "enum" && item.key === "resumeTerminal") {
        const current = normalizeResumeTerminal(item.value);
        const currentIndex = Math.max(CONFIG_RESUME_TERMINALS.findIndex((entry) => entry.id === current), 0);
        const next = CONFIG_RESUME_TERMINALS[(currentIndex + 1) % CONFIG_RESUME_TERMINALS.length];
        cfg.resumeTerminal = next.id;
        const saved = await prefs.persistConfigPrefs();
        ui.resume.notice = `Resume terminal: ${next.label}${saved.fileSaved ? " (saved)" : ""}.`;
        renderDashboard();
        return;
      }

      // boolean toggles
      if (item.kind === "boolean") {
        cfg[item.key] = !cfg[item.key];
      }
    } catch (error) {
      const details = errorDetails(error);
      ui.resume.notice = `Failed to apply config: ${details.message}`;
      renderDashboard();
    }
  }

  return { configToggleItems, moveConfigSelection, toggleSelectedConfig };
}
