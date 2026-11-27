import { closePanel } from "./dialogs.js?v=25";
import { clearChildren, formatTime } from "./utils.js?v=25";

export function createChapterPanel({ list, panel, trigger, audio, t, onRetry, onSeek, reportError }) {
  const document = list.ownerDocument;
  let track = document.getElementById("chaptersTrack");
  if (!track) {
    track = document.createElement("track");
    track.id = "chaptersTrack";
    track.kind = "chapters";
    track.default = true;
    audio.appendChild(track);
  }
  let trackObjectUrl = "";

  function clearChapterTrack() {
    if (trackObjectUrl) URL.revokeObjectURL(trackObjectUrl);
    trackObjectUrl = "";
    track.removeAttribute("src");
  }

  function setTrack({ kind, text }) {
    try {
      clearChapterTrack();
      if (kind === "vtt" && text) {
        trackObjectUrl = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
        track.src = trackObjectUrl;
        track.track.mode = "hidden";
      }
    } catch (error) {
      reportError("native chapter track", error);
    }
  }

  function renderPanelMessage(message) {
    clearChildren(list);
    const item = document.createElement("p");
    item.className = "empty-state";
    item.textContent = message;
    list.appendChild(item);
  }

  function renderChapterFailure() {
    clearChildren(list);
    const container = document.createElement("div");
    container.className = "chapter-load-error";
    const message = document.createElement("p");
    message.className = "empty-state";
    message.textContent = t("chaptersLoadFailed");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "text-button chapter-retry-button";
    retry.textContent = t("retryChapters");
    retry.addEventListener("click", async () => {
      const ownedFocus = document.activeElement === retry;
      retry.disabled = true;
      retry.textContent = t("loadingChapters");
      await onRetry();
      if (!ownedFocus || panel.hidden) return;
      const current = document.activeElement;
      if (current && current !== retry && current !== document.body) return;
      const focusTarget = list.querySelector(".chapter-retry-button, .chapter-button") || panel.querySelector("button:not(:disabled)");
      focusTarget?.focus();
    });
    container.append(message, retry);
    list.appendChild(container);
  }

  function renderChapters({ cues, activeIndex, mode }) {
    const focused = document.activeElement;
    const focusedIndex = focused?.parentElement === list ? Number(focused.dataset.index) : -1;
    clearChildren(list);
    if (!cues.length) { renderPanelMessage(t(mode === "embedded" ? "noChaptersForSource" : "noChaptersFound")); return; }
    cues.forEach((cue, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chapter-button";
      button.dataset.index = String(index);
      button.setAttribute("aria-current", String(index === activeIndex));
      const title = document.createElement("span");
      title.className = "chapter-name";
      title.textContent = cue.title;
      const time = document.createElement("span");
      time.className = "chapter-time";
      time.textContent = formatTime(cue.start);
      button.append(title, time);
      button.addEventListener("click", () => {
        onSeek(cue.start);
        closePanel(panel, trigger, true);
      });
      list.appendChild(button);
    });
    if (!panel.hidden && focusedIndex >= 0) list.children[Math.min(focusedIndex, cues.length - 1)].focus();
  }

  function setActive(index) {
    for (const button of list.querySelectorAll(".chapter-button")) {
      button.setAttribute("aria-current", String(Number(button.dataset.index) === index));
    }
  }

  function reset() {
    list.setAttribute("aria-busy", "false");
    clearChildren(list);
    clearChapterTrack();
  }

  return { reset, setTrack, setActive, renderChapters, renderChapterFailure, renderPanelMessage,
    setBusy: (busy) => list.setAttribute("aria-busy", String(busy)) };
}
