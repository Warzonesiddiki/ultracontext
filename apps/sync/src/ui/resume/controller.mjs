// === ui/resume/controller.mjs — the resume feature's stateful controller ===
// Owns: everything that mutates ui.resume / ui.resumeTargetPicker and the
// runtime resume bookkeeping (known-context ids, title cache + inflight set) —
// loading contexts from UltraContext, background title enrichment, source
// filter cycling, selection movement, the resume-target picker, and the
// end-to-end resumeSelectedContext flow (fetch → summary/snapshot/command
// files under resumeOutputDir → plan → terminal launch). Extracted verbatim
// from tui.mjs (ARCH-005); the boot closures became injected dependencies and
// the pure helpers live in ./context-helpers.mjs, ./plans.mjs and
// ./terminal-launch.mjs.

import fs from "node:fs/promises";
import path from "node:path";

import { errorDetails } from "../../logger.mjs";

import {
  RESUME_TARGET_OPTIONS,
  SOURCE_FILTERS,
  isCodingContextSource,
  recommendedResumeTargetForContext,
  resumeAgentLabel,
  resumeContextSource,
  resumeDedupeById,
  resumeExtractSessionCwd,
  resumeFilterContexts,
  resumeSortContexts,
  resumeSummaryMarkdown,
  resumeTargetAgent,
  resumeTargetOptionsForSource,
} from "./context-helpers.mjs";
import {
  buildClaudeResumePlan,
  buildCodexResumePlan,
  resumeResolveWorkingDirectory,
} from "./plans.mjs";

