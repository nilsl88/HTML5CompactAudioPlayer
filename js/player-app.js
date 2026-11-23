import { resolveUiLocale, translateAt, uiLanguageOptions } from "../i18n.js?v=20";
import { BookConfigStore, fetchLibraryCatalog, queryBookId } from "./book-config.js?v=20";
import { BookSelection } from "./book-selection.js?v=20";
import { AvailabilitySession } from "./availability-session.js?v=20";
import { createCustomSelects } from "./custom-select.js?v=20";
import { isMp4Audio, qualityLabelKey } from "./codecs.js?v=20";
import { createChapterPanel } from "./chapter-panel.js?v=20";
import { ChapterSession } from "./chapter-session.js?v=20";
import { localizedValue, normalizeLibrary, resolveCover } from "./config.js?v=20";
import { bindDialogDismiss, closeDialog, closePanel, openDialog, openPanel } from "./dialogs.js?v=20";
import { createMediaSession } from "./media-session.js?v=20";
import { MediaController } from "./media-controller.js?v=20";
import { createCoverView } from "./cover.js?v=20";
import { createOfflinePanel } from "./offline-panel.js?v=20";
import { OfflineManager, manifestMatchesSelection } from "./offline.js?v=20";
import { visibleSources } from "./source-selection.js?v=20";
import { SKIP_INTERVALS, skipInterval } from "./preferences.js?v=20";
import { ProgressWriter } from "./progress-writer.js?v=20";
import { SleepTimer } from "./sleep-timer.js?v=20";
import { clearChildren, clamp, formatTime, safeUrl, setText, UNKNOWN_TIME } from "./utils.js?v=20";

