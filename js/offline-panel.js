import { manifestMatchesSelection, sameOfflineSelection } from "./offline-selection.js";
import { setText } from "./utils.js";

export function createOfflinePanel(window, { offline, t, getLocale, getSelection, isOnline,
  waitForPriority, onRepair, reportError, showToast }) {
  const ids = ["offlineRow", "offlineLabel", "offlineStatus", "offlineProgress", "offlineDownloadBtn",
    "offlineRepairBtn", "offlineCancelBtn", "offlineRemoveBtn"];
  const els = Object.fromEntries(ids.map((id) => [id, window.document.getElementById(id)]));
  let focusCancel = false;

  function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    const units = ["B", "KB", "MB", "GB"];
    let amount = bytes;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
    return `${new Intl.NumberFormat(getLocale(), { maximumFractionDigits: unit > 1 ? 1 : 0 }).format(amount)} ${units[unit]}`;
  }

  function manifestDescription(manifest) {
    return t("offlineSavedOther", {
      book: manifest.episodeTitle || manifest.episodeId,
      language: manifest.languageLabel || manifest.languageCode,
      quality: manifest.sourceLabel || manifest.sourceId,
      size: formatBytes(manifest.totalSize),
    });
  }

  function render(state = offline.snapshot()) {
    if (!els.offlineRow) return;
    els.offlineRow.hidden = !state.supported;
    if (!state.supported) return;
    setText(els.offlineLabel, t("offlineLabel"));
    const selection = getSelection();
    const activeMatches = selection && manifestMatchesSelection(state.active, selection);
    const { busy } = state;
    const repairMessage = state.repairable && t(state.repairable.status === "needs-audio" ? "offlineMissingAudio" : "offlineNeedsConfig",
      { book: state.repairable.episodeTitle });
    const percent = Math.round(state.progress * 100);
    let status = "";
    let action = t("offlineDownload");
    let showDownload = true;
    const showRemove = Boolean(state.active || state.repairable) && !busy;

    els.offlineProgress.hidden = true;
    if (state.phase === "preparing" || state.phase === "publishing-repair") {
      status = t("offlinePreparing");
      showDownload = false;
    } else if (["downloading", "finalizing"].includes(state.phase) && state.staging) {
      status = t("offlineDownloading", { percent, size: formatBytes(state.progress * state.staging.totalSize), total: formatBytes(state.staging.totalSize) });
      els.offlineProgress.hidden = false;
      showDownload = false;
    } else if (state.staging) {
      const partial = state.staging;
      const title = partial.episodeTitle || partial.episodeId;
      const needsConfig = state.stagingStatus === "needs-config";
      const details = needsConfig ? [t("offlineNeedsConfig", { book: title })]
        : [title, partial.languageLabel || partial.languageCode, partial.sourceLabel || partial.sourceId,
          formatBytes(partial.totalSize), t("offlinePaused", { percent })];
      if (state.active) details.unshift(manifestDescription(state.active));
      else if (repairMessage) details.unshift(repairMessage);
      status = details.join(" · ");
      action = needsConfig ? t("offlineRepair") : t("offlineResume");
      els.offlineProgress.hidden = false;
    } else if (activeMatches) {
      status = t("offlineReady", { size: formatBytes(state.active.totalSize) });
      showDownload = false;
    } else if (state.active) {
      status = manifestDescription(state.active);
      action = t("offlineReplace");
    } else if (state.repairable) {
      status = repairMessage;
      showDownload = Boolean(selection);
      action = sameOfflineSelection(state.repairable, selection) ? t("offlineDownload") : t("offlineReplace");
    }

    els.offlineProgress.value = percent;
    setText(els.offlineStatus, status);
    setText(els.offlineDownloadBtn, action);
    setText(els.offlineCancelBtn, t("offlineCancel"));
    setText(els.offlineRemoveBtn, t("offlineRemove"));
    setText(els.offlineRepairBtn, t("offlineRepair"));
    els.offlineRepairBtn.hidden = state.repairable?.status !== "needs-config" || busy;
    els.offlineRepairBtn.disabled = !isOnline();
    els.offlineDownloadBtn.hidden = !showDownload;
    els.offlineDownloadBtn.disabled = busy || (!selection && !state.staging) || (!isOnline() && !state.canFinishOffline);
    els.offlineCancelBtn.hidden = !state.canCancel;
    els.offlineRemoveBtn.hidden = !showRemove;
    if (focusCancel && busy && state.canCancel) {
      focusCancel = false;
      window.requestAnimationFrame(() => els.offlineCancelBtn.focus());
    }
  }

  function offlineErrorMessage(error) {
    if (error?.code === "offline") return t("offlineConnect");
    if (["unsupported", "cross-origin"].includes(error?.code)) return t("offlineUnsupported");
    if (error?.code === "timeout") return t("offlineTimedOut");
    if (error?.code === "range") return t("offlineRangeUnsupported");
    if (error?.code === "mime") return t("offlineMimeUnsupported");
    if (error?.code === "conflict") return t("offlineTabConflict");
    if (error?.code === "quota") return t("offlineStorageFull");
    if (["changed", "incomplete"].includes(error?.code)) return t("offlineFileChanged");
    return t("offlineDownloadFailed");
  }

  async function downloadOfflineSelection() {
    const { staging } = offline.snapshot();
    const selection = getSelection();
    if (!selection && !staging) return;
    focusCancel = true;
    let persisted;
    try {
      const options = {
        waitForPriority,
        onPersistence: (granted) => { persisted = granted; },
        confirmDownload(check, candidate) {
          if (check.canResume) return true;
          const { active, repairable } = offline.snapshot();
          const saved = active || repairable;
          if (saved && !sameOfflineSelection(saved, candidate)
            && !window.confirm(t("offlineReplaceConfirm", { book: saved.episodeTitle || saved.episodeId }))) return false;
          return window.confirm(t("offlineConfirm", { book: candidate.episodeTitle, language: candidate.languageLabel,
            quality: candidate.sourceLabel, size: formatBytes(check.totalSize) }));
        },
      };
      const ready = staging ? await offline.resume(options) : await offline.start(selection, undefined, options);
      if (!ready) return;
      showToast(t("offlineComplete"), "success", 6000, "offline-complete");
      if (persisted === false) showToast(t("offlinePersistenceWarning"), "warning", 7000, "offline-persistence");
    } catch (error) {
      if (error?.name === "AbortError") return;
      reportError("offline download", error, offlineErrorMessage(error));
    } finally { focusCancel = false; render(); }
  }

  els.offlineDownloadBtn.addEventListener("click", () => void downloadOfflineSelection());
  els.offlineRepairBtn.addEventListener("click", async () => {
    try {
      await offline.repairConfig();
      onRepair();
    } catch (error) {
      if (error?.name !== "AbortError") reportError("repair offline configuration", error, offlineErrorMessage(error));
    }
  });
  els.offlineCancelBtn.addEventListener("click", async () => {
    els.offlineCancelBtn.disabled = true;
    try { await offline.cancel(); }
    catch (error) { reportError("cancel offline download", error, offlineErrorMessage(error)); }
    finally { els.offlineCancelBtn.disabled = false; render(); }
  });
  els.offlineRemoveBtn.addEventListener("click", async () => {
    const { active, repairable } = offline.snapshot();
    const saved = active || repairable;
    if (!saved || !window.confirm(t("offlineRemoveConfirm", { book: saved.episodeTitle || saved.episodeId }))) return;
    els.offlineRemoveBtn.disabled = true;
    try {
      await offline.removeActive();
      showToast(t("offlineRemoved"), "success", 4000, "offline-removed");
    } catch (error) { reportError("remove offline download", error, offlineErrorMessage(error)); }
    finally { els.offlineRemoveBtn.disabled = false; render(); }
  });

  return render;
}