export function createResumeController({ cfg, ui, runtime, renderDashboard, markDirty, terminalLauncher }) {

  // client-side filter by source agent (applied on already-loaded contexts)
  function applySourceFilter() {
    const filter = ui.resume.sourceFilter;
    if (filter === "all") {
      ui.resume.filteredContexts = ui.resume.contexts;
    } else {
      ui.resume.filteredContexts = ui.resume.contexts.filter((ctx) => {
        const source = String(ctx?.metadata?.source ?? "").toLowerCase();
        return source === filter;
      });
    }
    if (ui.resume.selectedIndex >= ui.resume.filteredContexts.length) {
      ui.resume.selectedIndex = Math.max(ui.resume.filteredContexts.length - 1, 0);
    }
  }

  function cycleSourceFilter() {
    const current = ui.resume.sourceFilter;
    const idx = SOURCE_FILTERS.indexOf(current);
    ui.resume.sourceFilter = SOURCE_FILTERS[(idx + 1) % SOURCE_FILTERS.length];
    applySourceFilter();
    renderDashboard();
  }

  // fetch titles for contexts missing md.title (background, non-blocking)
  function enrichContextTitles(contexts) {
    const missing = contexts.filter(ctx =>
      ctx?.id && !ctx?.metadata?.title && !runtime.titleCache.has(ctx.id) && !runtime.titleInflight.has(ctx.id)
    ).slice(0, 20);
    if (!missing.length || !runtime.uc) return;

    for (const ctx of missing) {
      runtime.titleInflight.add(ctx.id);
      runtime.uc.get(ctx.id, { at: 30 }).then(res => {
        const msgs = res?.data ?? [];

        // skip system-injected user messages (AGENTS.md, openclaw session init)
        const isRealUser = m => {
          if (m?.role !== "user") return false;
          if (m?.content?.event_type === "response_item.message") return false;
          const msg = typeof m?.content?.message === "string" ? m.content.message : "";
          if (msg.startsWith("A new session was started")) return false;
          if (msg.startsWith("[result]")) return false;
          if (msg.startsWith("<")) return false;
          return true;
        };

        const firstUser = msgs.find(isRealUser) ?? msgs.find(m => m?.role === "user");
        if (!firstUser) { runtime.titleCache.set(ctx.id, null); return; }
        const text = firstUser?.content?.message ?? firstUser?.content ?? "";
        const title = (typeof text === "string" ? text : JSON.stringify(text)).replace(/[\r\n\t\v\f\x00-\x1f]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 120);
        runtime.titleCache.set(ctx.id, title || null);
        if (title) {
          ctx.metadata = { ...ctx.metadata, title };
          markDirty();
        }
      }).catch(() => { runtime.titleCache.set(ctx.id, null); }).finally(() => runtime.titleInflight.delete(ctx.id));
    }
  }

  async function loadResumeContexts({ silent = false } = {}) {
    if (!runtime.uc || ui.resume.loading) return;
    ui.resume.loading = true;
    if (!silent) {
      ui.resume.error = "";
      ui.resume.notice = "Loading contexts from UltraContext...";
      renderDashboard();
    }

    try {
      const listed = await runtime.uc.get({ limit: Math.max(cfg.resumeContextLimit, 1) });
      const filtered = resumeSortContexts(resumeFilterContexts(resumeDedupeById(listed.data), cfg.resumeSourceFilter));
      const nextIds = new Set(filtered.map((ctx) => String(ctx?.id ?? "")).filter(Boolean));
      let newContextCount = 0;
      if (runtime.resumeBaselineReady) {
        for (const id of nextIds) {
          if (!runtime.resumeKnownContextIds.has(id)) newContextCount += 1;
        }
      }
      runtime.resumeKnownContextIds = nextIds;
      if (!runtime.resumeBaselineReady) runtime.resumeBaselineReady = true;

      // apply cached titles + fetch missing ones in background
      for (const ctx of filtered) {
        const cached = runtime.titleCache.get(ctx.id);
        if (cached && !ctx.metadata?.title) ctx.metadata = { ...ctx.metadata, title: cached };
      }
      ui.resume.contexts = filtered;
      applySourceFilter();
      if (!silent) enrichContextTitles(filtered);
      ui.resume.loadedAt = Date.now();

      const sourceCounts = { codex: 0, claude: 0, openclaw: 0, cursor: 0, gemini: 0, other: 0 };
      for (const ctx of filtered) {
        const source = String(ctx?.metadata?.source ?? "").toLowerCase();
        if (sourceCounts[source] !== undefined) sourceCounts[source] += 1;
        else sourceCounts.other += 1;
      }

      if (!silent) {
        const filterLabel = cfg.resumeSourceFilter === "all" ? "all sources" : cfg.resumeSourceFilter;
        const counts = Object.entries(sourceCounts).map(([k, v]) => `${k}=${v}`).join(", ");
        ui.resume.notice = `Loaded ${filtered.length} session contexts (${filterLabel}: ${counts})`;
        if (filtered.length === 0) {
          ui.resume.notice = `No contexts found for filter=${cfg.resumeSourceFilter}`;
        }
      }
    } catch (error) {
      if (!silent) {
        const details = errorDetails(error);
        ui.resume.error = details.message ?? "Failed loading contexts";
        ui.resume.notice = "";
      }
    } finally {
      ui.resume.loading = false;
      renderDashboard();
    }
  }

  function moveResumeSelection(delta) {
    const total = ui.resume.filteredContexts.length;
    if (!total) return;
    const next = ui.resume.selectedIndex + delta;
    if (next < 0) {
      ui.resume.selectedIndex = total - 1;
      return;
    }
    if (next >= total) {
      ui.resume.selectedIndex = 0;
      return;
    }
    ui.resume.selectedIndex = next;
  }

  function openResumeTargetPicker() {
    if (ui.resume.syncing) return false;
    const context = ui.resume.filteredContexts[ui.resume.selectedIndex];
    if (!context) {
      ui.resume.notice = "No context selected";
      renderDashboard();
      return false;
    }

    const sourceAgent = resumeContextSource(context);
    if (!isCodingContextSource(sourceAgent)) {
      ui.resume.notice = `Selected context source=${sourceAgent}. Adapt/Resume is available only for codex/claude contexts.`;
      renderDashboard();
      return false;
    }

    const recommendedTarget = recommendedResumeTargetForContext(context);
    ui.resumeTargetPicker.active = true;
    ui.resumeTargetPicker.selectedIndex = 0;
    ui.resumeTargetPicker.source = sourceAgent;
    ui.resumeTargetPicker.contextId = String(context.id ?? "");
    ui.resumeTargetPicker.options = resumeTargetOptionsForSource(sourceAgent);
    ui.resumeTargetPicker.recommendedTarget = recommendedTarget;
    renderDashboard();
    return true;
  }

  function closeResumeTargetPicker() {
    ui.resumeTargetPicker.active = false;
    ui.resumeTargetPicker.source = "";
    ui.resumeTargetPicker.contextId = "";
    ui.resumeTargetPicker.selectedIndex = 0;
    ui.resumeTargetPicker.options = RESUME_TARGET_OPTIONS;
    ui.resumeTargetPicker.recommendedTarget = "";
    renderDashboard();
  }

  function moveResumeTargetPickerSelection(delta) {
    const options = ui.resumeTargetPicker.options ?? RESUME_TARGET_OPTIONS;
    const total = options.length;
    if (total <= 0) return;
    const base = Number.isInteger(ui.resumeTargetPicker.selectedIndex) ? ui.resumeTargetPicker.selectedIndex : 0;
    ui.resumeTargetPicker.selectedIndex = (base + delta + total) % total;
    renderDashboard();
  }

  function resumeTargetPickerSelectionByIndex(index) {
    const options = ui.resumeTargetPicker.options ?? RESUME_TARGET_OPTIONS;
    const safeIndex = Math.max(Math.min(index, options.length - 1), 0);
    return options[safeIndex]?.id ?? "codex";
  }

  async function resumeSelectedContext({ targetAgentOverride = "" } = {}) {
    if (!runtime.uc || ui.resume.syncing) return;
    const context = ui.resume.filteredContexts[ui.resume.selectedIndex];
    if (!context) {
      ui.resume.notice = "No context selected";
      renderDashboard();
      return;
    }

    const selectedSourceAgent = resumeContextSource(context);
    if (!isCodingContextSource(selectedSourceAgent)) {
      ui.resume.notice = `Selected context source=${selectedSourceAgent}. Adapt/Resume is available only for codex/claude contexts.`;
      renderDashboard();
      return;
    }

    ui.resume.syncing = true;
    ui.resumeTargetPicker.active = false;
    ui.resume.error = "";
    ui.resume.notice = `Pulling ${context.id}...`;
    renderDashboard();

    try {
      const detail = await runtime.uc.get(context.id);
      const messages = Array.isArray(detail.data) ? detail.data : [];

      const outDir = path.resolve(cfg.resumeOutputDir);
      await fs.mkdir(outDir, { recursive: true });

      const summaryPath = path.join(outDir, `${context.id}.md`);
      const snapshotPath = path.join(outDir, `${context.id}.json`);
      const commandPath = path.join(outDir, `${context.id}.command.txt`);

      const summary = resumeSummaryMarkdown({ context, messages, tail: cfg.resumeSummaryTail });
      const snapshot = {
        exported_at: new Date().toISOString(),
        context_id: context.id,
        metadata: context.metadata ?? {},
        messages,
      };

      await fs.writeFile(summaryPath, summary, "utf8");
      await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

      const originalCwd = resumeExtractSessionCwd(messages);
      const runCwd = await resumeResolveWorkingDirectory(originalCwd);
      const sourceAgent = selectedSourceAgent;
      const manualTarget = targetAgentOverride === "claude" || targetAgentOverride === "codex" ? targetAgentOverride : "";

      let targetAgent = manualTarget || resumeTargetAgent(sourceAgent);
      if (targetAgent === sourceAgent) {
        targetAgent = resumeTargetAgent(sourceAgent);
      }

      const sessionId = String(context.metadata?.session_id ?? "");
      const resumePlan =
        targetAgent === "claude"
          ? await buildClaudeResumePlan({ sessionId, runCwd, messages })
          : await buildCodexResumePlan({ sessionId, runCwd, messages });

      const command = resumePlan.command;
      await fs.writeFile(commandPath, `${command}\n`, "utf8");

      ui.resume.summaryPath = summaryPath;
      ui.resume.command = command;
      ui.resume.commandPath = commandPath;

      const direction = `${resumeAgentLabel(sourceAgent)} -> ${resumeAgentLabel(targetAgent)}`;

      if (cfg.resumeOpenTab) {
        const opened = terminalLauncher.resumeOpenTerminalTab(command);
        const openMethod = opened.method ? ` method=${opened.method}` : "";
        if (opened.ok) {
          ui.resume.notice = resumePlan.canResumeBySessionId
            ? `Adapter ready (${direction}). Opened ${resumeAgentLabel(targetAgent)} via session_id ${resumePlan.sessionId}.${openMethod}`
            : `Adapter ready (${direction}). Opened ${resumeAgentLabel(targetAgent)} without session resume.${openMethod}`;
          if (resumePlan.restoredError) {
            ui.resume.notice = `${ui.resume.notice} Adapter warning: ${resumePlan.restoredError}`;
          }
        } else {
          ui.resume.notice = `Adapter ready (${direction}). Open tab failed: ${opened.reason}${openMethod}`;
        }
      } else {
        ui.resume.notice = resumePlan.canResumeBySessionId
          ? `Adapter ready (${direction}). Use generated ${resumeAgentLabel(targetAgent)} resume command.`
          : `Adapter ready (${direction}). Use generated command to start a clean ${resumeAgentLabel(targetAgent)} session.`;
        if (resumePlan.restoredPath) {
          ui.resume.notice = `${ui.resume.notice} Local adapter: ${resumePlan.restoredPath}`;
        } else if (resumePlan.restoredError) {
          ui.resume.notice = `${ui.resume.notice} Adapter warning: ${resumePlan.restoredError}`;
        }
      }
    } catch (error) {
      const details = errorDetails(error);
      ui.resume.error = details.message ?? "Resume failed";
      ui.resume.notice = "";
    } finally {
      ui.resume.syncing = false;
      ui.resumeTargetPicker.active = false;
      ui.resumeTargetPicker.source = "";
      ui.resumeTargetPicker.contextId = "";
      ui.resumeTargetPicker.selectedIndex = 0;
      ui.resumeTargetPicker.options = RESUME_TARGET_OPTIONS;
      ui.resumeTargetPicker.recommendedTarget = "";
      renderDashboard();
    }
  }

  return {
    applySourceFilter,
    cycleSourceFilter,
    enrichContextTitles,
    loadResumeContexts,
    moveResumeSelection,
    openResumeTargetPicker,
    closeResumeTargetPicker,
    moveResumeTargetPickerSelection,
    resumeTargetPickerSelectionByIndex,
    resumeSelectedContext,
    recommendedResumeTargetForContext,
  };
}
