import { UI_STRINGS } from "../i18n.js?v=16";
import { BookConfigStore, fetchLibraryCatalog, queryBookId } from "./book-config.js";
import { BookSelection } from "./book-selection.js";
import { AvailabilitySession } from "./availability-session.js";
import { createCustomSelects } from "./custom-select.js";
import { isMp4Audio, qualityLabelKey } from "./codecs.js";
import { ChapterSession } from "./chapter-session.js";
import { localizedValue, normalizeLibrary, resolveCover } from "./config.js";
import { bindDialogDismiss, closeDialog, closePanel, openDialog, openPanel } from "./dialogs.js";
import { createMediaSession } from "./media-session.js";
import { MediaController } from "./media-controller.js";
import { createCoverView } from "./cover.js";
import { OfflineManager, manifestMatchesSelection, sameOfflineSelection } from "./offline.js";
import { visibleSources } from "./source-selection.js";
import { SKIP_INTERVALS, skipInterval } from "./preferences.js";
import { ProgressWriter } from "./progress-writer.js";
import { SleepTimer } from "./sleep-timer.js";
import { clearChildren, clamp, formatTime, normalizeLanguageTag, safeUrl, setText, UNKNOWN_TIME } from "./utils.js";

export function startPlayer({ window, storage, fetchImpl }) {
  const { document, location, navigator } = window;
  const isOnline = () => navigator.onLine !== false;
  const els = Object.fromEntries([
    "player", "bookTitle", "bookMeta", "playPauseBtn", "playPauseIcon", "seek", "seekLabel", "timeCur", "timeDur",
    "coverButton", "coverImg", "chaptersBtn", "prevChapterBtn", "skipBackBtn", "skipForwardBtn", "nextChapterBtn",
    "sleepBtn", "optionsBtn", "chaptersPanel", "chaptersTitle", "closeChaptersBtn", "chaptersList", "sleepPanel",
    "sleepTitle", "closeSleepBtn", "sleepList", "optionsPanel", "audioSettingsLegend", "appearanceLegend", "bookRow",
    "bookSelect", "langSelect", "qualitySelect", "offlineRow", "offlineLabel", "offlineStatus", "offlineProgress",
    "offlineDownloadBtn", "offlineRepairBtn", "offlineCancelBtn", "offlineRemoveBtn", "volumeRow", "volumeRange", "volumeValue", "speedRange", "speedValue",
    "skipSelect", "themeSelect", "fontSizeSelect", "uiLangSelect", "resetBtn", "audio", "chaptersTrack", "toastHost",
    "statusAnnouncer", "coverDialog", "coverDialogTitle", "closeCoverBtn", "coverDialogImg", "onboardingDialog",
    "onboardingTitle", "onboardingBody", "onboardingCloseX", "onboardingOk", "resetDialog", "resetTitle", "resetBody",
    "resetCloseX", "resetCancel", "resetOk",
  ].map((id) => [id, document.getElementById(id)]));

  if (!els.chaptersTrack) {
    els.chaptersTrack = document.createElement("track");
    els.chaptersTrack.id = "chaptersTrack";
    els.chaptersTrack.kind = "chapters";
    els.chaptersTrack.default = true;
    els.audio.appendChild(els.chaptersTrack);
  }

  const documentBaseUrl = new URL(".", location.href).href;
  const libraryUrl = new URL("media/library.json", documentBaseUrl).href;
  const uiLanguageNames = { en: "English", da: "Dansk", nb: "Norsk (bokmål)", sv: "Svenska" };
  const sleepDurations = [5, 10, 15, 30, 45, 60, 90, 120];
  const STALL_NOTICE_DELAY_MS = 2000;

  let uiPrefs = storage.readUi();
  let locale = resolveUiLocale(uiPrefs.uiLanguage);
  let library = normalizeLibrary(null);
  let bookConfigs = null;
  let libraryNeedsRetry = false;
  let libraryRetry = null;
  let startupBookRequest = null;
  let book = null;
  let bookConfigUrl = "";
  let bookSelection = null;
  let requestedBookId = "";
  const availability = new AvailabilitySession({
    window, fetchImpl, isOnline,
    openCache: storage.availabilityCache.bind(storage),
    onChange: populateQualitySelect,
    onError: (error) => reportError("availability scan", error),
  });
  const chapters = new ChapterSession({
    fetchImpl,
    openCache: storage.chapterCache.bind(storage),
    onStart() {
      availability.waitForChapters();
      els.chaptersList.setAttribute("aria-busy", "true");
    },
    onLoaded(result) {
      applyChapterData(result);
      availability.chaptersSettled();
    },
    onFailure(error, notify) {
      availability.chaptersSettled();
      els.chaptersList.setAttribute("aria-busy", "false");
      reportError("chapter load", error);
      if (notify) showToast(t("chaptersLoadFailed"), "warning", 5000);
      renderChapterFailure();
      updateChapterButtons();
      markActiveChapter(media.position());
    },
  });
  let bookController = null;
  let bookGeneration = 0;
  let durationUnlocked = false;
  let seekDragging = false;
  let uiBusy = false;
  const progress = new ProgressWriter(storage);
  let resetRemaining = null;
  let mediaMetadataTitle = "";
  let trackObjectUrl = "";
  let stallNoticeTimer = null;
  let onboardingUiSelect = null;
  let onboardingAudioSelect = null;
  const toastTimes = new Map();
  const errorTimes = new Map();
  const mediaSession = createMediaSession(navigator, window.MediaMetadata, reportError);
  let focusOfflineCancel = false;
  const offline = new OfflineManager({
    navigatorObject: navigator, fetchImpl, getCacheStorage: () => window.caches,
    baseUrl: documentBaseUrl,
    onChange: (snapshot) => {
      renderOfflineUi(snapshot);
      if (focusOfflineCancel && snapshot.busy && snapshot.canCancel) {
        focusOfflineCancel = false;
        window.requestAnimationFrame(() => els.offlineCancelBtn.focus());
      }
    },
  });

  function resolveUiLocale(preference) {
    if (preference !== "auto") {
      const normalized = normalizeLanguageTag(preference);
      return UI_STRINGS[normalized] ? normalized : "en";
    }
    const candidates = [...(navigator.languages || []), navigator.language || ""];
    return candidates.map(normalizeLanguageTag).find((value) => UI_STRINGS[value]) || "en";
  }

  function translateAt(language, key, variables = {}) {
    let value = UI_STRINGS[language]?.[key] ?? UI_STRINGS.en[key] ?? key;
    for (const [name, replacement] of Object.entries(variables)) value = value.replaceAll(`{${name}}`, String(replacement));
    return value;
  }

  function t(key, variables = {}) { return translateAt(locale, key, variables); }

  function reportError(context, error, userMessage = "") {
    const now = Date.now();
    if (!userMessage && now - (errorTimes.get(context) || 0) < 30000) return;
    errorTimes.set(context, now);
    console.error(`[CompactAudioPlayer] ${context}`, error);
    if (userMessage) showToast(userMessage, "error", 7000, `${context}:${userMessage}`);
  }

  function announce(message) {
    setText(els.statusAnnouncer, "");
    window.requestAnimationFrame(() => setText(els.statusAnnouncer, message));
  }

  function showToast(message, type = "info", duration = 4000, key = message) {
    const now = Date.now();
    if (now - (toastTimes.get(key) || 0) < 3000) return;
    toastTimes.set(key, now);
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = String(message);
    els.toastHost.appendChild(toast);
    announce(message);
    setTimeout(() => toast.remove(), duration);
  }

  function setTooltip(element, message) {
    if (!element) return;
    const text = String(message || "").trim();
    if (text) element.dataset.tooltip = text;
    else element.removeAttribute("data-tooltip");
  }

  function setLoading(loading) {
    const showSkeleton = loading && els.bookRow.hidden;
    document.body.classList.toggle("is-loading", showSkeleton);
    els.player.classList.toggle("is-loading", showSkeleton);
    els.player.setAttribute("aria-busy", String(showSkeleton));
    els.playPauseBtn.disabled = loading || !book;
  }

  function setBusy(busy) {
    uiBusy = busy;
    els.player.classList.toggle("is-busy", busy);
    updateSelectionControlState();
  }

  function updateSelectionControlState() {
    const offlineLocked = !isOnline();
    els.bookSelect.disabled = offlineLocked || Boolean(resetRemaining);
    els.langSelect.disabled = uiBusy || offlineLocked || !book;
    els.qualitySelect.disabled = uiBusy || offlineLocked || (book ? qualityOptionsForCurrentLanguage().length <= 1 : true);
    syncSelectionControls();
  }

  function setMeta(message, error = false) {
    setText(els.bookMeta, message);
    els.bookMeta.classList.toggle("is-error", error);
  }

  function displayTitle() {
    return localizedValue(book?.title, bookSelection?.languageCode, book?.id || t("audio"));
  }

  function sourceLabel(source, includeDetails = true) {
    if (!source) return "";
    const quality = t(qualityLabelKey(source.codec, source.bitrate));
    return includeDetails ? `${quality} · ${source.bitrate} kb/s · ${source.codec.toUpperCase()}` : quality;
  }

  function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    const units = ["B", "KB", "MB", "GB"];
    let amount = bytes;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit > 1 ? 1 : 0 }).format(amount)} ${units[unit]}`;
  }

  function currentOfflineSelection() {
    if (!book || !bookConfigUrl) return null;
    const language = book.languages[bookSelection.languageCode];
    const source = bookSelection?.source;
    if (!language || !source?.url) return null;
    return {
      episodeId: bookSelection.bookId,
      configBookId: book.id,
      episodeTitle: displayTitle(),
      languageCode: bookSelection.languageCode,
      languageLabel: language.label || bookSelection.languageCode,
      sourceId: source.id,
      sourceLabel: sourceLabel(source, true),
      sourceUrl: source.url,
      mime: source.mime,
      cacheVersion: book.cacheVersion,
      assets: [
        { url: libraryUrl, required: false },
        { url: bookConfigUrl, required: true },
        { url: ["file", "auto"].includes(book.coverSource) ? resolveCover(book) : "", required: false },
        { url: chapters.url, required: false },
      ].filter((asset) => {
        try { return asset.url && new URL(asset.url).origin === new URL(documentBaseUrl).origin; }
        catch { return false; }
      }),
    };
  }

  function manifestDescription(manifest) {
    return t("offlineSavedOther", {
      book: manifest.episodeTitle || manifest.episodeId,
      language: manifest.languageLabel || manifest.languageCode,
      quality: manifest.sourceLabel || manifest.sourceId,
      size: formatBytes(manifest.totalSize),
    });
  }

  function renderOfflineUi(state = offline.snapshot()) {
    if (!els.offlineRow) return;
    updateSelectionControlState();
    els.offlineRow.hidden = !state.supported;
    if (!state.supported) return;
    setText(els.offlineLabel, t("offlineLabel"));
    const selection = currentOfflineSelection();
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

  async function waitForPlaybackPriority(signal) {
    while (["loading", "stalled"].includes(media.state)) {
      if (signal.aborted) throw new DOMException("Download canceled", "AbortError");
      await new Promise((resolve, reject) => {
        const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
        const timer = setTimeout(finish, 500);
        const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new DOMException("Download canceled", "AbortError")); };
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }

  async function downloadOfflineSelection() {
    const { staging } = offline.snapshot();
    const selection = currentOfflineSelection();
    if (!selection && !staging) return;
    focusOfflineCancel = true;
    let persisted;
    try {
      const options = {
        waitForPriority: waitForPlaybackPriority,
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
    } finally { focusOfflineCancel = false; renderOfflineUi(); }
  }

  function updateMeta() {
    const language = book?.languages?.[bookSelection.languageCode];
    const source = bookSelection?.source;
    const chapterTitle = chapters.activeTitle;
    setMeta([language?.label || bookSelection?.languageCode, sourceLabel(source, false), chapterTitle].filter(Boolean).join(" • "));
  }

  const { optionsFrom, selectWithArrow, selectFocusTarget, setSelectValue, updateOptionLabel, closeAllCustomSelects,
    syncCustomSelect, destroyCustomSelect, enhanceCustomSelect, syncSelectionControls, closeSelectOutside } = createCustomSelects(document, window);

  function initializeCustomSelects() {
    optionsFrom(els.skipSelect, SKIP_INTERVALS.map((seconds) => ({ value: String(seconds) })),
      String(uiPrefs.skipSeconds), (record) => record.value + " s");
    for (const select of [els.bookSelect, els.langSelect, els.qualitySelect, els.skipSelect, els.themeSelect, els.fontSizeSelect, els.uiLangSelect]) enhanceCustomSelect(select);
  }

  initializeCustomSelects();

  function libraryLabel(record) { return localizedValue(record.title, locale, record.label || record.id); }

  function populateLibrarySelect() {
    const records = library.books.map((item) => ({ ...item, value: item.id }));
    if (requestedBookId && !library.byId.has(requestedBookId)) {
      const label = requestedBookId === bookSelection?.bookId ? displayTitle() : requestedBookId;
      records.unshift({ value: requestedBookId, label });
    }
    optionsFrom(els.bookSelect, records, requestedBookId, libraryLabel);
    els.bookRow.hidden = records.length <= 1;
  }

  function populateLanguageSelect() {
    optionsFrom(els.langSelect, Object.values(book.languages).map((language) => ({ value: language.code, label: language.label })), bookSelection.languageCode, (item) => item.label);
  }

  function qualityOptionsForCurrentLanguage() {
    const visible = visibleSources(bookSelection.sources, book.debug.showAllQualities);
    const forced = bookSelection.source;
    if (forced && !visible.some((source) => source.id === forced.id)) visible.unshift(forced);
    return visible;
  }

  function populateQualitySelect() {
    const visible = qualityOptionsForCurrentLanguage();
    optionsFrom(els.qualitySelect, visible.map((source) => ({ ...source, value: source.id })), bookSelection.source.id, (source) => book.debug.showAllQualities ? sourceLabel(source, true) : sourceLabel(source, false));
    els.qualitySelect.disabled = uiBusy || !isOnline() || visible.length <= 1;
    syncCustomSelect(els.qualitySelect);
  }

  function updateTitle() {
    const title = displayTitle();
    setText(els.bookTitle, title);
    document.title = title || "Compact Audio Player";
    mediaMetadataTitle = title;
    updateMediaSessionMetadata();
  }

  const { applyCover, clearCover } = createCoverView(els.coverImg, els.coverButton, {
    fetchImpl,
    onShown() {
      els.coverImg.alt = displayTitle();
      els.coverButton.setAttribute("aria-label", t("openCover"));
      setTooltip(els.coverButton, t("openCover"));
      updateMediaSessionMetadata();
    },
    onFailure(error) {
      if (error) reportError("embedded cover", error);
      showToast(t("coverLoadFailed"), "warning", 5000, "cover-load");
    },
  });

  function embeddedCoverAudioSource(source) {
    if (isMp4Audio(source)) return source;
    if (!isOnline()) return null;
    return bookSelection.sources.find(isMp4Audio) || null;
  }

  async function loadLibrary() {
    try {
      return await fetchLibraryCatalog(libraryUrl, fetchImpl);
    } catch (error) {
      if (error?.name !== "AbortError") reportError("library load", error);
      return null;
    }
  }

  async function recoverLibrary() {
    if (!bookConfigs || !isOnline()) return;
    if (libraryRetry) return libraryRetry;
    const generation = bookGeneration;
    libraryRetry = (async () => {
      if (libraryNeedsRetry) {
        const catalog = await loadLibrary();
        if (!catalog) return;
        libraryNeedsRetry = catalog.fromDownload;
        library = catalog.library;
        bookConfigs.setLibrary(library, { fromDownload: catalog.fromDownload });
        populateLibrarySelect();
        if (!book && bookController) setLoading(true);
      } else if (bookConfigs.downloadedConfig) bookConfigs.setLibrary(library);
      if (!els.optionsPanel.hidden) void loadLibraryTitles();
      await startupBookRequest;
      if (!book && !bookController && generation === bookGeneration) await loadStartupBook();
    })().finally(() => { libraryRetry = null; });
    return libraryRetry;
  }

  function loadLibraryTitles() {
    if (library.books.length <= 1 || !isOnline()) return;
    return bookConfigs.loadTitles((id, error) => reportError(`library title (${id})`, error),
      (record) => updateOptionLabel(els.bookSelect, record.id, libraryLabel(record)));
  }

  async function loadBook(id) {
    if (resetRemaining) return;
    bookController?.abort();
    bookController = new AbortController();
    const generation = ++bookGeneration;
    requestedBookId = id;
    populateLibrarySelect();
    const firstBook = !book;
    if (firstBook) {
      setLoading(true);
      setText(els.bookTitle, t("audio"));
      setMeta(t("loading"));
    }
    setBusy(true);

    try {
      const loaded = await bookConfigs.load(id, { signal: bookController.signal });
      const loadedBook = loaded.book;
      if (generation !== bookGeneration) return;

      if (new URL(location.href).searchParams.get("clearAvailCache") === "1") storage.clearAvailability(loadedBook.id, loadedBook.cacheVersion);
      const prepared = availability.prepareBook(loadedBook, els.audio);
      const next = new BookSelection({
        bookId: id, book: loadedBook, sources: prepared.sources,
        preferences: storage.readBookSelection(id), downloaded: isOnline() ? null : offline.snapshot().active,
        browserLanguages: navigator.languages || [navigator.language], saveSelection: storage.setBookSelection.bind(storage),
      });
      progress.flush();
      const position = storage.getProgress(id, next.languageCode);
      sleep.cancel(true);
      book = loadedBook;
      bookConfigUrl = loaded.configUrl;
      bookSelection = next;
      availability.setBook(prepared);
      durationUnlocked = false;
      resetChapters(book, next.languageCode, next.source);
      media.setSelection(next.sources, next.source.id, position, false);
      media.setPlaybackRate(uiPrefs.playbackRate);
      media.setVolume(uiPrefs.volume);
      populateLibrarySelect();
      populateLanguageSelect();
      populateQualitySelect();
      updateTitle();
      updateMeta();
      updateChapterButtons();
      storage.setLastBook(id);
      setBookUrl(id);
      renderOfflineUi();
      if (firstBook && library.ui.onboardingEnabled && !storage.hasSeenOnboarding()) openOnboarding();
    } catch (error) {
      if (generation !== bookGeneration) return;
      requestedBookId = bookSelection?.bookId || id;
      populateLibrarySelect();
      if (!book) setMeta(t("errorLoading"), true);
      throw error;
    } finally {
      if (generation === bookGeneration) { bookController = null; setLoading(false); setBusy(false); renderOfflineUi(); }
    }
  }

  function setBookUrl(id) {
    try { const url = new URL(location.href); url.searchParams.set("book", id); url.searchParams.delete("episode"); window.history?.replaceState(null, "", url); } catch {}
  }

  function clearChapterTrack() {
    if (trackObjectUrl) URL.revokeObjectURL(trackObjectUrl);
    trackObjectUrl = "";
    els.chaptersTrack.removeAttribute("src");
  }

  function resetChapters(book, code, source) {
    availability.selectLanguage(code || "");
    chapters.reset(book, code, source);
    els.chaptersList.setAttribute("aria-busy", "false");
    clearChildren(els.chaptersList);
    clearChapterTrack();
    updateMediaSessionMetadata();
    updateChapterButtons();
  }

  function applyChapterData({ text, kind }) {
    els.chaptersList.setAttribute("aria-busy", "false");
    try {
      clearChapterTrack();
      if (kind === "vtt" && text) {
        trackObjectUrl = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
        els.chaptersTrack.src = trackObjectUrl;
        els.chaptersTrack.track.mode = "hidden";
      }
    } catch (error) {
      reportError("native chapter track", error);
    }
    renderChapters();
    updateChapterButtons();
    markActiveChapter(media.position());
  }

  function ensureChapters({ force = false, notifyFailure = true, showLoading = !els.chaptersPanel.hidden } = {}) {
    const request = chapters.load({ force, notifyFailure });
    if (showLoading && chapters.pending) renderPanelMessage(t("loadingChapters"));
    if (showLoading && chapters.status === "failed") renderChapterFailure();
    return request;
  }

  function renderPanelMessage(message) {
    clearChildren(els.chaptersList);
    const item = document.createElement("p");
    item.className = "empty-state";
    item.textContent = message;
    els.chaptersList.appendChild(item);
  }

  function renderChapterFailure() {
    clearChildren(els.chaptersList);
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
      retry.disabled = true;
      retry.textContent = t("loadingChapters");
      await ensureChapters({ force: true, notifyFailure: true, showLoading: false });
      if (els.chaptersPanel.hidden) return;
      const focusTarget = chapters.status === "failed" ? els.chaptersList.querySelector(".chapter-retry-button") : els.chaptersList.querySelector(".chapter-button");
      focusTarget?.focus();
    });
    container.append(message, retry);
    els.chaptersList.appendChild(container);
  }

  function renderChapters() {
    clearChildren(els.chaptersList);
    if (!chapters.cues.length) { renderPanelMessage(t(chapters.mode === "embedded" ? "noChaptersForSource" : "noChaptersFound")); return; }
    chapters.cues.forEach((cue, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chapter-button";
      button.dataset.index = String(index);
      button.setAttribute("aria-current", String(index === chapters.activeIndex));
      const title = document.createElement("span");
      title.className = "chapter-name";
      title.textContent = cue.title;
      const time = document.createElement("span");
      time.className = "chapter-time";
      time.textContent = formatTime(cue.start);
      button.append(title, time);
      button.addEventListener("click", () => {
        media.seek(cue.start);
        closePanel(els.chaptersPanel, els.chaptersBtn, true);
      });
      els.chaptersList.appendChild(button);
    });
  }

  function chapterDuration() {
    return media.duration() || book?.duration;
  }

  function markActiveChapter(position) {
    if (!chapters.updatePosition(position, chapterDuration())) return;
    updateMeta();
    updateMediaSessionMetadata();
    for (const button of els.chaptersList.querySelectorAll(".chapter-button")) button.setAttribute("aria-current", String(Number(button.dataset.index) === chapters.activeIndex));
  }

  function updateChapterButtons() {
    const disabled = chapters.unavailable || chapters.status === "failed" || (chapters.status === "loaded" && !chapters.cues.length);
    els.prevChapterBtn.disabled = disabled;
    els.nextChapterBtn.disabled = disabled;
  }

  function refreshSourceMetadata(source) {
    const changed = chapters.needsSource(source);
    if (changed) {
      resetChapters(book, bookSelection.languageCode, source);
      updateMeta();
    }
    if (chapters.status === "idle") {
      const request = ensureChapters({ notifyFailure: false, showLoading: false });
      if (changed) void sleep.refreshChapter(request, currentChapterEnd);
    }
    applyCover(book, bookSelection.languageCode, embeddedCoverAudioSource(source));
  }

  async function seekChapter(direction) {
    const request = ensureChapters();
    const generation = chapters.generation;
    await request;
    if (generation !== chapters.generation) return;
    const target = chapters.seekTarget(direction, media.position(), chapterDuration());
    if (target != null) media.seek(target);
  }

  function updateTime(position, mediaDuration) {
    const knownDuration = mediaDuration || book?.duration || 0;
    const duration = durationUnlocked ? knownDuration : 0;
    if (!seekDragging) els.seek.value = duration ? String(Math.round(clamp(position / duration, 0, 1) * 1000)) : "0";
    els.seek.disabled = !duration;
    els.seek.setAttribute("aria-valuetext", duration ? `${formatTime(position)} of ${formatTime(duration)}` : formatTime(position));
    setText(els.timeCur, formatTime(position));
    setText(els.timeDur, duration ? formatTime(duration) : UNKNOWN_TIME);
    markActiveChapter(position);
    mediaSession.setPosition(position, knownDuration, media.playbackRate);
    sleep.onTime(position);
  }

  function updatePlaybackUi(state) {
    const playing = state === "playing" || (state === "stalled" && media.hasStarted);
    const label = media.playbackIntent ? t("pause") : t("play");
    setText(els.playPauseIcon, media.playbackIntent ? "Ⅱ" : "▶");
    els.playPauseBtn.setAttribute("aria-label", label);
    setTooltip(els.playPauseBtn, label);
    els.playPauseBtn.setAttribute("aria-busy", String(state === "loading" || state === "stalled"));
    mediaSession.setPlaybackState(playing ? "playing" : state === "idle" ? "none" : "paused");
    if (stallNoticeTimer) clearTimeout(stallNoticeTimer);
    stallNoticeTimer = null;
    if (state === "stalled" && isOnline()) {
      stallNoticeTimer = setTimeout(() => {
        stallNoticeTimer = null;
        if (media.state === "stalled" && media.playbackIntent && isOnline()) {
          showToast(t("audioStalled"), "warning", 5000, "audio-stalled");
        }
      }, STALL_NOTICE_DELAY_MS);
    }
  }

  const media = new MediaController(els.audio, {
    onState: updatePlaybackUi,
    onTime: updateTime,
    onProgress: (position, seek) => {
      if (bookSelection) progress.record(bookSelection.bookId, bookSelection.languageCode, position, seek);
    },
    onSourceChange: (source) => {
      if (resetRemaining) return;
      bookSelection.source = source;
      populateQualitySelect();
      updateMeta();
      renderOfflineUi();
      refreshSourceMetadata(source);
    },
    onSourceSuccess: (source) => {
      if (resetRemaining || !source) return;
      availability.markPlayed(source);
      bookSelection.confirmPlayed(source);
    },
    onSourceFailure: (source, error) => reportError(`source failure (${source?.id || "unknown"})`, error),
    onFallback: (_failed, next) => {
      if (resetRemaining) return;
      showToast(t("audioFallbackCompatible"), "warning", 5000, `fallback:${next.id}`);
    },
    onBlocked: () => showToast(t("playBlocked"), "warning", 7000, "play-blocked"),
    onOffline: () => {
      const selection = currentOfflineSelection();
      if (!selection || !manifestMatchesSelection(offline.snapshot().active, selection)) showToast(t("offlineWaiting"), "warning", 7000, "offline-waiting");
    },
    onExhausted: (error) => {
      setMeta(t("sourceExhausted"), true);
      reportError("all audio sources failed", error, t("sourceExhausted"));
    },
    onEnded: () => sleep.onEnded(),
  }, { isOnline });

  const sleep = new SleepTimer({
    media,
    getVolume: () => uiPrefs.volume,
    canFade: supportsProgrammaticVolume,
    onChange: renderSleepOptions,
    onTick: updateSleepButton,
    onNotice: (key, type, variables) => showToast(t(key, variables), type),
  });

  function setAppearance() {
    if (uiPrefs.theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = uiPrefs.theme;
    if (uiPrefs.fontSize === "m") document.documentElement.removeAttribute("data-font");
    else document.documentElement.dataset.font = uiPrefs.fontSize;
    setSelectValue(els.themeSelect, uiPrefs.theme);
    setSelectValue(els.fontSizeSelect, uiPrefs.fontSize);
  }

  // WebKit exposes audio.volume on iOS but ignores programmatic changes.
  function supportsProgrammaticVolume() {
    const ua = navigator.userAgent || "";
    const iosDevice = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    return !iosDevice;
  }

  function applyUiPreferences() {
    setAppearance();
    media.setPlaybackRate(uiPrefs.playbackRate);
    media.setVolume(uiPrefs.volume);
    els.speedRange.value = String(uiPrefs.playbackRate);
    setText(els.speedValue, `${Number(uiPrefs.playbackRate.toFixed(2))}×`);
    els.speedRange.setAttribute("aria-valuetext", els.speedValue.textContent);
    els.volumeRange.value = String(Math.round(uiPrefs.volume * 100));
    setText(els.volumeValue, `${Math.round(uiPrefs.volume * 100)}%`);
    els.volumeRange.setAttribute("aria-valuetext", els.volumeValue.textContent);
    els.volumeRow.hidden = !supportsProgrammaticVolume();
    applySkipInterval(uiPrefs.skipSeconds);
  }

  function applySkipInterval(seconds) {
    const value = skipInterval(seconds);
    uiPrefs.skipSeconds = value;
    setSelectValue(els.skipSelect, String(value));
    setText(els.skipBackBtn.querySelector("[aria-hidden]"), `−${value}`);
    setText(els.skipForwardBtn.querySelector("[aria-hidden]"), `+${value}`);
    const backLabel = t("skipBackAria", { s: value });
    const forwardLabel = t("skipForwardAria", { s: value });
    els.skipBackBtn.setAttribute("aria-label", backLabel);
    els.skipForwardBtn.setAttribute("aria-label", forwardLabel);
    setTooltip(els.skipBackBtn, backLabel);
    setTooltip(els.skipForwardBtn, forwardLabel);
  }

  function setControlLabel(button, key) {
    const label = t(key);
    button.setAttribute("aria-label", label);
    setText(button.querySelector(".sr-only"), label);
    setTooltip(button, label);
  }

  function applyStrings() {
    document.documentElement.lang = locale;
    setControlLabel(els.chaptersBtn, "chapters");
    setControlLabel(els.sleepBtn, "sleepTimer");
    setControlLabel(els.optionsBtn, "options");
    const controlLabels = new Map([
      [els.prevChapterBtn, t("prevChapter")],
      [els.nextChapterBtn, t("nextChapter")],
      [els.closeChaptersBtn, t("closeChapters")],
      [els.closeSleepBtn, t("close")],
      [els.closeCoverBtn, t("close")],
    ]);
    for (const [button, label] of controlLabels) {
      button.setAttribute("aria-label", label);
      setTooltip(button, label);
    }
    els.seekLabel.textContent = t("seek");
    els.seek.setAttribute("aria-label", t("seek"));
    setText(els.chaptersTitle, t("chapters"));
    setText(els.sleepTitle, t("sleepTimer"));
    setText(els.audioSettingsLegend, t("audioSettings"));
    setText(els.appearanceLegend, t("appearanceGroup"));
    const labelKeys = { bookSelect: "bookLabel", langSelect: "languageLabel", qualitySelect: "qualityLabel", volumeRange: "volumeLabel", speedRange: "playbackSpeedLabel", skipSelect: "skipIntervalLabel", themeSelect: "appearanceModeLabel", fontSizeSelect: "fontSizeLabel", uiLangSelect: "uiLanguageLabel" };
    for (const [id, key] of Object.entries(labelKeys)) document.querySelector(`label[for="${id}"]`).textContent = t(key);
    const themeLabels = { system: "themeSystem", light: "themeLight", dark: "themeDark" };
    for (const [value, key] of Object.entries(themeLabels)) els.themeSelect.querySelector(`[value="${value}"]`).textContent = t(key);
    const fontLabels = { s: "fontSizeSmall", m: "fontSizeMedium", l: "fontSizeLarge" };
    for (const [value, key] of Object.entries(fontLabels)) els.fontSizeSelect.querySelector(`[value="${value}"]`).textContent = t(key);
    setText(els.resetBtn, t("resetLink"));
    setTooltip(els.resetBtn, t("resetLink"));
    setText(els.resetTitle, t("resetTitle"));
    els.resetCloseX.setAttribute("aria-label", t("close"));
    setTooltip(els.resetCloseX, t("close"));
    setText(els.resetCancel, t("resetCancel"));
    setTooltip(els.resetCancel, t("resetCancel"));
    setText(els.onboardingTitle, t("onboardTitle"));
    els.onboardingCloseX.setAttribute("aria-label", t("close"));
    setTooltip(els.onboardingCloseX, t("close"));
    setText(els.onboardingOk, t("onboardOk"));
    setTooltip(els.onboardingOk, t("onboardOk"));
    setText(els.coverDialogTitle, t("coverDialogTitle"));
    populateUiLanguageSelect();
    applySkipInterval(uiPrefs.skipSeconds);
    renderSleepOptions();
    renderResetBody();
    populateLibrarySelect();
    if (book) {
      populateQualitySelect();
      updateMeta();
      if (chapters.status === "failed") renderChapterFailure();
      else if (chapters.pending && !els.chaptersPanel.hidden) renderPanelMessage(t("loadingChapters"));
      else if (chapters.status === "loaded") renderChapters();
    }
    updatePlaybackUi(media.state);
    renderOfflineUi();
  }

  function populateUiLanguageSelect() {
    const records = [{ value: "auto", label: t("uiLanguageAuto") }, ...Object.keys(UI_STRINGS).map((code) => ({ value: code, label: uiLanguageNames[code] || code.toUpperCase() }))];
    optionsFrom(els.uiLangSelect, records, uiPrefs.uiLanguage, (item) => item.label);
  }

  function renderResetBody() {
    clearChildren(els.resetBody);
    const paragraphs = resetRemaining
      ? [resetRemaining.local && t("resetLocalFailed"), resetRemaining.offline && t(resetRemaining.offline === "conflict" ? "offlineTabConflict" : "resetOfflineFailed")].filter(Boolean)
      : t("resetBody").split(/\n\s*\n/);
    const action = resetRemaining ? t("retryReset") : t("resetOk");
    setText(els.resetOk, action);
    setTooltip(els.resetOk, action);
    for (const paragraphText of paragraphs) {
      const paragraph = document.createElement("p");
      paragraph.textContent = paragraphText;
      els.resetBody.appendChild(paragraph);
    }
  }

  function renderOnboarding(uiValue = uiPrefs.uiLanguage, audioValue = bookSelection?.languageCode) {
    const previewLocale = resolveUiLocale(uiValue);
    const ot = (key, variables = {}) => translateAt(previewLocale, key, variables);
    destroyCustomSelect(onboardingUiSelect);
    destroyCustomSelect(onboardingAudioSelect);
    clearChildren(els.onboardingBody);
    const intro = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = ot("onboardP1");
    intro.appendChild(strong);
    const list = document.createElement("ul");
    for (const key of ["onboardItemPlayback", "onboardItemChapters", "onboardItemShortcuts", "onboardItemOptions", "onboardItemSleep", "onboardItemOffline"]) {
      const item = document.createElement("li"); item.textContent = ot(key); list.appendChild(item);
    }
    const controls = document.createElement("div");
    controls.className = "onboard-controls";
    const heading = document.createElement("strong");
    heading.textContent = ot("onboardLangTitle");
    controls.appendChild(heading);
    const uiRow = document.createElement("div"); uiRow.className = "onboard-row";
    const uiLabel = document.createElement("label"); uiLabel.htmlFor = "onboardingUiLanguage"; uiLabel.textContent = ot("uiLanguageLabel");
    onboardingUiSelect = document.createElement("select"); onboardingUiSelect.id = "onboardingUiLanguage";
    const uiRecords = [{ value: "auto", label: ot("uiLanguageAuto") }, ...Object.keys(UI_STRINGS).map((code) => ({ value: code, label: uiLanguageNames[code] || code }))];
    optionsFrom(onboardingUiSelect, uiRecords, uiValue, (item) => item.label);
    uiRow.append(uiLabel, selectWithArrow(onboardingUiSelect));
    enhanceCustomSelect(onboardingUiSelect);
    const audioRow = document.createElement("div"); audioRow.className = "onboard-row";
    const audioLabel = document.createElement("label"); audioLabel.htmlFor = "onboardingAudioLanguage"; audioLabel.textContent = ot("languageLabel");
    onboardingAudioSelect = document.createElement("select"); onboardingAudioSelect.id = "onboardingAudioLanguage";
    optionsFrom(onboardingAudioSelect, Object.values(book.languages).map((language) => ({ value: language.code, label: language.label })), audioValue, (item) => item.label);
    audioRow.append(audioLabel, selectWithArrow(onboardingAudioSelect));
    enhanceCustomSelect(onboardingAudioSelect);
    controls.append(uiRow, audioRow);
    els.onboardingBody.append(intro, list, controls);
    setText(els.onboardingTitle, ot("onboardTitle"));
    setText(els.onboardingOk, ot("onboardOk"));
    els.onboardingCloseX.setAttribute("aria-label", ot("close"));
    onboardingUiSelect.addEventListener("change", () => renderOnboarding(onboardingUiSelect.value, onboardingAudioSelect.value));
  }

  function openOnboarding() { renderOnboarding(); openDialog(els.onboardingDialog, els.onboardingOk); }
  function acceptOnboarding() {
    storage.markOnboardingSeen();
    if (onboardingUiSelect && onboardingUiSelect.value !== uiPrefs.uiLanguage) {
      uiPrefs.uiLanguage = onboardingUiSelect.value;
      storage.writeUiPreference("uiLanguage", uiPrefs.uiLanguage);
      locale = resolveUiLocale(uiPrefs.uiLanguage);
      applyStrings();
    }
    if (onboardingAudioSelect && onboardingAudioSelect.value !== bookSelection.languageCode) void changeLanguage(onboardingAudioSelect.value);
    closeDialog(els.onboardingDialog);
  }

  function renderSleepOptions() {
    clearChildren(els.sleepList);
    const records = [{ mode: "chapter", label: t("sleepEndChapterOption") }, ...sleepDurations.map((minutes) => ({ mode: "minutes", minutes, label: t("sleepTimerOption", { m: minutes }) })), { mode: "off", label: t("sleepTimerOff") }];
    for (const record of records) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sleep-option";
      button.textContent = record.label;
      const selected = record.mode === sleep.mode && (record.mode !== "minutes" || record.minutes === sleep.minutes);
      button.setAttribute("aria-pressed", String(selected));
      button.addEventListener("click", () => {
        if (record.mode === "minutes") sleep.startMinutes(record.minutes);
        else if (record.mode === "chapter") void startSleepChapter();
        else sleep.cancel();
        closePanel(els.sleepPanel, els.sleepBtn, true);
      });
      els.sleepList.appendChild(button);
    }
    updateSleepButton();
  }

  async function startSleepChapter() {
    const generation = sleep.generation;
    const request = ensureChapters();
    const sourceGeneration = chapters.generation;
    await request;
    if (generation !== sleep.generation || sourceGeneration !== chapters.generation) return;
    sleep.startChapter(currentChapterEnd());
  }

  function currentChapterEnd() {
    const duration = chapterDuration();
    const index = chapters.indexAt(media.position(), duration);
    return index >= 0 ? chapters.end(index, duration) : null;
  }

  function updateSleepButton() {
    const active = sleep.mode !== "off";
    els.sleepBtn.classList.toggle("is-active", active);
    let label = t("sleepTimer");
    if (sleep.mode === "minutes") label += `: ${t("sleepTimerOption", { m: Math.max(1, Math.ceil((sleep.endAt - Date.now()) / 60000)) })}`;
    else if (sleep.mode === "chapter") label += `: ${t("sleepEndChapterOption")}`;
    els.sleepBtn.setAttribute("aria-label", label);
    setText(els.sleepBtn.querySelector(".sr-only"), label);
    setTooltip(els.sleepBtn, label);
  }

  function changeLanguage(nextCode) {
    if (!isOnline()) {
      setSelectValue(els.langSelect, bookSelection.languageCode);
      showToast(t("offlineSelectionLocked"), "warning", 5000, "offline-selection");
      return;
    }
    if (nextCode === bookSelection.languageCode) return;
    const selected = bookSelection.selectLanguage(nextCode);
    if (!selected) {
      setSelectValue(els.langSelect, bookSelection.languageCode);
      showToast(t("sourceExhausted"), "error");
      return;
    }
    const position = media.position();
    progress.flush();
    sleep.cancel(true);
    const shouldPlay = media.playbackIntent;
    populateLanguageSelect();
    populateQualitySelect();
    resetChapters(book, bookSelection.languageCode, selected);
    updateTitle();
    updateMeta();
    storage.setProgress(bookSelection.bookId, bookSelection.languageCode, position);
    void media.setSelection(bookSelection.sources, selected.id, position, shouldPlay);
    renderOfflineUi();
  }

  async function changeQuality(nextId) {
    if (!isOnline()) {
      setSelectValue(els.qualitySelect, bookSelection.source.id);
      showToast(t("offlineSelectionLocked"), "warning", 5000, "offline-selection");
      return;
    }
    const selected = bookSelection.selectQuality(nextId);
    if (!selected) return;
    const position = media.position();
    const shouldPlay = media.playbackIntent;
    await media.setSelection(bookSelection.sources, selected.id, position, shouldPlay);
  }

  function updateMediaSessionMetadata() {
    mediaSession.setMetadata({ title: mediaMetadataTitle || t("audio"),
      chapter: chapters.activeTitle, artwork: els.coverImg.src });
  }

  const unbindMediaSession = mediaSession.bind({
    play: () => { durationUnlocked = true; void media.requestPlay(); },
    pause: () => media.requestPause(),
    seekbackward: (details) => media.seek(media.position() - (details.seekOffset || uiPrefs.skipSeconds)),
    seekforward: (details) => media.seek(media.position() + (details.seekOffset || uiPrefs.skipSeconds)),
    seekto: (details) => Number.isFinite(details.seekTime) && media.seek(details.seekTime),
    previoustrack: () => void seekChapter("previous"),
    nexttrack: () => void seekChapter("next"),
  });

  function closeAllPanels(except = null, restore = false) {
    if (except !== els.chaptersPanel) closePanel(els.chaptersPanel, els.chaptersBtn, restore && document.activeElement && els.chaptersPanel.contains(document.activeElement));
    if (except !== els.sleepPanel) closePanel(els.sleepPanel, els.sleepBtn, restore && document.activeElement && els.sleepPanel.contains(document.activeElement));
    if (except !== els.optionsPanel) closePanel(els.optionsPanel, els.optionsBtn, restore && document.activeElement && els.optionsPanel.contains(document.activeElement));
  }

  els.playPauseBtn.addEventListener("click", () => {
    durationUnlocked = true;
    void media.togglePlayback();
    updateTime(media.position(), media.duration());
  });
  els.skipBackBtn.addEventListener("click", () => media.seek(media.position() - uiPrefs.skipSeconds));
  els.skipForwardBtn.addEventListener("click", () => media.seek(media.position() + uiPrefs.skipSeconds));
  els.prevChapterBtn.addEventListener("click", () => void seekChapter("previous"));
  els.nextChapterBtn.addEventListener("click", () => void seekChapter("next"));
  els.chaptersBtn.addEventListener("click", async () => {
    if (!els.chaptersPanel.hidden) { closePanel(els.chaptersPanel, els.chaptersBtn, true); return; }
    closeAllPanels(els.chaptersPanel);
    openPanel(els.chaptersPanel, els.chaptersBtn, els.closeChaptersBtn);
    await ensureChapters();
  });
  els.sleepBtn.addEventListener("click", () => {
    if (!els.sleepPanel.hidden) { closePanel(els.sleepPanel, els.sleepBtn, true); return; }
    closeAllPanels(els.sleepPanel); renderSleepOptions(); openPanel(els.sleepPanel, els.sleepBtn, els.closeSleepBtn);
  });
  els.optionsBtn.addEventListener("click", () => {
    if (!els.optionsPanel.hidden) { closePanel(els.optionsPanel, els.optionsBtn, true); return; }
    closeAllPanels(els.optionsPanel);
    openPanel(els.optionsPanel, els.optionsBtn, els.bookRow.hidden ? selectFocusTarget(els.langSelect) : selectFocusTarget(els.bookSelect));
    if (libraryNeedsRetry || !book) void recoverLibrary();
    void loadLibraryTitles();
    availability.request({ immediate: true });
  });
  els.closeChaptersBtn.addEventListener("click", () => closePanel(els.chaptersPanel, els.chaptersBtn, true));
  els.closeSleepBtn.addEventListener("click", () => closePanel(els.sleepPanel, els.sleepBtn, true));
  els.bookSelect.addEventListener("change", async () => {
    if (!isOnline()) {
      setSelectValue(els.bookSelect, requestedBookId);
      showToast(t("offlineSelectionLocked"), "warning", 5000, "offline-selection");
      return;
    }
    try { await loadBook(els.bookSelect.value); }
    catch (error) {
      setSelectValue(els.bookSelect, requestedBookId);
      reportError("book change", error, t("errorLoading"));
    }
  });
  els.langSelect.addEventListener("change", () => void changeLanguage(els.langSelect.value));
  els.qualitySelect.addEventListener("change", () => void changeQuality(els.qualitySelect.value));
  els.speedRange.addEventListener("input", () => {
    uiPrefs.playbackRate = clamp(Number(els.speedRange.value), .5, 2);
    media.setPlaybackRate(uiPrefs.playbackRate);
    setText(els.speedValue, `${Number(uiPrefs.playbackRate.toFixed(2))}×`);
    els.speedRange.setAttribute("aria-valuetext", els.speedValue.textContent);
  });
  els.speedRange.addEventListener("change", () => storage.writeUiPreference("playbackRate", uiPrefs.playbackRate));
  els.volumeRange.addEventListener("input", () => {
    uiPrefs.volume = clamp(Number(els.volumeRange.value) / 100, 0, 1);
    media.setVolume(uiPrefs.volume);
    setText(els.volumeValue, `${Math.round(uiPrefs.volume * 100)}%`);
    els.volumeRange.setAttribute("aria-valuetext", els.volumeValue.textContent);
  });
  els.volumeRange.addEventListener("change", () => storage.writeUiPreference("volume", uiPrefs.volume));
  els.skipSelect.addEventListener("change", () => { applySkipInterval(Number(els.skipSelect.value)); storage.writeUiPreference("skipSeconds", uiPrefs.skipSeconds); });
  els.themeSelect.addEventListener("change", () => { uiPrefs.theme = els.themeSelect.value; storage.writeUiPreference("theme", uiPrefs.theme); setAppearance(); });
  els.fontSizeSelect.addEventListener("change", () => { uiPrefs.fontSize = els.fontSizeSelect.value; storage.writeUiPreference("fontSize", uiPrefs.fontSize); setAppearance(); });
  els.uiLangSelect.addEventListener("change", () => { uiPrefs.uiLanguage = els.uiLangSelect.value; storage.writeUiPreference("uiLanguage", uiPrefs.uiLanguage); locale = resolveUiLocale(uiPrefs.uiLanguage); applyStrings(); updateTitle(); });
  els.optionsPanel.addEventListener("submit", (event) => event.preventDefault());
  els.offlineDownloadBtn.addEventListener("click", () => void downloadOfflineSelection());
  els.offlineRepairBtn.addEventListener("click", async () => {
    try {
      await offline.repairConfig();
      if (!book) location.reload();
      else showToast(t("offlineComplete"), "success");
    } catch (error) {
      if (error?.name !== "AbortError") reportError("repair offline configuration", error, offlineErrorMessage(error));
    }
  });
  els.offlineCancelBtn.addEventListener("click", async () => {
    els.offlineCancelBtn.disabled = true;
    try { await offline.cancel(); }
    catch (error) { reportError("cancel offline download", error, offlineErrorMessage(error)); }
    finally { els.offlineCancelBtn.disabled = false; renderOfflineUi(); }
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
    finally { els.offlineRemoveBtn.disabled = false; renderOfflineUi(); }
  });

  els.seek.addEventListener("input", () => {
    seekDragging = true;
    const duration = media.duration() || book?.duration || 0;
    setText(els.timeCur, formatTime(duration * Number(els.seek.value) / 1000));
  });
  els.seek.addEventListener("change", () => {
    const duration = media.duration() || book?.duration || 0;
    media.seek(duration * Number(els.seek.value) / 1000);
    seekDragging = false;
  });

  els.coverButton.addEventListener("click", () => {
    els.coverDialogImg.src = els.coverImg.currentSrc || els.coverImg.src;
    els.coverDialogImg.alt = els.coverImg.alt;
    openDialog(els.coverDialog, els.closeCoverBtn);
  });
  bindDialogDismiss(els.coverDialog, els.closeCoverBtn, () => { els.coverDialogImg.removeAttribute("src"); });
  bindDialogDismiss(els.onboardingDialog, els.onboardingCloseX, () => storage.markOnboardingSeen());
  function dismissReset() {
    if (els.resetOk.disabled) return false;
    if (resetRemaining) location.reload();
  }
  bindDialogDismiss(els.resetDialog, els.resetCloseX, dismissReset);
  els.onboardingOk.addEventListener("click", acceptOnboarding);
  els.resetBtn.addEventListener("click", () => openDialog(els.resetDialog, els.resetOk));
  els.resetCancel.addEventListener("click", () => { if (dismissReset() !== false) closeDialog(els.resetDialog); });
  els.resetOk.addEventListener("click", async () => {
    if (els.resetOk.disabled) return;
    if (!resetRemaining) {
      resetRemaining = { local: true, offline: true };
      progress.stop();
      bookGeneration++;
      bookController?.abort();
      chapters.reset();
      availability.selectLanguage("");
      clearCover();
      sleep.cancel(true);
      unbindMediaSession?.();
      media.destroy();
    }
    els.resetOk.disabled = true;
    setText(els.resetOk, t("resetting"));
    if (resetRemaining.local) resetRemaining.local = !storage.reset();
    if (resetRemaining.offline) {
      try {
        await offline.reset();
        resetRemaining.offline = false;
      } catch (error) {
        resetRemaining.offline = error?.code === "conflict" ? "conflict" : true;
        reportError("offline reset", error);
      }
    }
    if (resetRemaining.local || resetRemaining.offline) {
      els.resetOk.disabled = false;
      renderResetBody();
      announce([...els.resetBody.children].map((item) => item.textContent).join(" "));
      els.resetOk.focus();
      return;
    }
    location.reload();
  });

  document.addEventListener("click", (event) => {
    closeSelectOutside(event.target);
    if (!els.player.contains(event.target)) closeAllPanels();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { closeAllCustomSelects(true); closeAllPanels(null, true); return; }
    if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest("button, input, select, textarea, a, dialog")) return;
    if (event.code === "Space") {
      event.preventDefault();
      durationUnlocked = true;
      void media.togglePlayback();
    }
    else if (event.code === "ArrowLeft") { event.preventDefault(); media.seek(media.position() - 5); }
    else if (event.code === "ArrowRight") { event.preventDefault(); media.seek(media.position() + 5); }
    else if (event.code === "ArrowUp") { event.preventDefault(); media.seek(media.position() + uiPrefs.skipSeconds); }
    else if (event.code === "ArrowDown") { event.preventDefault(); media.seek(media.position() - uiPrefs.skipSeconds); }
  });
  window.addEventListener("pagehide", () => progress.flush(), { capture: true });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") progress.flush(); });
  window.addEventListener("offline", () => {
    availability.cancel();
    showToast(t("connectionLost"), "warning", 7000, "offline");
    renderOfflineUi();
  });
  window.addEventListener("online", () => {
    if (resetRemaining) return;
    void recoverLibrary();
    showToast(t("connectionRestored"), "success", 4000, "online");
    if (chapters.status === "failed") void ensureChapters({ force: true, notifyFailure: false });
    availability.request({ refresh: true });
    void media.handleReconnect();
    renderOfflineUi();
  });

  async function boot() {
    setLoading(true);
    applyUiPreferences();
    applyStrings();
    const offlineReady = offline.init();
    const startedOffline = !isOnline();
    if (startedOffline) await offlineReady;
    const catalog = await loadLibrary();
    const preferDownloaded = startedOffline || !isOnline();
    if (preferDownloaded && !startedOffline) await offlineReady;
    libraryNeedsRetry = !catalog || catalog.fromDownload;
    library = catalog?.library || normalizeLibrary(null);
    const downloadedConfig = preferDownloaded ? offline.downloadedConfig : null;
    bookConfigs = new BookConfigStore({ library, documentBaseUrl, downloadedConfig, fetchImpl });
    const downloadedId = preferDownloaded ? offline.snapshot().active?.episodeId || "" : "";
    startupBookRequest = loadStartupBook(downloadedId);
    if (!els.optionsPanel.hidden) void loadLibraryTitles();
    if (preferDownloaded && isOnline()) void recoverLibrary();
    await startupBookRequest;
  }

  async function loadStartupBook(downloadedId = "") {
    const queryId = queryBookId(new URL(location.href).searchParams, library);
    const savedId = storage.getLastBook();
    const initialId = downloadedId || queryId || (library.byId.has(savedId) ? savedId : "") || library.defaultId || "episode-001";
    try {
      await loadBook(initialId);
    } catch (error) {
      reportError("startup", error, `${t("errorLoading")} ${error.message}`);
    }
  }

  return boot();
}
