// === ui/detail.mjs — the context detail (message inspector) controller ===
// Owns: ui.detailView — opening a context's message list (fetched through the
// live UltraContext client), closing/clearing it, refreshing, and the two
// scroll levels (message-level wraps, line-level clamps). Extracted verbatim
// from tui.mjs (ARCH-005); the boot closures became injected dependencies.

export function createDetailController({ ui, runtime, renderDashboard }) {

  async function openContextDetail() {
    if (ui.detailView.loading) return;
    const context = ui.resume.filteredContexts[ui.resume.selectedIndex];
    if (!context) return;

    ui.detailView.active = true;
    ui.detailView.contextId = context.id;
    ui.detailView.contextMeta = context.metadata ?? {};
    ui.detailView.messages = [];
    ui.detailView.scrollOffset = 0;
    ui.detailView.lineOffset = 0;
    ui.detailView.loading = true;
    ui.detailView.error = null;
    renderDashboard();

    try {
      const detail = await runtime.uc.get(context.id);
      const messages = Array.isArray(detail.data) ? detail.data : [];
      ui.detailView.messages = messages;
    } catch (error) {
      ui.detailView.error = error?.message ?? "Failed to load context";
    } finally {
      ui.detailView.loading = false;
      renderDashboard();
    }
  }

  function closeContextDetail() {
    ui.detailView.active = false;
    ui.detailView.contextId = null;
    ui.detailView.contextMeta = null;
    ui.detailView.messages = [];
    ui.detailView.scrollOffset = 0;
    ui.detailView.lineOffset = 0;
    ui.detailView.loading = false;
    ui.detailView.error = null;
    renderDashboard();
  }

  async function refreshContextDetail() {
    if (!ui.detailView.active || !ui.detailView.contextId || ui.detailView.loading) return;
    ui.detailView.loading = true;
    ui.detailView.error = null;
    renderDashboard();

    try {
      const detail = await runtime.uc.get(ui.detailView.contextId);
      ui.detailView.messages = Array.isArray(detail.data) ? detail.data : [];
    } catch (error) {
      ui.detailView.error = error?.message ?? "Failed to refresh";
    } finally {
      ui.detailView.loading = false;
      renderDashboard();
    }
  }

  // message-level scroll — resets line offset
  function scrollContextDetail(delta) {
    const total = ui.detailView.messages.length;
    if (total === 0) return;
    const next = ui.detailView.scrollOffset + delta;
    if (next < 0) ui.detailView.scrollOffset = total - 1;
    else if (next >= total) ui.detailView.scrollOffset = 0;
    else ui.detailView.scrollOffset = next;
    ui.detailView.lineOffset = 0;
    renderDashboard();
  }

  // line-level fine scroll (j/k) within current view
  function scrollContextDetailLine(delta) {
    if (ui.detailView.messages.length === 0) return;
    ui.detailView.lineOffset = Math.max(0, ui.detailView.lineOffset + delta);
    renderDashboard();
  }

  return {
    openContextDetail,
    closeContextDetail,
    refreshContextDetail,
    scrollContextDetail,
    scrollContextDetailLine,
  };
}
