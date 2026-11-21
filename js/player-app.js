import { UI_STRINGS } from "../i18n.js?v=14";
import { BookConfigStore, queryBookId } from "./book-config.js";
import { AvailabilitySession } from "./availability-session.js";
import { createCustomSelects } from "./custom-select.js";
import { isMp4Audio, qualityLabelKey } from "./codecs.js";
import { ChapterSession } from "./chapter-session.js";
import { localizedValue, normalizeLibrary, parseJson, resolveCover } from "./config.js";
import { bindDialogDismiss, closeDialog, closePanel, openDialog, openPanel } from "./dialogs.js";
import { createMediaSession } from "./media-session.js";
import { MediaController } from "./media-controller.js";
import { createCoverView } from "./cover.js";
import { OfflineManager, manifestMatchesSelection, sameOfflineSelection } from "./offline.js";
import { buildSources, chooseDefaultSource, visibleSources } from "./source-selection.js";
import { SKIP_INTERVALS, skipInterval } from "./preferences.js";
import { ProgressWriter } from "./progress-writer.js";
import { SleepTimer } from "./sleep-timer.js";
import { clearChildren, clamp, fetchTextWithRetry, formatTime, normalizeLanguageTag, safeUrl, setText, UNKNOWN_TIME } from "./utils.js";

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
  let bookId = "";
  let bookConfigUrl = "";
  let languageCode = "";
  let sourcesByLanguage = new Map();
  let selectedSourceId = "";
  let currentSource = null;
  const availability = new AvailabilitySession({
    window, fetchImpl, isOnline,
    readCache: storage.readAvailabilityCache.bind(storage),
    writeCache: storage.writeAvailability.bind(storage),
    onChange: () => populateQualitySelect(currentSource),
    onError: (error) => reportError("availability scan", error),
  });
  const chapters = new ChapterSession({
    fetchImpl,
    readCache: storage.readChapterData.bind(storage),
    writeCache: storage.writeChapterData.bind(storage),
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
      if (focusOfflineCancel && snapshot.phase === "preparing") {
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
    document.body.classList.toggle("is-loading", loading);
    els.player.classList.toggle("is-loading", loading);
    els.player.setAttribute("aria-busy", String(loading));
    els.playPauseBtn.disabled = loading || !book;
  }

  function setBusy(busy) {
    uiBusy = busy;
    els.player.classList.toggle("is-busy", busy);
    updateSelectionControlState();
  }

  function updateSelectionControlState() {
    const offlineLocked = !isOnline();
    els.bookSelect.disabled = uiBusy || offlineLocked;
    els.langSelect.disabled = uiBusy || offlineLocked;
    els.qualitySelect.disabled = uiBusy || offlineLocked || (book ? qualityOptionsForCurrentLanguage().length <= 1 : true);
    syncSelectionControls();
  }

  function setMeta(message, error = false) {
    setText(els.bookMeta, message);
    els.bookMeta.classList.toggle("is-error", error);
  }

  function displayTitle() {
    return localizedValue(book?.title, languageCode, book?.id || t("audio"));
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
    const language = book.languages[languageCode];
    const source = currentSource || sourcesByLanguage.get(languageCode)?.find((item) => item.id === selectedSourceId);
    if (!language || !source?.url) return null;
    return {
      episodeId: bookId,
      configBookId: book.id,
      episodeTitle: displayTitle(),
      languageCode,
      languageLabel: language.label || languageCode,
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
    const busy = ["preparing", "downloading", "finalizing", "publishing-repair"].includes(state.phase);
    const percent = Math.round(state.progress * 100);
    let status = "";
    let action = t("offlineDownload");
    let showDownload = true;
    let showCancel = false;
    const showRemove = Boolean(state.active || state.repairable) && !busy;

    els.offlineProgress.hidden = true;
    if (state.phase === "preparing" || state.phase === "publishing-repair") {
      status = t("offlinePreparing");
      showDownload = false;
      showCancel = state.phase === "preparing";
    } else if (["downloading", "finalizing"].includes(state.phase) && state.staging) {
      status = t("offlineDownloading", { percent, size: formatBytes(state.progress * state.staging.totalSize), total: formatBytes(state.staging.totalSize) });
      els.offlineProgress.hidden = false;
      showDownload = false;
      showCancel = state.phase === "downloading";
    } else if (state.staging) {
      const partial = state.staging;
      const details = [partial.episodeTitle || partial.episodeId, partial.languageLabel || partial.languageCode,
        partial.sourceLabel || partial.sourceId, formatBytes(partial.totalSize), t("offlinePaused", { percent })];
      if (state.active) details.unshift(manifestDescription(state.active));
      else if (state.repairable) details.unshift(t("offlineNeedsConfig", { book: state.repairable.episodeTitle }));
      status = details.join(" · ");
      action = t("offlineResume");
      showCancel = true;
      els.offlineProgress.hidden = false;
    } else if (activeMatches) {
      status = t("offlineReady", { size: formatBytes(state.active.totalSize) });
      showDownload = false;
    } else if (state.active) {
      status = manifestDescription(state.active);
      action = t("offlineReplace");
    } else if (state.repairable) {
      status = t("offlineNeedsConfig", { book: state.repairable.episodeTitle });
      showDownload = Boolean(selection);
      action = sameOfflineSelection(state.repairable, selection) ? t("offlineDownload") : t("offlineReplace");
    }

    els.offlineProgress.value = percent;
    setText(els.offlineStatus, status);
    setText(els.offlineDownloadBtn, action);
    setText(els.offlineCancelBtn, t("offlineCancel"));
    setText(els.offlineRemoveBtn, t("offlineRemove"));
    setText(els.offlineRepairBtn, t("offlineRepair"));
    els.offlineRepairBtn.hidden = !state.repairable || busy;
    els.offlineRepairBtn.disabled = !isOnline();
    els.offlineDownloadBtn.hidden = !showDownload;
    els.offlineDownloadBtn.disabled = busy || (!selection && !state.staging) || !isOnline();
    els.offlineCancelBtn.hidden = !showCancel;
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
    const language = book?.languages?.[languageCode];
    const source = currentSource || sourcesByLanguage.get(languageCode)?.find((item) => item.id === selectedSourceId);
    const chapterTitle = chapters.activeTitle;
    setMeta([language?.label || languageCode, sourceLabel(source, false), chapterTitle].filter(Boolean).join(" • "));
  }

  function guessLanguage(codes, fallback) {
    for (const browserLanguage of navigator.languages || [navigator.language]) {
      const normalized = normalizeLanguageTag(browserLanguage);
      if (codes.includes(normalized)) return normalized;
    }
    return codes.includes(fallback) ? fallback : codes[0];
  }

  const { optionsFrom, selectWithArrow, selectFocusTarget, setSelectValue, closeAllCustomSelects,
    syncCustomSelect, destroyCustomSelect, enhanceCustomSelect, syncSelectionControls, closeSelectOutside } = createCustomSelects(document, window);

  function initializeCustomSelects() {
    optionsFrom(els.skipSelect, SKIP_INTERVALS.map((seconds) => ({ value: String(seconds) })),
      String(uiPrefs.skipSeconds), (record) => record.value + " s");
    for (const select of [els.bookSelect, els.langSelect, els.qualitySelect, els.skipSelect, els.themeSelect, els.fontSizeSelect, els.uiLangSelect]) enhanceCustomSelect(select);
  }

  initializeCustomSelects();

  function populateLibrarySelect() {
    const records = library.books.map((item) => ({ ...item, value: item.id }));
    if (book && !library.byId.has(bookId)) records.unshift({ value: bookId, label: displayTitle() || bookId });
    optionsFrom(els.bookSelect, records, bookId, (item) => localizedValue(item.title, locale, item.label || item.id));
    els.bookRow.hidden = records.length <= 1;
  }

  function populateLanguageSelect() {
    optionsFrom(els.langSelect, Object.values(book.languages).map((language) => ({ value: language.code, label: language.label })), languageCode, (item) => item.label);
  }

  function qualityOptionsForCurrentLanguage(forceSource = null) {
    const all = sourcesByLanguage.get(languageCode) || [];
    const visible = visibleSources(all, book.debug.showAllQualities);
    const forced = forceSource || all.find((source) => source.id === selectedSourceId);
    if (forced && !visible.some((source) => source.id === forced.id)) visible.unshift(forced);
    return visible;
  }

  function populateQualitySelect(forceSource = null) {
    const visible = qualityOptionsForCurrentLanguage(forceSource);
    optionsFrom(els.qualitySelect, visible.map((source) => ({ ...source, value: source.id })), forceSource?.id || selectedSourceId, (source) => book.debug.showAllQualities ? sourceLabel(source, true) : sourceLabel(source, false));
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
    fetchImpl, getEmbeddedSource: embeddedCoverAudioSource,
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

  function embeddedCoverAudioSource() {
    if (currentSource && isMp4Audio(currentSource)) return currentSource;
    if (!isOnline()) return null;
    return (sourcesByLanguage.get(languageCode) || []).find(isMp4Audio) || null;
  }

  async function loadLibrary() {
    try {
      const response = await fetchTextWithRetry(libraryUrl, { fetchImpl, cache: "no-store", credentials: "same-origin" });
      if (!response.ok) return null;
      return normalizeLibrary(parseJson(response.text, "media/library.json"));
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
        libraryNeedsRetry = false;
        library = catalog;
        bookConfigs.setLibrary(catalog);
        populateLibrarySelect();
      } else if (bookConfigs.downloadedConfig) bookConfigs.setLibrary(library);
      await startupBookRequest;
      if (!book && !bookController && generation === bookGeneration) await loadStartupBook();
      if (!els.optionsPanel.hidden) void loadLibraryTitles();
    })().finally(() => { libraryRetry = null; });
    return libraryRetry;
  }

  async function loadLibraryTitles() {
    if (library.books.length <= 1 || !isOnline()) return;
    await bookConfigs.loadTitles((id, error) => reportError(`library title (${id})`, error));
    populateLibrarySelect();
  }

  async function loadBook(id) {
    if (resetRemaining) return;
    sleep.cancel(true);
    bookController?.abort();
    resetChapters();
    bookController = new AbortController();
    const generation = ++bookGeneration;
    setLoading(true);
    setBusy(true);
    clearCover();
    bookConfigUrl = "";
    setText(els.bookTitle, t("audio"));
    setMeta(t("loading"));

    try {
      const loaded = await bookConfigs.load(id, { signal: bookController.signal });
      const loadedBook = loaded.book;
      if (generation !== bookGeneration) return;

      progress.flush();
      book = loadedBook;
      bookId = id;
      bookConfigUrl = loaded.configUrl;
      sourcesByLanguage = new Map(Object.values(book.languages).map((language) => [language.code, buildSources(language, els.audio)]));
      if (new URL(location.href).searchParams.get("clearAvailCache") === "1") storage.clearAvailability(book.id, book.cacheVersion);
      availability.setBook(book, sourcesByLanguage);
      const prefs = storage.readBook(bookId);
      const codes = Object.keys(book.languages);
      const { active } = offline.snapshot();
      const downloaded = !isOnline() && active?.episodeId === id
        && String(active.cacheVersion) === String(book.cacheVersion) ? active : null;
      languageCode = downloaded && codes.includes(downloaded.languageCode)
        ? downloaded.languageCode
        : codes.includes(prefs.language) ? prefs.language : guessLanguage(codes, book.defaultLanguage);
      const languageSources = sourcesByLanguage.get(languageCode);
      let selected = downloaded
        ? languageSources.find((source) => source.id === downloaded.sourceId && source.url === downloaded.sourceUrl)
        : null;
      if (!selected) selected = languageSources.find((source) => source.id === prefs.quality && source.availability !== "missing") || chooseDefaultSource(languageSources);
      if (!selected) throw new Error("No configured audio source can be selected for this browser.");
      selectedSourceId = selected.id;
      currentSource = selected;
      durationUnlocked = false;
      resetChapters(book, languageCode, selected);
      media.setSelection(languageSources, selected.id, storage.getProgress(bookId, languageCode), false);
      media.setPlaybackRate(uiPrefs.playbackRate);
      media.setVolume(uiPrefs.volume);
      populateLibrarySelect();
      populateLanguageSelect();
      populateQualitySelect();
      updateTitle();
      updateMeta();
      void ensureChapters({ notifyFailure: false, showLoading: false });
      applyCover(book);
      updateChapterButtons();
      storage.setLastBook(id);
      setBookUrl(id);
      renderOfflineUi();
    } catch (error) {
      if (generation !== bookGeneration) return;
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

  function refreshEmbeddedChaptersForSource(source) {
    if (!book || !chapters.needsSource(source)) return;
    resetChapters(book, languageCode, source);
    updateMeta();
    const request = ensureChapters({ notifyFailure: false, showLoading: false });
    void sleep.refreshChapter(request, currentChapterEnd);
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
    const duration = durationUnlocked ? (mediaDuration || book?.duration || 0) : 0;
    if (!seekDragging) els.seek.value = duration ? String(Math.round(clamp(position / duration, 0, 1) * 1000)) : "0";
    els.seek.disabled = !duration;
    els.seek.setAttribute("aria-valuetext", duration ? `${formatTime(position)} of ${formatTime(duration)}` : formatTime(position));
    setText(els.timeCur, formatTime(position));
    setText(els.timeDur, duration ? formatTime(duration) : UNKNOWN_TIME);
    markActiveChapter(position);
    mediaSession.setPosition(position, duration, media.playbackRate);
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
    onProgress: (position, seek) => progress.record(bookId, languageCode, position, seek),
    onSourceChange: (source) => {
      if (resetRemaining) return;
      currentSource = source;
      selectedSourceId = source.id;
      populateQualitySelect(source);
      updateMeta();
      renderOfflineUi();
      refreshEmbeddedChaptersForSource(source);
    },
    onSourceSuccess: (source) => availability.markPlayed(source),
    onSourceFailure: (source, error) => reportError(`source failure (${source?.id || "unknown"})`, error),
    onFallback: (_failed, next) => {
      if (resetRemaining) return;
      selectedSourceId = next.id;
      storage.setBookSelection(bookId, languageCode, next.id);
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
    if (book) {
      populateLibrarySelect();
      populateQualitySelect(currentSource);
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

  function renderOnboarding(uiValue = uiPrefs.uiLanguage, audioValue = languageCode) {
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
      storage.writeUi(uiPrefs);
      locale = resolveUiLocale(uiPrefs.uiLanguage);
      applyStrings();
    }
    if (onboardingAudioSelect && onboardingAudioSelect.value !== languageCode) void changeLanguage(onboardingAudioSelect.value);
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
      setSelectValue(els.langSelect, languageCode);
      showToast(t("offlineSelectionLocked"), "warning", 5000, "offline-selection");
      return;
    }
    if (nextCode === languageCode) return;
    const all = sourcesByLanguage.get(nextCode) || [];
    const selected = all.find((source) => source.url && source.id === selectedSourceId && source.availability !== "missing") || chooseDefaultSource(all);
    if (!selected) {
      setSelectValue(els.langSelect, languageCode);
      showToast(t("sourceExhausted"), "error");
      return;
    }
    const position = media.position();
    progress.flush();
    sleep.cancel(true);
    languageCode = nextCode;
    selectedSourceId = selected.id;
    currentSource = selected;
    const shouldPlay = media.playbackIntent;
    populateLanguageSelect();
    populateQualitySelect(selected);
    resetChapters(book, languageCode, selected);
    updateTitle();
    updateMeta();
    void ensureChapters({ notifyFailure: false, showLoading: false });
    applyCover(book);
    storage.setProgress(bookId, languageCode, position);
    storage.setBookSelection(bookId, languageCode, selected.id);
    void media.setSelection(all, selected.id, position, shouldPlay);
    renderOfflineUi();
  }

  async function changeQuality(nextId) {
    if (!isOnline()) {
      setSelectValue(els.qualitySelect, selectedSourceId);
      showToast(t("offlineSelectionLocked"), "warning", 5000, "offline-selection");
      return;
    }
    const all = sourcesByLanguage.get(languageCode) || [];
    const selected = all.find((source) => source.id === nextId);
    if (!selected || selected.id === selectedSourceId) return;
    const position = media.position();
    const shouldPlay = media.playbackIntent;
    storage.setBookSelection(bookId, languageCode, selected.id);
    await media.setSelection(all, selected.id, position, shouldPlay);
  }

  function updateMediaSessionMetadata() {
    mediaSession.setMetadata({ title: mediaMetadataTitle || t("audio"),
      chapter: chapters.activeTitle, artwork: els.coverImg.src });
  }

  function initializeMediaSession() {
    mediaSession.bind({
      play: () => { durationUnlocked = true; void media.requestPlay(); },
      pause: () => media.requestPause(),
      seekbackward: (details) => media.seek(media.position() - (details.seekOffset || uiPrefs.skipSeconds)),
      seekforward: (details) => media.seek(media.position() + (details.seekOffset || uiPrefs.skipSeconds)),
      seekto: (details) => Number.isFinite(details.seekTime) && media.seek(details.seekTime),
      previoustrack: () => void seekChapter("previous"),
      nexttrack: () => void seekChapter("next"),
    });
  }

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
    else void loadLibraryTitles();
    availability.request({ immediate: true });
  });
  els.closeChaptersBtn.addEventListener("click", () => closePanel(els.chaptersPanel, els.chaptersBtn, true));
  els.closeSleepBtn.addEventListener("click", () => closePanel(els.sleepPanel, els.sleepBtn, true));
  els.bookSelect.addEventListener("change", async () => {
    if (!isOnline()) {
      setSelectValue(els.bookSelect, bookId);
      showToast(t("offlineSelectionLocked"), "warning", 5000, "offline-selection");
      return;
    }
    const previous = bookId;
    try { media.requestPause(); await loadBook(els.bookSelect.value); }
    catch (error) { reportError("book change", error, t("errorLoading")); await loadBook(previous); }
  });
  els.langSelect.addEventListener("change", () => void changeLanguage(els.langSelect.value));
  els.qualitySelect.addEventListener("change", () => void changeQuality(els.qualitySelect.value));
  els.speedRange.addEventListener("input", () => {
    uiPrefs.playbackRate = clamp(Number(els.speedRange.value), .5, 2);
    media.setPlaybackRate(uiPrefs.playbackRate);
    setText(els.speedValue, `${Number(uiPrefs.playbackRate.toFixed(2))}×`);
    els.speedRange.setAttribute("aria-valuetext", els.speedValue.textContent);
  });
  els.speedRange.addEventListener("change", () => storage.writeUi(uiPrefs));
  els.volumeRange.addEventListener("input", () => {
    uiPrefs.volume = clamp(Number(els.volumeRange.value) / 100, 0, 1);
    media.setVolume(uiPrefs.volume);
    setText(els.volumeValue, `${Math.round(uiPrefs.volume * 100)}%`);
    els.volumeRange.setAttribute("aria-valuetext", els.volumeValue.textContent);
  });
  els.volumeRange.addEventListener("change", () => storage.writeUi(uiPrefs));
  els.skipSelect.addEventListener("change", () => { applySkipInterval(Number(els.skipSelect.value)); storage.writeUi(uiPrefs); });
  els.themeSelect.addEventListener("change", () => { uiPrefs.theme = els.themeSelect.value; storage.writeUi(uiPrefs); setAppearance(); });
  els.fontSizeSelect.addEventListener("change", () => { uiPrefs.fontSize = els.fontSizeSelect.value; storage.writeUi(uiPrefs); setAppearance(); });
  els.uiLangSelect.addEventListener("change", () => { uiPrefs.uiLanguage = els.uiLangSelect.value; storage.writeUi(uiPrefs); locale = resolveUiLocale(uiPrefs.uiLanguage); applyStrings(); updateTitle(); });
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
    initializeMediaSession();
    const offlineReady = offline.init();
    const startedOffline = !isOnline();
    if (startedOffline) await offlineReady;
    const catalog = await loadLibrary();
    const preferDownloaded = startedOffline || !isOnline();
    if (preferDownloaded && !startedOffline) await offlineReady;
    libraryNeedsRetry = !catalog;
    library = catalog || normalizeLibrary(null);
    const downloadedConfig = preferDownloaded ? offline.downloadedConfig : null;
    bookConfigs = new BookConfigStore({ library, documentBaseUrl, downloadedConfig, fetchImpl });
    const downloadedId = preferDownloaded ? offline.snapshot().active?.episodeId || "" : "";
    startupBookRequest = loadStartupBook(downloadedId);
    if (preferDownloaded && isOnline()) void recoverLibrary();
    await startupBookRequest;
  }

  async function loadStartupBook(downloadedId = "") {
    const queryId = queryBookId(new URL(location.href).searchParams, library);
    const savedId = storage.getLastBook();
    const initialId = downloadedId || queryId || (library.byId.has(savedId) ? savedId : "") || library.defaultId || "episode-001";
    try {
      await loadBook(initialId);
      if (resetRemaining) return;
      if (library.ui.onboardingEnabled && !storage.hasSeenOnboarding()) openOnboarding();
    } catch (error) {
      setLoading(false);
      setMeta(t("errorLoading"), true);
      reportError("startup", error, `${t("errorLoading")} ${error.message}`);
    }
  }

  return boot();
}