export function startPlayer({ window, storage, fetchImpl }) {
  const { document, location, navigator } = window;
  const isOnline = () => navigator.onLine !== false;
  const els = Object.fromEntries([
    "player", "bookTitle", "bookMeta", "playPauseBtn", "playPauseIcon", "seek", "seekLabel", "timeCur", "timeDur",
    "coverButton", "coverImg", "chaptersBtn", "prevChapterBtn", "skipBackBtn", "skipForwardBtn", "nextChapterBtn",
    "sleepBtn", "optionsBtn", "chaptersPanel", "chaptersTitle", "closeChaptersBtn", "chaptersList", "sleepPanel",
    "sleepTitle", "closeSleepBtn", "sleepList", "optionsPanel", "audioSettingsLegend", "appearanceLegend", "bookRow",
    "bookSelect", "langSelect", "qualitySelect", "volumeRow", "volumeRange", "volumeValue", "speedRange", "speedValue",
    "skipSelect", "themeSelect", "fontSizeSelect", "uiLangSelect", "resetBtn", "audio", "toastHost",
    "statusAnnouncer", "coverDialog", "coverDialogTitle", "closeCoverBtn", "coverDialogImg", "onboardingDialog",
    "onboardingTitle", "onboardingBody", "onboardingCloseX", "onboardingOk", "resetDialog", "resetTitle", "resetBody",
    "resetCloseX", "resetCancel", "resetOk",
  ].map((id) => [id, document.getElementById(id)]));

  const documentBaseUrl = new URL(".", location.href).href;
  const libraryUrl = new URL("media/library.json", documentBaseUrl).href;
  const sleepDurations = [5, 10, 15, 30, 45, 60, 90, 120];
  const STALL_NOTICE_DELAY_MS = 2000;

  let uiPrefs = storage.readUi();
  let locale = resolveUiLocale(uiPrefs.uiLanguage, navigator);
  let library = normalizeLibrary(null);
  let bookConfigs = null;
  let libraryNeedsRetry = false;
  let libraryRetry = null;
  let startupBookRequest = null;
  let book = null;
  let bookConfigUrl = "";
  let bookSelection = null;
  let pendingBookConfig = null;
  let requestedBookId = "";
  const availability = new AvailabilitySession({
    window, fetchImpl, isOnline,
    openCache: storage.availabilityCache.bind(storage),
    onChange: populateQualitySelect,
    onError: (error) => reportError("availability scan", error),
  });
  const chapterPanel = createChapterPanel({
    list: els.chaptersList, panel: els.chaptersPanel, trigger: els.chaptersBtn, audio: els.audio, t, reportError,
    onSeek: (time) => media.seek(time),
    onRetry: () => ensureChapters({ force: true, notifyFailure: true, showLoading: false }),
  });
  const chapters = new ChapterSession({
    fetchImpl, isOnline,
    openCache: storage.chapterCache.bind(storage),
    onStart() {
      availability.waitForChapters();
      chapterPanel.setBusy(true);
    },
    onLoaded(result, pending) {
      applyChapterData(result);
      chapterPanel.setBusy(pending);
      if (!pending) availability.chaptersSettled();
    },
    onFailure(error, notify) {
      availability.chaptersSettled();
      chapterPanel.setBusy(false);
      reportError("chapter load", error);
      if (notify) showToast(t("chaptersLoadFailed"), "warning", 5000);
      chapterPanel.renderChapterFailure();
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
  let stallNoticeTimer = null;
  let onboardingUiSelect = null;
  let onboardingAudioSelect = null;
  const toastTimes = new Map();
  const errorTimes = new Map();
  const mediaSession = createMediaSession(navigator, window.MediaMetadata, reportError);
  const offline = new OfflineManager({
    navigatorObject: navigator, fetchImpl, getCacheStorage: () => window.caches,
    baseUrl: documentBaseUrl,
    workerScriptName: document.querySelector('meta[name="compact-player-worker"]')?.content,
    workerReleaseSequence: document.querySelector('meta[name="compact-player-release"]')?.content,
    onChange: renderOfflineUi,
  });
  const renderDownloads = createOfflinePanel(window, {
    offline, t, getLocale: () => locale, getSelection: currentOfflineSelection, isOnline,
    waitForPriority: waitForPlaybackPriority, reportError, showToast,
    onRepair() {
      if (!book) location.reload();
      else showToast(t("offlineComplete"), "success");
    },
  });

  function renderOfflineUi(state = offline.snapshot()) {
    updateSelectionControlState();
    renderDownloads(state);
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
    return visibleSources(bookSelection.sources, book.debug.showAllQualities, bookSelection.source);
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

  const { applyCover, retryCover, clearCover } = createCoverView(els.coverImg, els.coverButton, {
    fetchImpl,
    isOnline,
    getBookId: () => bookSelection?.bookId,
    getFileCoverUrl: (source, coverBook) => offline.worker.coverUrl(source, bookSelection?.bookId, coverBook),
    async canUseCachedCover(coverBook) {
      await offline.publishedReady;
      const saved = offline.snapshot().active;
      return Boolean(saved && saved.episodeId === bookSelection?.bookId
        && (!saved.configBookId || saved.configBookId === coverBook.id)
        && String(saved.cacheVersion) === String(coverBook.cacheVersion));
    },
    async canUseNativeCover(coverBook) {
      if (!navigator.serviceWorker?.controller) return true;
      await offline.publishedReady;
      const { supported, active } = offline.snapshot();
      return supported && (!active || (active.episodeId === bookSelection?.bookId
        && (!active.configBookId || active.configBookId === coverBook.id)
        && String(active.cacheVersion) === String(coverBook.cacheVersion)));
    },
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
        if (catalog) {
          libraryNeedsRetry = catalog.fromDownload;
          library = catalog.library;
          bookConfigs.setLibrary(library, { fromDownload: catalog.fromDownload });
          populateLibrarySelect();
          if (!book && bookController) setLoading(true);
        } else if (!book && !bookController) return;
      } else if (bookConfigs.downloadedConfig) bookConfigs.setLibrary(library);
      if (!els.optionsPanel.hidden) void loadLibraryTitles();
      await startupBookRequest;
      if (resetRemaining || bookController || !isOnline()) return;
      if (bookSelection) {
        const id = bookSelection.bookId;
        const currentGeneration = bookGeneration;
        try {
          const refreshed = await bookConfigs.load(id, { revalidate: true });
          if (resetRemaining || currentGeneration !== bookGeneration || !isOnline()) return;
          if (!refreshed.fromDownload && (refreshed.book !== book || refreshed.configUrl !== bookConfigUrl)) {
            pendingBookConfig = refreshed;
          }
          const record = library.byId.get(id);
          if (record) updateOptionLabel(els.bookSelect, id, libraryLabel(record));
        } catch (error) { reportError("book configuration refresh", error); }
      } else if (generation === bookGeneration) await loadStartupBook();
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
      const loaded = await bookConfigs.load(id, { signal: bookController.signal, revalidate: isOnline() });
      if (generation !== bookGeneration) return;

      if (new URL(location.href).searchParams.get("clearAvailCache") === "1") storage.clearAvailability(loaded.book.id, loaded.book.cacheVersion);
      applyBookConfig(id, loaded);
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

  function applyBookConfig(id, loaded, previousSelection) {
    const prepared = availability.prepareBook(loaded.book, els.audio);
    const next = new BookSelection({
      bookId: id, book: loaded.book, sources: prepared.sources,
      preferences: previousSelection
        ? { language: previousSelection.languageCode, quality: previousSelection.preferredId }
        : storage.readBookSelection(id),
      downloaded: isOnline() ? null : offline.snapshot().active,
      browserLanguages: navigator.languages || [navigator.language], saveSelection: storage.setBookSelection.bind(storage),
    });
    progress.flush();
    const position = previousSelection?.languageCode === next.languageCode
      ? media.position()
      : storage.getProgress(id, next.languageCode);
    if (!previousSelection || sleep.mode === "chapter") sleep.cancel(true);
    pendingBookConfig = null;
    book = loaded.book;
    bookConfigUrl = loaded.configUrl;
    bookSelection = next;
    availability.setBook(prepared);
    durationUnlocked = false;
    resetChapters(book, next.languageCode, next.source);
    void media.setSelection(next.sources, next.source.id, position, false);
    media.setPlaybackRate(uiPrefs.playbackRate);
    media.setVolume(uiPrefs.volume);
    populateLibrarySelect();
    populateLanguageSelect();
    populateQualitySelect();
    updateTitle();
    updateMeta();
    updateChapterButtons();
  }

  function setBookUrl(id) {
    try { const url = new URL(location.href); url.searchParams.set("book", id); url.searchParams.delete("episode"); window.history?.replaceState(null, "", url); } catch {}
  }

  function resetChapters(book, code, source) {
    availability.selectLanguage(code || "");
    chapters.reset(book, code, source, bookSelection?.bookId || book?.id);
    chapterPanel.reset();
    updateMediaSessionMetadata();
    updateChapterButtons();
  }

  function applyChapterData(result) {
    chapterPanel.setTrack(result);
    chapters.updatePosition(media.position(), chapterDuration());
    chapterPanel.renderChapters(chapters);
    updateChapterButtons();
    updateMeta();
    updateMediaSessionMetadata();
    if (result.kind === "vtt" && sleep.mode === "chapter") sleep.updateChapterEnd(currentChapterEnd());
  }

  function ensureChapters({ force = false, notifyFailure = true, showLoading = !els.chaptersPanel.hidden } = {}) {
    const request = chapters.load({ force, notifyFailure });
    if (showLoading && chapters.status === "loading") chapterPanel.renderPanelMessage(t("loadingChapters"));
    if (showLoading && chapters.status === "failed") chapterPanel.renderChapterFailure();
    return request;
  }

  function chapterDuration() {
    return media.duration() || book?.duration;
  }

  function markActiveChapter(position) {
    if (!chapters.updatePosition(position, chapterDuration())) return;
    updateMeta();
    updateMediaSessionMetadata();
    chapterPanel.setActive(chapters.activeIndex);
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
    const canPause = media.canPause;
    const label = canPause ? t("pause") : t("play");
    setText(els.playPauseIcon, canPause ? "Ⅱ" : "▶");
    els.playPauseBtn.setAttribute("aria-label", label);
    setTooltip(els.playPauseBtn, label);
    els.playPauseBtn.setAttribute("aria-busy", String(state === "loading" || (state === "stalled" && canPause)));
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
      if (!media.usingSavedSource) availability.markPlayed(source);
      bookSelection.confirmPlayed(source);
    },
    onSourceFailure: (source, error) => reportError(`source failure (${source?.id || "unknown"})`, error),
    savedSource: (source) => {
      const selection = currentOfflineSelection();
      const saved = offline.snapshot().active;
      if (!selection || source !== bookSelection.source || !manifestMatchesSelection(saved, selection)) return null;
      return offline.worker.savedAudio(saved);
    },
    allowNetworkSource: () => offline.worker.allowNetworkSource(),
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
      if (chapters.status === "failed") chapterPanel.renderChapterFailure();
      else if (chapters.status === "loading" && !els.chaptersPanel.hidden) chapterPanel.renderPanelMessage(t("loadingChapters"));
      else if (chapters.status === "loaded") chapterPanel.renderChapters(chapters);
    }
    updatePlaybackUi(media.state);
    renderOfflineUi();
  }

  function populateUiLanguageSelect() {
    const records = uiLanguageOptions(locale);
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
    const previewLocale = resolveUiLocale(uiValue, navigator);
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
    const uiRecords = uiLanguageOptions(previewLocale);
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
      locale = resolveUiLocale(uiPrefs.uiLanguage, navigator);
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

  function prepareExplicitPlay() {
    if (!media.canPause && pendingBookConfig && isOnline() && !bookController && !resetRemaining) {
      const refreshed = pendingBookConfig;
      pendingBookConfig = null;
      try { applyBookConfig(bookSelection.bookId, refreshed, bookSelection); }
      catch (error) { reportError("apply refreshed book configuration", error); }
    }
    durationUnlocked = true;
  }

  function toggleBookPlayback() {
    prepareExplicitPlay();
    void media.togglePlayback();
  }

  const unbindMediaSession = mediaSession.bind({
    play: () => { prepareExplicitPlay(); void media.requestPlay(); },
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
    toggleBookPlayback();
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
  els.uiLangSelect.addEventListener("change", () => { uiPrefs.uiLanguage = els.uiLangSelect.value; storage.writeUiPreference("uiLanguage", uiPrefs.uiLanguage); locale = resolveUiLocale(uiPrefs.uiLanguage, navigator); applyStrings(); updateTitle(); });
  els.optionsPanel.addEventListener("submit", (event) => event.preventDefault());

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
      if (event.repeat) return;
      toggleBookPlayback();
    }
    else if (event.code === "ArrowLeft") { event.preventDefault(); media.seek(media.position() - 5); }
    else if (event.code === "ArrowRight") { event.preventDefault(); media.seek(media.position() + 5); }
    else if (event.code === "ArrowUp") { event.preventDefault(); media.seek(media.position() + uiPrefs.skipSeconds); }
    else if (event.code === "ArrowDown") { event.preventDefault(); media.seek(media.position() - uiPrefs.skipSeconds); }
  });
  window.addEventListener("pagehide", () => progress.flush(), { capture: true });
  function syncOfflineBook() {
    if (!resetRemaining) void offline.syncPublishedDownload();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") progress.flush();
    else syncOfflineBook();
  });
  window.addEventListener("focus", syncOfflineBook);
  window.addEventListener("offline", () => {
    void offline.worker.prepare(offline.snapshot().active);
    syncOfflineBook();
    availability.cancel();
    showToast(t("connectionLost"), "warning", 7000, "offline");
    renderOfflineUi();
  });
  window.addEventListener("online", () => {
    if (resetRemaining) return;
    void offline.worker.prepare(offline.snapshot().active);
    syncOfflineBook();
    void recoverLibrary();
    showToast(t("connectionRestored"), "success", 4000, "online");
    void chapters.reconnect();
    if (bookSelection) retryCover(embeddedCoverAudioSource(bookSelection.source));
    availability.request({ refresh: true });
    void media.handleReconnect();
    renderOfflineUi();
  });

  async function waitForOfflineStartup() {
    if (isOnline()) return;
    const listener = new AbortController();
    const reconnected = new Promise((resolve) => {
      window.addEventListener("online", resolve, { once: true, signal: listener.signal });
    });
    try { await Promise.race([offline.publishedReady, reconnected]); }
    finally { listener.abort(); }
  }

  async function boot() {
    setLoading(true);
    applyUiPreferences();
    applyStrings();
    offline.listenForPublishedChanges(window.BroadcastChannel);
    void offline.init().catch((error) => reportError("offline initialization", error));
    const startedOffline = !isOnline();
    if (startedOffline) await waitForOfflineStartup();
    const catalog = await loadLibrary();
    const wasOffline = startedOffline || !isOnline();
    if (!isOnline()) await waitForOfflineStartup();
    const preferDownloaded = !isOnline();
    libraryNeedsRetry = !catalog || catalog.fromDownload;
    library = catalog?.library || normalizeLibrary(null);
    const downloadedConfig = preferDownloaded ? offline.downloadedConfig : null;
    bookConfigs = new BookConfigStore({ library, documentBaseUrl, downloadedConfig, fetchImpl });
    const downloadedId = preferDownloaded ? offline.snapshot().active?.episodeId || "" : "";
    startupBookRequest = loadStartupBook(downloadedId);
    if (!els.optionsPanel.hidden) void loadLibraryTitles();
    if (wasOffline && isOnline()) void recoverLibrary();
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
