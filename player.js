import { UI_STRINGS } from "./i18n.js?v=6";
import { scanSources } from "./js/availability.js";
import { loadChapters, parseChapterText } from "./js/chapters.js";
import { localizedValue, normalizeEpisode, normalizeLibrary, parseJson, resolveCover, resolveLanguageAsset } from "./js/config.js";
import { bindDialogDismiss, closeDialog, closePanel, openDialog, openPanel } from "./js/dialogs.js";
import { MediaController } from "./js/media-controller.js";
import { loadEmbeddedMp4Cover } from "./js/mp4-chapters.js";
import { OfflineDownloadError, OfflineManager, manifestMatchesSelection } from "./js/offline.js";
import { buildSources, chooseDefaultSource, visibleSources } from "./js/source-selection.js";
import { PlayerStorage } from "./js/storage.js";
import { clearChildren, clamp, createAbortError, fetchWithRetry, formatTime, normalizeLanguageTag, safeUrl, setText, UNKNOWN_TIME } from "./js/utils.js";

const els = Object.fromEntries([
  "player", "episodeTitle", "episodeMeta", "playPauseBtn", "playPauseIcon", "seek", "seekLabel", "timeCur", "timeDur",
  "coverButton", "coverImg", "chaptersBtn", "prevChapterBtn", "skipBackBtn", "skipForwardBtn", "nextChapterBtn",
  "sleepBtn", "optionsBtn", "chaptersPanel", "chaptersTitle", "closeChaptersBtn", "chaptersList", "sleepPanel",
  "sleepTitle", "closeSleepBtn", "sleepList", "optionsPanel", "audioSettingsLegend", "appearanceLegend", "episodeRow",
  "episodeSelect", "langSelect", "qualitySelect", "offlineRow", "offlineLabel", "offlineStatus", "offlineProgress",
  "offlineDownloadBtn", "offlineCancelBtn", "offlineRemoveBtn", "volumeRow", "volumeRange", "volumeValue", "speedRange", "speedValue",
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

const storage = new PlayerStorage(globalThis.localStorage);
const documentBaseUrl = new URL(".", location.href).href;
const libraryUrl = new URL("media/library.json", documentBaseUrl).href;
const uiLanguageNames = { en: "English", da: "Dansk", nb: "Norsk (bokmål)", sv: "Svenska" };
const sleepDurations = [5, 10, 15, 30, 45, 60, 90, 120];
const STALL_NOTICE_DELAY_MS = 2000;
const AVAILABILITY_IDLE_DELAY_MS = 1500;

let uiPrefs = storage.readUi();
let locale = resolveUiLocale(uiPrefs.uiLanguage);
let library = normalizeLibrary(null);
const episodeConfigCache = new Map();
const episodeConfigRequests = new Map();
let libraryTitlesPromise = null;
let episode = null;
let episodeId = "";
let episodeConfigUrl = "";
let languageCode = "";
let sourcesByLanguage = new Map();
let selectedSourceId = "";
let currentSource = null;
let cues = [];
let activeCueIndex = -1;
let chapterUrl = "";
let chapterMode = "none";
let chapterSourceKey = "";
let chaptersLoaded = false;
let chaptersFailed = false;
let chapterController = null;
let chapterLoadPromise = null;
let chapterLoadShouldNotify = false;
let episodeController = null;
let probeController = null;
let probeLanguageCode = "";
let probeScheduleHandle = null;
let probeScheduleUsesIdleCallback = false;
let scannedAvailabilityLanguages = new Set();
let episodeGeneration = 0;
let chapterGeneration = 0;
let durationUnlocked = false;
let seekDragging = false;
let uiBusy = false;
let progressTimer = null;
let lastProgressWrite = 0;
let resetInProgress = false;
let mediaMetadataTitle = "";
let mediaMetadataChapter = "";
let offlinePlaybackIntent = false;
let coverGeneration = 0;
let coverController = null;
let coverObjectUrl = "";
let trackObjectUrl = "";
let sleepGeneration = 0;
let sleepState = { mode: "off", minutes: 0, endAt: 0, chapterEnd: null, timeout: null, ticker: null, completing: false };
let stallNoticeTimer = null;
let onboardingUiSelect = null;
let onboardingAudioSelect = null;
const toastTimes = new Map();
const errorTimes = new Map();
let focusOfflineCancel = false;
const offline = new OfflineManager({
  baseUrl: documentBaseUrl,
  onChange: (snapshot) => {
    renderOfflineUi();
    if (focusOfflineCancel && snapshot.phase === "downloading") {
      focusOfflineCancel = false;
      requestAnimationFrame(() => els.offlineCancelBtn.focus());
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
  requestAnimationFrame(() => setText(els.statusAnnouncer, message));
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
  els.playPauseBtn.disabled = loading || !episode;
}

function setBusy(busy) {
  uiBusy = busy;
  els.player.classList.toggle("is-busy", busy);
  updateSelectionControlState();
}

function updateSelectionControlState() {
  const offlineLocked = navigator.onLine === false;
  els.episodeSelect.disabled = uiBusy || offlineLocked;
  els.langSelect.disabled = uiBusy || offlineLocked;
  els.qualitySelect.disabled = uiBusy || offlineLocked || (episode ? qualityOptionsForCurrentLanguage().length <= 1 : true);
}

function setMeta(message, error = false) {
  setText(els.episodeMeta, message);
  els.episodeMeta.classList.toggle("is-error", error);
}

function displayTitle() {
  return localizedValue(episode?.title, languageCode, episode?.id || t("audio"));
}

function sourceLabel(source, includeDetails = true) {
  if (!source) return "";
  let quality;
  if (source.codec === "mp3") quality = source.bitrate >= 128 ? t("qLegacyFair") : source.bitrate >= 96 ? t("qLegacyLow") : t("qLegacyUltraLow");
  else quality = source.bitrate >= 256 ? t("qPremium") : source.bitrate >= 128 ? t("qHigh") : source.bitrate >= 96 ? t("qLow") : t("qUltraLow");
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
  if (!episode || !episodeConfigUrl) return null;
  const language = episode.languages[languageCode];
  const source = currentSource || sourcesByLanguage.get(languageCode)?.find((item) => item.id === selectedSourceId);
  if (!language || !source?.url) return null;
  return {
    episodeId,
    episodeTitle: displayTitle(),
    languageCode,
    languageLabel: language.label || languageCode,
    sourceId: source.id,
    sourceLabel: sourceLabel(source, true),
    sourceUrl: source.url,
    mime: source.mime,
    cacheVersion: episode.cacheVersion,
    assets: [
      { url: libraryUrl, required: false },
      { url: episodeConfigUrl, required: true },
      { url: ["file", "auto"].includes(episode.coverSource) ? resolveCover(episode) : "", required: false },
      { url: chapterUrl, required: false },
    ].filter((asset) => {
      try { return asset.url && new URL(asset.url).origin === new URL(documentBaseUrl).origin; }
      catch { return false; }
    }),
  };
}

function selectionFromManifest(manifest) {
  if (!manifest) return null;
  return {
    episodeId: manifest.episodeId,
    episodeTitle: manifest.episodeTitle,
    languageCode: manifest.languageCode,
    languageLabel: manifest.languageLabel,
    sourceId: manifest.sourceId,
    sourceLabel: manifest.sourceLabel,
    sourceUrl: manifest.sourceUrl,
    mime: manifest.mime,
    cacheVersion: manifest.cacheVersion,
    assets: manifest.assets || [],
  };
}

function playbackSources(all, selected) {
  if (navigator.onLine !== false) return all;
  const cached = offline.active;
  if (cached?.episodeId === episodeId && cached.languageCode === languageCode && cached.sourceId === selected?.id && cached.sourceUrl === selected?.url) return [selected];
  return selected ? [selected] : [];
}

function manifestDescription(manifest) {
  return t("offlineSavedOther", {
    book: manifest.episodeTitle || manifest.episodeId,
    language: manifest.languageLabel || manifest.languageCode,
    quality: manifest.sourceLabel || manifest.sourceId,
    size: formatBytes(manifest.totalSize),
  });
}

function renderOfflineUi() {
  if (!els.offlineRow) return;
  updateSelectionControlState();
  els.offlineRow.hidden = !offline.supported;
  if (!offline.supported) return;
  setText(els.offlineLabel, t("offlineLabel"));
  const selection = currentOfflineSelection();
  const activeMatches = selection && manifestMatchesSelection(offline.active, selection);
  const busy = offline.phase === "preparing" || offline.phase === "downloading";
  const percent = Math.round(offline.progress * 100);
  let status = "";
  let action = t("offlineDownload");
  let showDownload = true;
  let showCancel = false;
  let showRemove = Boolean(offline.active) && !busy;

  els.offlineProgress.hidden = true;
  if (offline.phase === "preparing") {
    status = t("offlinePreparing");
    showDownload = false;
  } else if (offline.phase === "downloading" && offline.staging) {
    status = t("offlineDownloading", { percent, size: formatBytes(offline.progress * offline.staging.totalSize), total: formatBytes(offline.staging.totalSize) });
    els.offlineProgress.hidden = false;
    showDownload = false;
    showCancel = true;
  } else if (offline.staging) {
    status = `${manifestDescription(offline.staging)} · ${t("offlinePaused", { percent })}`;
    action = t("offlineResume");
    showCancel = true;
    els.offlineProgress.hidden = false;
  } else if (activeMatches) {
    status = t("offlineReady", { size: formatBytes(offline.active.totalSize) });
    showDownload = false;
  } else if (offline.active) {
    status = manifestDescription(offline.active);
    action = t("offlineReplace");
  }

  els.offlineProgress.value = percent;
  setText(els.offlineStatus, status);
  setText(els.offlineDownloadBtn, action);
  setText(els.offlineCancelBtn, t("offlineCancel"));
  setText(els.offlineRemoveBtn, t("offlineRemove"));
  els.offlineDownloadBtn.hidden = !showDownload;
  els.offlineDownloadBtn.disabled = busy || (!selection && !offline.staging) || navigator.onLine === false;
  els.offlineCancelBtn.hidden = !showCancel;
  els.offlineRemoveBtn.hidden = !showRemove;
}

function offlineErrorMessage(error) {
  if (error?.code === "offline") return t("offlineConnect");
  if (["unsupported", "cross-origin"].includes(error?.code)) return t("offlineUnsupported");
  if (error?.code === "range") return t("offlineRangeUnsupported");
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
  const selection = offline.staging ? selectionFromManifest(offline.staging) : currentOfflineSelection();
  if (!selection) return;
  offline.setPhase("preparing", offline.progress);
  try {
    const preflight = await offline.inspectSource(selection);
    const replacing = offline.active && !manifestMatchesSelection(offline.active, selection);
    if (!preflight.canResume) {
      if (replacing && !confirm(t("offlineReplaceConfirm", { book: offline.active.episodeTitle || offline.active.episodeId }))) {
        offline.setPhase(offline.staging ? "paused" : "idle", offline.progress);
        return;
      }
      if (!confirm(t("offlineConfirm", {
        book: selection.episodeTitle,
        language: selection.languageLabel,
        quality: selection.sourceLabel,
        size: formatBytes(preflight.totalSize),
      }))) {
        offline.setPhase(offline.staging ? "paused" : "idle", offline.progress);
        return;
      }
    }
    if (preflight.availableBytes != null && preflight.availableBytes < preflight.requiredBytes) {
      if (!offline.active || !confirm(t("offlineRemoveForSpace", { book: offline.active.episodeTitle || offline.active.episodeId }))) {
        throw new OfflineDownloadError("quota", "Insufficient browser storage");
      }
      await offline.removeActive();
    }
    const persisted = await offline.requestPersistence();
    focusOfflineCancel = true;
    await offline.start(selection, preflight, { waitForPriority: waitForPlaybackPriority });
    showToast(t("offlineComplete"), "success", 6000, "offline-complete");
    if (persisted === false) showToast(t("offlinePersistenceWarning"), "warning", 7000, "offline-persistence");
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (offline.phase === "preparing") offline.setPhase(offline.staging ? "paused" : "idle", offline.progress);
    reportError("offline download", error, offlineErrorMessage(error));
  } finally { focusOfflineCancel = false; renderOfflineUi(); }
}

function updateMeta() {
  const language = episode?.languages?.[languageCode];
  const source = currentSource || sourcesByLanguage.get(languageCode)?.find((item) => item.id === selectedSourceId);
  const chapterTitle = cues[activeCueIndex]?.title || "";
  setMeta([language?.label || languageCode, sourceLabel(source, false), chapterTitle].filter(Boolean).join(" • "));
}

function guessLanguage(codes, fallback) {
  for (const browserLanguage of navigator.languages || [navigator.language]) {
    const normalized = normalizeLanguageTag(browserLanguage);
    if (codes.includes(normalized)) return normalized;
  }
  return codes.includes(fallback) ? fallback : codes[0];
}

function optionsFrom(select, records, selected, label) {
  clearChildren(select);
  for (const record of records) {
    const option = document.createElement("option");
    option.value = record.value;
    option.textContent = label(record);
    option.selected = record.value === selected;
    select.appendChild(option);
  }
}

function populateLibrarySelect() {
  optionsFrom(els.episodeSelect, library.episodes.map((item) => ({ ...item, value: item.id })), episodeId, (item) => localizedValue(item.title, locale, item.label || item.id));
  els.episodeRow.hidden = library.episodes.length <= 1;
}

function populateLanguageSelect() {
  optionsFrom(els.langSelect, Object.values(episode.languages).map((language) => ({ value: language.code, label: language.label })), languageCode, (item) => item.label);
}

function qualityOptionsForCurrentLanguage(forceSource = null) {
  const all = sourcesByLanguage.get(languageCode) || [];
  const visible = visibleSources(all, episode.debug.showAllQualities);
  const forced = forceSource || all.find((source) => source.id === selectedSourceId);
  if (forced && !visible.some((source) => source.id === forced.id)) visible.unshift(forced);
  return visible;
}

function populateQualitySelect(forceSource = null) {
  const visible = qualityOptionsForCurrentLanguage(forceSource);
  optionsFrom(els.qualitySelect, visible.map((source) => ({ ...source, value: source.id })), forceSource?.id || selectedSourceId, (source) => episode.debug.showAllQualities ? sourceLabel(source, true) : sourceLabel(source, false));
  els.qualitySelect.disabled = uiBusy || navigator.onLine === false || visible.length <= 1;
}

function updateTitle() {
  const title = displayTitle();
  setText(els.episodeTitle, title);
  document.title = title || "Compact Audio Player";
  mediaMetadataTitle = title;
  updateMediaSessionMetadata();
}

function clearCover() {
  coverGeneration += 1;
  coverController?.abort();
  coverController = null;
  if (coverObjectUrl) URL.revokeObjectURL(coverObjectUrl);
  coverObjectUrl = "";
  els.coverButton.hidden = true;
  els.coverImg.onload = null;
  els.coverImg.onerror = null;
  els.coverImg.removeAttribute("src");
  els.coverImg.alt = "";
}

function showCoverImage(src, generation, onFailure) {
  els.coverImg.onload = () => {
    if (generation !== coverGeneration) return;
    els.coverImg.alt = displayTitle();
    els.coverButton.setAttribute("aria-label", t("openCover"));
    setTooltip(els.coverButton, t("openCover"));
    els.coverButton.hidden = false;
    updateMediaSessionMetadata();
  };
  els.coverImg.onerror = () => {
    if (generation === coverGeneration) onFailure();
  };
  els.coverImg.src = src;
}

function embeddedCoverAudioSource() {
  const isMp4 = (source) => source?.codec === "aac" || source?.mime?.startsWith("audio/mp4")
    || ["m4a", "m4b", "mp4"].includes(source?.extension);
  if (isMp4(currentSource)) return currentSource;
  if (navigator.onLine === false) return null;
  return (sourcesByLanguage.get(languageCode) || []).find(isMp4) || null;
}

function coverFailed(generation, error) {
  if (generation !== coverGeneration) return;
  if (error) reportError("embedded cover", error);
  clearCover();
  showToast(t("coverLoadFailed"), "warning", 5000, "cover-load");
}

async function applyEmbeddedCover(generation) {
  const source = embeddedCoverAudioSource();
  if (!source?.url) {
    coverFailed(generation);
    return;
  }
  const controller = new AbortController();
  coverController = controller;
  try {
    const cover = await loadEmbeddedMp4Cover(source.url, { signal: controller.signal });
    if (controller.signal.aborted || generation !== coverGeneration) return;
    if (!cover) throw new Error("The M4A/M4B file does not contain supported cover artwork.");
    coverObjectUrl = URL.createObjectURL(new Blob([cover.data], { type: cover.mime }));
    showCoverImage(coverObjectUrl, generation, () => coverFailed(generation, new Error("The embedded cover image could not be decoded.")));
  } catch (error) {
    if (error?.name !== "AbortError") coverFailed(generation, error);
  } finally {
    if (coverController === controller) coverController = null;
  }
}

function applyCover() {
  clearCover();
  const generation = coverGeneration;
  const mode = episode?.coverSource || (episode?.cover ? "file" : "none");
  if (mode === "none") return;
  const configuredCover = resolveCover(episode);
  if ((mode === "file" || mode === "auto") && configuredCover) {
    showCoverImage(configuredCover, generation, () => {
      if (mode === "auto") void applyEmbeddedCover(generation);
      else coverFailed(generation);
    });
    return;
  }
  if (mode === "embedded" || mode === "auto") void applyEmbeddedCover(generation);
}

function applyCachedAvailability() {
  const cached = storage.readAvailability(episode.id, episode.cacheVersion);
  for (const [code, sources] of sourcesByLanguage) {
    for (const source of sources) {
      const value = cached[code]?.[source.id];
      if (value === true) source.availability = "available";
      else if (value === false) source.availability = "missing";
      else if (["available", "missing", "unknown"].includes(value)) source.availability = value;
    }
  }
}

function persistAvailability() {
  const byLanguage = {};
  for (const [code, sources] of sourcesByLanguage) byLanguage[code] = Object.fromEntries(sources.map((source) => [source.id, source.availability]));
  storage.writeAvailability(episode.id, episode.cacheVersion, byLanguage);
}

function cancelScheduledAvailabilityScan() {
  if (probeScheduleHandle === null) return;
  if (probeScheduleUsesIdleCallback && typeof globalThis.cancelIdleCallback === "function") globalThis.cancelIdleCallback(probeScheduleHandle);
  else clearTimeout(probeScheduleHandle);
  probeScheduleHandle = null;
  probeScheduleUsesIdleCallback = false;
}

function cancelAvailabilityWork() {
  cancelScheduledAvailabilityScan();
  probeController?.abort();
  probeController = null;
  probeLanguageCode = "";
}

function startAvailabilityScan(generation, code = languageCode) {
  cancelScheduledAvailabilityScan();
  if (generation !== episodeGeneration || code !== languageCode || navigator.onLine === false || scannedAvailabilityLanguages.has(code)) return;
  if (probeController && probeLanguageCode === code && !probeController.signal.aborted) return;
  probeController?.abort();
  const controller = new AbortController();
  probeController = controller;
  probeLanguageCode = code;
  void (async () => {
    if (generation !== episodeGeneration || controller.signal.aborted) return;
    const sources = sourcesByLanguage.get(code) || [];
    try {
      await scanSources(sources, {
        signal: controller.signal,
        concurrency: 3,
        onResult: () => {
          if (generation !== episodeGeneration) return;
          persistAvailability();
          if (code === languageCode) populateQualitySelect(currentSource);
        },
      });
      if (generation === episodeGeneration && !controller.signal.aborted) scannedAvailabilityLanguages.add(code);
    } catch (error) {
      if (error?.name !== "AbortError") reportError("availability scan", error);
    } finally {
      if (probeController === controller) {
        probeController = null;
        probeLanguageCode = "";
      }
    }
  })();
}

function scheduleAvailabilityScan(generation, code = languageCode, immediate = false) {
  cancelScheduledAvailabilityScan();
  if (generation !== episodeGeneration || code !== languageCode || scannedAvailabilityLanguages.has(code)) return;
  const run = () => {
    probeScheduleHandle = null;
    probeScheduleUsesIdleCallback = false;
    startAvailabilityScan(generation, code);
  };
  if (immediate) { run(); return; }
  if (typeof globalThis.requestIdleCallback === "function") {
    probeScheduleUsesIdleCallback = true;
    probeScheduleHandle = globalThis.requestIdleCallback(run, { timeout: 3000 });
  } else probeScheduleHandle = setTimeout(run, AVAILABILITY_IDLE_DELAY_MS);
}

function requestAvailabilityScan(generation, code = languageCode, immediate = false) {
  const start = () => scheduleAvailabilityScan(generation, code, immediate);
  if (chapterLoadPromise) void chapterLoadPromise.then(start, start);
  else start();
}

async function loadLibrary(signal) {
  try {
    const response = await fetchWithRetry(libraryUrl, { cache: "no-store", credentials: "same-origin", signal });
    if (!response.ok) return normalizeLibrary(null);
    return normalizeLibrary(parseJson(await response.text(), "media/library.json"));
  } catch (error) {
    if (error?.name !== "AbortError") reportError("library load", error);
    return normalizeLibrary(null);
  }
}

function episodeFolder(id) { return library.byId.get(id)?.folder || id; }

function episodeConfigLocation(id) {
  const folder = episodeFolder(id);
  const encodedFolder = folder.split("/").map(encodeURIComponent).join("/");
  const episodeBaseUrl = new URL(`media/${encodedFolder}/`, documentBaseUrl).href;
  return { folder, episodeBaseUrl, configUrl: safeUrl("episode.json", episodeBaseUrl) };
}

function waitForEpisodeConfig(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(createAbortError()); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

function requestEpisodeConfig(id) {
  if (episodeConfigCache.has(id)) return Promise.resolve(episodeConfigCache.get(id));
  if (episodeConfigRequests.has(id)) return episodeConfigRequests.get(id);
  const { folder, episodeBaseUrl, configUrl } = episodeConfigLocation(id);
  const request = (async () => {
    const response = await fetchWithRetry(configUrl, { cache: "default", credentials: "same-origin" });
    if (!response.ok) throw new Error(`Could not load episode configuration (HTTP ${response.status}).`);
    const raw = parseJson(await response.text(), `media/${folder}/episode.json`);
    const loadedEpisode = normalizeEpisode(raw, { episodeBaseUrl, documentBaseUrl });
    const result = { episode: loadedEpisode, configUrl };
    episodeConfigCache.set(id, result);
    const record = library.byId.get(id);
    if (record) record.title = loadedEpisode.title;
    return result;
  })();
  episodeConfigRequests.set(id, request);
  void request.then(
    () => episodeConfigRequests.delete(id),
    () => episodeConfigRequests.delete(id),
  );
  return request;
}

async function loadLibraryTitles() {
  if (libraryTitlesPromise || library.episodes.length <= 1 || navigator.onLine === false) return libraryTitlesPromise;
  const records = library.episodes.filter((record) => !episodeConfigCache.has(record.id));
  if (!records.length) { populateLibrarySelect(); return null; }
  libraryTitlesPromise = (async () => {
    let cursor = 0;
    const worker = async () => {
      while (cursor < records.length) {
        const record = records[cursor]; cursor += 1;
        try { await requestEpisodeConfig(record.id); }
        catch (error) { if (error?.name !== "AbortError") reportError(`library title (${record.id})`, error); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, records.length) }, () => worker()));
    populateLibrarySelect();
  })();
  try { await libraryTitlesPromise; }
  finally { libraryTitlesPromise = null; }
  return null;
}

async function loadEpisode(id) {
  saveProgress(true);
  cancelSleep(true);
  episodeController?.abort();
  chapterController?.abort();
  chapterController = null;
  chapterLoadPromise = null;
  chapterLoadShouldNotify = false;
  chapterGeneration += 1;
  els.chaptersList.setAttribute("aria-busy", "false");
  cancelAvailabilityWork();
  if (trackObjectUrl) { URL.revokeObjectURL(trackObjectUrl); trackObjectUrl = ""; }
  els.chaptersTrack.removeAttribute("src");
  episodeController = new AbortController();
  const generation = ++episodeGeneration;
  setLoading(true);
  setBusy(true);
  clearCover();
  episodeConfigUrl = "";
  setText(els.episodeTitle, t("audio"));
  setMeta(t("loading"));

  try {
    const loaded = await waitForEpisodeConfig(requestEpisodeConfig(id), episodeController.signal);
    const loadedEpisode = loaded.episode;
    if (generation !== episodeGeneration) return;

    episode = loadedEpisode;
    episodeId = id;
    episodeConfigUrl = loaded.configUrl;
    sourcesByLanguage = new Map(Object.values(episode.languages).map((language) => [language.code, buildSources(language, els.audio)]));
    if (new URL(location.href).searchParams.get("clearAvailCache") === "1") storage.clearAvailability(episode.id, episode.cacheVersion);
    applyCachedAvailability();
    const prefs = storage.readEpisode(episodeId);
    const codes = Object.keys(episode.languages);
    const downloaded = navigator.onLine === false && offline.active?.episodeId === id
      && String(offline.active.cacheVersion) === String(episode.cacheVersion) ? offline.active : null;
    languageCode = downloaded && codes.includes(downloaded.languageCode)
      ? downloaded.languageCode
      : codes.includes(prefs.language) ? prefs.language : guessLanguage(codes, episode.defaultLanguage);
    const languageSources = sourcesByLanguage.get(languageCode);
    let selected = downloaded
      ? languageSources.find((source) => source.id === downloaded.sourceId && source.url === downloaded.sourceUrl)
      : null;
    if (!selected) selected = languageSources.find((source) => source.id === prefs.quality && source.availability !== "missing") || chooseDefaultSource(languageSources);
    if (!selected) throw new Error("No configured audio source can be selected for this browser.");
    selectedSourceId = selected.id;
    currentSource = selected;
    durationUnlocked = false;
    cues = [];
    activeCueIndex = -1;
    chaptersLoaded = false;
    chaptersFailed = false;
    chapterLoadPromise = null;
    chapterLoadShouldNotify = false;
    scannedAvailabilityLanguages = new Set();
    const selectedLanguage = episode.languages[languageCode];
    chapterMode = selectedLanguage.chapterSource || (selectedLanguage.chapters ? "vtt" : "none");
    chapterUrl = resolveLanguageAsset(selectedLanguage, selectedLanguage.chapters);
    chapterSourceKey = getChapterSourceKey(selected);
    media.setSelection(playbackSources(languageSources, selected), selected.id, storage.getProgress(episodeId, languageCode), false);
    media.setPlaybackRate(uiPrefs.playbackRate);
    media.setVolume(uiPrefs.volume);
    populateLibrarySelect();
    populateLanguageSelect();
    populateQualitySelect();
    updateTitle();
    updateMeta();
    const chaptersReady = ensureChapters({ notifyFailure: false, showLoading: false });
    applyCover();
    updateChapterButtons();
    storage.setLastEpisode(id);
    setEpisodeUrl(id);
    renderOfflineUi();
    void chaptersReady.finally(() => requestAvailabilityScan(generation, languageCode));
  } finally {
    if (generation === episodeGeneration) { setLoading(false); setBusy(false); renderOfflineUi(); }
  }
}

function setEpisodeUrl(id) {
  try { const url = new URL(location.href); url.searchParams.set("episode", id); history.replaceState(null, "", url); } catch {}
}

function resetChapters() {
  chapterController?.abort();
  chapterController = null;
  chapterLoadPromise = null;
  chapterLoadShouldNotify = false;
  chapterGeneration += 1;
  els.chaptersList.setAttribute("aria-busy", "false");
  cues = [];
  activeCueIndex = -1;
  chaptersLoaded = false;
  chaptersFailed = false;
  clearChildren(els.chaptersList);
  if (trackObjectUrl) { URL.revokeObjectURL(trackObjectUrl); trackObjectUrl = ""; }
  els.chaptersTrack.removeAttribute("src");
  const language = episode?.languages?.[languageCode];
  chapterMode = language?.chapterSource || (language?.chapters ? "vtt" : "none");
  chapterUrl = resolveLanguageAsset(language, language?.chapters);
  chapterSourceKey = getChapterSourceKey(currentSource);
  mediaMetadataChapter = "";
  updateMediaSessionMetadata();
  updateChapterButtons();
}

function getChapterSourceKey(source = currentSource) {
  if (chapterMode === "embedded") return `embedded:${source?.url || ""}`;
  if (chapterMode === "auto") return `auto:${chapterUrl}|${source?.url || ""}`;
  return chapterUrl;
}

function applyChapterData(text, loaded, kind = "vtt") {
  try {
    if (trackObjectUrl) URL.revokeObjectURL(trackObjectUrl);
    trackObjectUrl = "";
    els.chaptersTrack.removeAttribute("src");
    if (kind === "vtt" && text) {
      trackObjectUrl = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
      els.chaptersTrack.src = trackObjectUrl;
      els.chaptersTrack.track.mode = "hidden";
    }
  } catch (error) {
    reportError("native chapter track", error);
  }
  cues = loaded;
  chaptersLoaded = true;
  chaptersFailed = false;
  renderChapters();
  updateChapterButtons();
  markActiveChapter(media.position());
}

function ensureChapters({ force = false, notifyFailure = true, showLoading = !els.chaptersPanel.hidden } = {}) {
  if (chaptersLoaded && !chaptersFailed) return Promise.resolve(cues);
  if (chapterMode === "none" || (chapterMode === "vtt" && !chapterUrl)) { chaptersLoaded = true; chaptersFailed = false; renderChapters(); return Promise.resolve(cues); }
  if (chaptersFailed && !force) {
    if (showLoading) renderChapterFailure();
    return Promise.resolve(cues);
  }
  chapterLoadShouldNotify ||= notifyFailure;
  if (chapterLoadPromise && !force) {
    if (showLoading) renderPanelMessage(t("loadingChapters"));
    return chapterLoadPromise;
  }
  const sourceKey = getChapterSourceKey(currentSource);
  chapterSourceKey = sourceKey;
  if (!force) {
    const cachedData = storage.readChapterData?.(episode.id, languageCode, episode.cacheVersion, sourceKey);
    if (cachedData) {
      const cached = cachedData.kind === "vtt" ? parseChapterText(cachedData.text) : cachedData;
      applyChapterData(cached.text || "", cached.cues, cachedData.kind);
      return Promise.resolve(cues);
    }
    if (["vtt", "auto"].includes(chapterMode)) {
      const cachedText = storage.readChapters(episode.id, languageCode, episode.cacheVersion, chapterUrl);
      if (cachedText) { const cached = parseChapterText(cachedText); applyChapterData(cached.text, cached.cues, "vtt"); return Promise.resolve(cues); }
    }
  }
  if (force) chapterController?.abort();
  cancelAvailabilityWork();
  const controller = new AbortController();
  chapterController = controller;
  const generation = ++chapterGeneration;
  const requestUrl = chapterUrl;
  chapterLoadShouldNotify = notifyFailure;
  els.chaptersList.setAttribute("aria-busy", "true");
  if (showLoading) renderPanelMessage(t("loadingChapters"));
  const promise = (async () => {
    try {
      const result = await loadChapters({ mode: chapterMode, vttUrl: requestUrl, sourceUrl: currentSource?.url, sourceMime: currentSource?.mime, signal: controller.signal });
      if (generation !== chapterGeneration || requestUrl !== chapterUrl || sourceKey !== getChapterSourceKey(currentSource)) return cues;
      storage.writeChapterData?.(episode.id, languageCode, episode.cacheVersion, sourceKey, result);
      if (result.kind === "vtt") storage.writeChapters(episode.id, languageCode, episode.cacheVersion, requestUrl, result.text);
      applyChapterData(result.text || "", result.cues, result.kind);
    } catch (error) {
      if (error?.name === "AbortError" || generation !== chapterGeneration) return cues;
      chaptersLoaded = false;
      chaptersFailed = true;
      reportError("chapter load", error);
      if (chapterLoadShouldNotify) showToast(t("chaptersLoadFailed"), "warning", 5000);
    } finally {
      if (generation === chapterGeneration) {
        chapterController = null;
        chapterLoadShouldNotify = false;
        els.chaptersList.setAttribute("aria-busy", "false");
      }
    }
    if (generation === chapterGeneration) {
      if (chaptersFailed) renderChapterFailure();
      else if (!chaptersLoaded) renderChapters();
      if (!chaptersLoaded) {
        updateChapterButtons();
        markActiveChapter(media.position());
      }
    }
    return cues;
  })();
  chapterLoadPromise = promise;
  void promise.then(
    () => { if (chapterLoadPromise === promise) chapterLoadPromise = null; },
    () => { if (chapterLoadPromise === promise) chapterLoadPromise = null; },
  );
  return promise;
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
    requestAvailabilityScan(episodeGeneration, languageCode);
    if (els.chaptersPanel.hidden) return;
    const focusTarget = chaptersFailed ? els.chaptersList.querySelector(".chapter-retry-button") : els.chaptersList.querySelector(".chapter-button");
    focusTarget?.focus();
  });
  container.append(message, retry);
  els.chaptersList.appendChild(container);
}

function renderChapters() {
  clearChildren(els.chaptersList);
  if (!cues.length) { renderPanelMessage(t("noChaptersFound")); return; }
  cues.forEach((cue, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chapter-button";
    button.dataset.index = String(index);
    button.setAttribute("aria-current", String(index === activeCueIndex));
    const title = document.createElement("span");
    title.className = "chapter-name";
    title.textContent = cue.title;
    const time = document.createElement("span");
    time.className = "chapter-time";
    time.textContent = formatTime(cue.start);
    button.append(title, time);
    button.addEventListener("click", () => {
      const target = media.seek(cue.start);
      storage.setProgress(episodeId, languageCode, target);
      closePanel(els.chaptersPanel, els.chaptersBtn, true);
    });
    els.chaptersList.appendChild(button);
  });
}

function chapterIndexAt(position) {
  let index = -1;
  for (let cursor = 0; cursor < cues.length; cursor += 1) {
    if (position + .05 >= cues[cursor].start) index = cursor;
    else break;
  }
  return index;
}

function markActiveChapter(position) {
  const index = chapterIndexAt(position);
  if (index === activeCueIndex) return;
  activeCueIndex = index;
  mediaMetadataChapter = cues[index]?.title || "";
  updateMeta();
  updateMediaSessionMetadata();
  for (const button of els.chaptersList.querySelectorAll(".chapter-button")) button.setAttribute("aria-current", String(Number(button.dataset.index) === index));
}

function updateChapterButtons() {
  const disabled = chapterMode === "none" || (chapterMode === "vtt" && !chapterUrl) || chaptersFailed || (chaptersLoaded && !cues.length);
  els.prevChapterBtn.disabled = disabled;
  els.nextChapterBtn.disabled = disabled;
}

function refreshEmbeddedChaptersForSource(source) {
  if (!episode || !["embedded", "auto"].includes(chapterMode)) return;
  const nextKey = getChapterSourceKey(source);
  if (nextKey === chapterSourceKey && (chaptersLoaded || chapterLoadPromise)) return;
  chapterController?.abort();
  chapterController = null;
  chapterLoadPromise = null;
  chapterLoadShouldNotify = false;
  chapterGeneration += 1;
  chapterSourceKey = nextKey;
  cues = [];
  activeCueIndex = -1;
  chaptersLoaded = false;
  chaptersFailed = false;
  clearChildren(els.chaptersList);
  if (trackObjectUrl) { URL.revokeObjectURL(trackObjectUrl); trackObjectUrl = ""; }
  els.chaptersTrack.removeAttribute("src");
  updateMeta();
  updateChapterButtons();
  void ensureChapters({ notifyFailure: false, showLoading: false });
}

async function previousChapter() {
  await ensureChapters();
  if (!cues.length) return;
  const position = media.position();
  const index = chapterIndexAt(position);
  const target = index < 0 ? 0 : position - cues[index].start > 3 ? index : Math.max(0, index - 1);
  media.seek(cues[target].start);
}

async function nextChapter() {
  await ensureChapters();
  const next = cues.find((cue) => cue.start > media.position() + .05);
  if (next) media.seek(next.start);
}

function updateTime(position, mediaDuration) {
  const duration = durationUnlocked ? (mediaDuration || episode?.duration || 0) : 0;
  if (!seekDragging) els.seek.value = duration ? String(Math.round(clamp(position / duration, 0, 1) * 1000)) : "0";
  els.seek.disabled = !duration;
  els.seek.setAttribute("aria-valuetext", duration ? `${formatTime(position)} of ${formatTime(duration)}` : formatTime(position));
  setText(els.timeCur, formatTime(position));
  setText(els.timeDur, duration ? formatTime(duration) : UNKNOWN_TIME);
  markActiveChapter(position);
  updateMediaSessionPosition(position, duration);
  scheduleProgress();
  if (sleepState.mode === "chapter" && Number.isFinite(sleepState.chapterEnd) && position >= sleepState.chapterEnd - .05) void completeSleep("sleepEndChapterReached");
}

function updatePlaybackUi(state) {
  const playing = state === "playing" || (state === "stalled" && media.hasStarted);
  const label = playing ? t("pause") : t("play");
  setText(els.playPauseIcon, playing ? "Ⅱ" : "▶");
  els.playPauseBtn.setAttribute("aria-label", label);
  setTooltip(els.playPauseBtn, label);
  els.playPauseBtn.setAttribute("aria-busy", String(state === "loading" || state === "stalled"));
  if ("mediaSession" in navigator) {
    try { navigator.mediaSession.playbackState = playing ? "playing" : state === "idle" ? "none" : "paused"; }
    catch (error) { reportError("Media Session playback state", error); }
  }
  if (stallNoticeTimer) clearTimeout(stallNoticeTimer);
  stallNoticeTimer = null;
  if (state === "stalled" && navigator.onLine) {
    stallNoticeTimer = setTimeout(() => {
      stallNoticeTimer = null;
      if (media.state === "stalled" && media.playbackIntent && navigator.onLine) {
        showToast(t("audioStalled"), "warning", 5000, "audio-stalled");
      }
    }, STALL_NOTICE_DELAY_MS);
  }
}

const media = new MediaController(els.audio, {
  onState: updatePlaybackUi,
  onTime: updateTime,
  onSourceChange: (source) => {
    currentSource = source;
    selectedSourceId = source.id;
    populateQualitySelect(source);
    updateMeta();
    renderOfflineUi();
    refreshEmbeddedChaptersForSource(source);
  },
  onSourceSuccess: (source) => {
    if (!source) return;
    source.availability = "available";
    persistAvailability();
  },
  onSourceFailure: (source, error) => reportError(`source failure (${source?.id || "unknown"})`, error),
  onFallback: (_failed, next) => {
    selectedSourceId = next.id;
    storage.writeEpisode(episodeId, { ...storage.readEpisode(episodeId), language: languageCode, quality: next.id });
    showToast(t("audioFallbackCompatible"), "warning", 5000, `fallback:${next.id}`);
  },
  onBlocked: () => showToast(t("playBlocked"), "warning", 7000, "play-blocked"),
  onOffline: () => {
    const selection = currentOfflineSelection();
    if (!selection || !manifestMatchesSelection(offline.active, selection)) showToast(t("offlineWaiting"), "warning", 7000, "offline-waiting");
  },
  onExhausted: (error) => {
    setMeta(t("sourceExhausted"), true);
    reportError("all audio sources failed", error, t("sourceExhausted"));
  },
  onEnded: () => { if (sleepState.mode === "chapter") void completeSleep("sleepEndChapterReached", false); },
});

function scheduleProgress() {
  if (!episode) return;
  const elapsed = Date.now() - lastProgressWrite;
  if (elapsed >= 5000) saveProgress();
  else if (!progressTimer) progressTimer = setTimeout(() => { progressTimer = null; saveProgress(); }, 5000 - elapsed);
}

function saveProgress(force = false) {
  if (!episode || resetInProgress) return;
  if (!force && Date.now() - lastProgressWrite < 4900) return;
  lastProgressWrite = Date.now();
  storage.setProgress(episodeId, languageCode, media.position());
  const prefs = storage.readEpisode(episodeId);
  storage.writeEpisode(episodeId, { ...prefs, language: languageCode, quality: selectedSourceId });
}

function setAppearance() {
  if (uiPrefs.theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = uiPrefs.theme;
  if (uiPrefs.fontSize === "m") document.documentElement.removeAttribute("data-font");
  else document.documentElement.dataset.font = uiPrefs.fontSize;
  els.themeSelect.value = uiPrefs.theme;
  els.fontSizeSelect.value = uiPrefs.fontSize;
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
  const value = [5, 10, 15, 30, 60].includes(Number(seconds)) ? Number(seconds) : 15;
  uiPrefs.skipSeconds = value;
  els.skipSelect.value = String(value);
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
  const labelKeys = { episodeSelect: "bookLabel", langSelect: "languageLabel", qualitySelect: "qualityLabel", volumeRange: "volumeLabel", speedRange: "playbackSpeedLabel", skipSelect: "skipIntervalLabel", themeSelect: "appearanceModeLabel", fontSizeSelect: "fontSizeLabel", uiLangSelect: "uiLanguageLabel" };
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
  setText(els.resetOk, t("resetOk"));
  setTooltip(els.resetOk, t("resetOk"));
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
  if (episode) {
    populateLibrarySelect();
    populateQualitySelect(currentSource);
    updateMeta();
    if (chaptersFailed) renderChapterFailure();
    else if (chapterLoadPromise && !els.chaptersPanel.hidden) renderPanelMessage(t("loadingChapters"));
    else if (chaptersLoaded) renderChapters();
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
  for (const paragraphText of t("resetBody").split(/\n\s*\n/)) {
    const paragraph = document.createElement("p");
    paragraph.textContent = paragraphText;
    els.resetBody.appendChild(paragraph);
  }
}

function renderOnboarding(uiValue = uiPrefs.uiLanguage, audioValue = languageCode) {
  const previewLocale = resolveUiLocale(uiValue);
  const ot = (key, variables = {}) => translateAt(previewLocale, key, variables);
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
  uiRow.append(uiLabel, onboardingUiSelect);
  const audioRow = document.createElement("div"); audioRow.className = "onboard-row";
  const audioLabel = document.createElement("label"); audioLabel.htmlFor = "onboardingAudioLanguage"; audioLabel.textContent = ot("languageLabel");
  onboardingAudioSelect = document.createElement("select"); onboardingAudioSelect.id = "onboardingAudioLanguage";
  optionsFrom(onboardingAudioSelect, Object.values(episode.languages).map((language) => ({ value: language.code, label: language.label })), audioValue, (item) => item.label);
  audioRow.append(audioLabel, onboardingAudioSelect);
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
    const selected = record.mode === sleepState.mode && (record.mode !== "minutes" || record.minutes === sleepState.minutes);
    button.setAttribute("aria-pressed", String(selected));
    button.addEventListener("click", async () => {
      if (record.mode === "minutes") startSleepMinutes(record.minutes);
      else if (record.mode === "chapter") await startSleepChapter();
      else cancelSleep();
      closePanel(els.sleepPanel, els.sleepBtn, true);
    });
    els.sleepList.appendChild(button);
  }
  updateSleepButton();
}

function clearSleepTimers() {
  if (sleepState.timeout) clearTimeout(sleepState.timeout);
  if (sleepState.ticker) clearInterval(sleepState.ticker);
  sleepState.timeout = null;
  sleepState.ticker = null;
}

function cancelSleep(silent = false) {
  sleepGeneration += 1;
  const wasActive = sleepState.mode !== "off";
  clearSleepTimers();
  sleepState = { ...sleepState, mode: "off", minutes: 0, endAt: 0, chapterEnd: null };
  renderSleepOptions();
  if (wasActive && !silent) showToast(t("sleepTimerCanceled"));
}

function startSleepMinutes(minutes) {
  cancelSleep(true);
  sleepState.mode = "minutes";
  sleepState.minutes = minutes;
  sleepState.endAt = Date.now() + minutes * 60000;
  sleepState.timeout = setTimeout(() => void completeSleep("sleepTimerEnded"), minutes * 60000);
  sleepState.ticker = setInterval(updateSleepButton, 30000);
  renderSleepOptions();
  showToast(t("sleepTimerSet", { m: minutes }), "success");
}

async function startSleepChapter() {
  await ensureChapters();
  const index = chapterIndexAt(media.position());
  const cue = cues[index];
  const target = cue?.end && cue.end > media.position() ? cue.end : cues[index + 1]?.start || media.duration() || episode.duration;
  if (!target || target <= media.position()) { showToast(t("sleepEndChapterUnavailable"), "warning"); return; }
  cancelSleep(true);
  sleepState.mode = "chapter";
  sleepState.chapterEnd = target;
  renderSleepOptions();
  showToast(t("sleepEndChapterSet"), "success");
}

async function completeSleep(messageKey, fade = true) {
  if (sleepState.completing) return;
  sleepState.completing = true;
  const generation = sleepGeneration;
  clearSleepTimers();
  if (fade && supportsProgrammaticVolume()) {
    const original = uiPrefs.volume;
    for (let step = 7; step >= 0; step -= 1) {
      if (generation !== sleepGeneration) { media.setVolume(original); sleepState.completing = false; return; }
      media.setVolume(original * step / 8);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    media.requestPause();
    media.setVolume(original);
  } else media.requestPause();
  sleepState = { ...sleepState, mode: "off", minutes: 0, endAt: 0, chapterEnd: null, completing: false };
  renderSleepOptions();
  showToast(t(messageKey));
}

function updateSleepButton() {
  const active = sleepState.mode !== "off";
  els.sleepBtn.classList.toggle("is-active", active);
  let label = t("sleepTimer");
  if (sleepState.mode === "minutes") label += `: ${t("sleepTimerOption", { m: Math.max(1, Math.ceil((sleepState.endAt - Date.now()) / 60000)) })}`;
  else if (sleepState.mode === "chapter") label += `: ${t("sleepEndChapterOption")}`;
  els.sleepBtn.setAttribute("aria-label", label);
  setText(els.sleepBtn.querySelector(".sr-only"), label);
  setTooltip(els.sleepBtn, label);
}

async function changeLanguage(nextCode) {
  if (navigator.onLine === false) {
    els.langSelect.value = languageCode;
    showToast(t("offlineSelectionLocked"), "warning", 5000, "offline-selection");
    return;
  }
  if (!episode.languages[nextCode] || nextCode === languageCode) return;
  const position = media.position();
  saveProgress(true);
  cancelSleep(true);
  cancelAvailabilityWork();
  languageCode = nextCode;
  const all = sourcesByLanguage.get(languageCode);
  let selected = all.find((source) => source.id === selectedSourceId && source.availability !== "missing") || chooseDefaultSource(all);
  if (!selected) { showToast(t("sourceExhausted"), "error"); return; }
  selectedSourceId = selected.id;
  currentSource = selected;
  const shouldPlay = media.playbackIntent;
  populateLanguageSelect();
  populateQualitySelect(selected);
  resetChapters();
  updateTitle();
  updateMeta();
  applyCover();
  storage.setProgress(episodeId, languageCode, position);
  storage.writeEpisode(episodeId, { ...storage.readEpisode(episodeId), language: languageCode, quality: selected.id });
  await media.setSelection(playbackSources(all, selected), selected.id, position, shouldPlay);
  renderOfflineUi();
  void ensureChapters({ notifyFailure: false, showLoading: false }).finally(() => requestAvailabilityScan(episodeGeneration, languageCode));
}

async function changeQuality(nextId) {
  if (navigator.onLine === false) {
    els.qualitySelect.value = selectedSourceId;
    showToast(t("offlineSelectionLocked"), "warning", 5000, "offline-selection");
    return;
  }
  const all = sourcesByLanguage.get(languageCode) || [];
  const selected = all.find((source) => source.id === nextId);
  if (!selected || selected.id === selectedSourceId) return;
  const position = media.position();
  const shouldPlay = media.playbackIntent;
  selectedSourceId = selected.id;
  currentSource = selected;
  storage.writeEpisode(episodeId, { ...storage.readEpisode(episodeId), language: languageCode, quality: selected.id });
  updateMeta();
  await media.setSelection(playbackSources(all, selected), selected.id, position, shouldPlay);
  renderOfflineUi();
  refreshEmbeddedChaptersForSource(selected);
}

function updateMediaSessionMetadata() {
  if (!("mediaSession" in navigator) || typeof MediaMetadata !== "function") return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: mediaMetadataChapter || mediaMetadataTitle || t("audio"),
      album: mediaMetadataChapter ? mediaMetadataTitle : "",
      artwork: els.coverImg.src ? [{ src: els.coverImg.src }] : [],
    });
  } catch (error) { reportError("Media Session metadata", error); }
}

function updateMediaSessionPosition(position, duration) {
  if (!("mediaSession" in navigator) || typeof navigator.mediaSession.setPositionState !== "function" || !duration) return;
  try { navigator.mediaSession.setPositionState({ duration, position: clamp(position, 0, duration), playbackRate: media.playbackRate }); }
  catch (error) { reportError("Media Session position", error); }
}

function initializeMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const handlers = {
    play: () => { durationUnlocked = true; void media.requestPlay(); },
    pause: () => media.requestPause(),
    seekbackward: (details) => media.seek(media.position() - (details.seekOffset || uiPrefs.skipSeconds)),
    seekforward: (details) => media.seek(media.position() + (details.seekOffset || uiPrefs.skipSeconds)),
    seekto: (details) => Number.isFinite(details.seekTime) && media.seek(details.seekTime),
    previoustrack: () => void previousChapter(),
    nexttrack: () => void nextChapter(),
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, handler); }
    catch (error) { reportError(`Media Session ${action}`, error); }
  }
}

function closeAllPanels(except = null, restore = false) {
  if (except !== els.chaptersPanel) closePanel(els.chaptersPanel, els.chaptersBtn, restore && document.activeElement && els.chaptersPanel.contains(document.activeElement));
  if (except !== els.sleepPanel) closePanel(els.sleepPanel, els.sleepBtn, restore && document.activeElement && els.sleepPanel.contains(document.activeElement));
  if (except !== els.optionsPanel) closePanel(els.optionsPanel, els.optionsBtn, restore && document.activeElement && els.optionsPanel.contains(document.activeElement));
}

els.playPauseBtn.addEventListener("click", () => {
  durationUnlocked = true;
  if (media.state === "playing" || (media.state === "stalled" && media.hasStarted)) media.requestPause();
  else if (!media.playbackIntent) void media.requestPlay();
  updateTime(media.position(), media.duration());
});
els.skipBackBtn.addEventListener("click", () => media.seek(media.position() - uiPrefs.skipSeconds));
els.skipForwardBtn.addEventListener("click", () => media.seek(media.position() + uiPrefs.skipSeconds));
els.prevChapterBtn.addEventListener("click", () => void previousChapter());
els.nextChapterBtn.addEventListener("click", () => void nextChapter());
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
  openPanel(els.optionsPanel, els.optionsBtn, els.episodeRow.hidden ? els.langSelect : els.episodeSelect);
  void loadLibraryTitles();
  requestAvailabilityScan(episodeGeneration, languageCode, true);
});
els.closeChaptersBtn.addEventListener("click", () => closePanel(els.chaptersPanel, els.chaptersBtn, true));
els.closeSleepBtn.addEventListener("click", () => closePanel(els.sleepPanel, els.sleepBtn, true));
els.episodeSelect.addEventListener("change", async () => {
  if (navigator.onLine === false) {
    els.episodeSelect.value = episodeId;
    showToast(t("offlineSelectionLocked"), "warning", 5000, "offline-selection");
    return;
  }
  const previous = episodeId;
  try { media.requestPause(); await loadEpisode(els.episodeSelect.value); }
  catch (error) { reportError("episode change", error, t("errorLoading")); await loadEpisode(previous); }
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
els.offlineCancelBtn.addEventListener("click", async () => {
  els.offlineCancelBtn.disabled = true;
  try { await offline.cancel(); }
  finally { els.offlineCancelBtn.disabled = false; renderOfflineUi(); }
});
els.offlineRemoveBtn.addEventListener("click", async () => {
  if (!offline.active || !confirm(t("offlineRemoveConfirm", { book: offline.active.episodeTitle || offline.active.episodeId }))) return;
  els.offlineRemoveBtn.disabled = true;
  try {
    await offline.removeActive();
    showToast(t("offlineRemoved"), "success", 4000, "offline-removed");
  } catch (error) { reportError("remove offline download", error, t("offlineDownloadFailed")); }
  finally { els.offlineRemoveBtn.disabled = false; renderOfflineUi(); }
});

els.seek.addEventListener("input", () => {
  seekDragging = true;
  const duration = media.duration() || episode?.duration || 0;
  setText(els.timeCur, formatTime(duration * Number(els.seek.value) / 1000));
});
els.seek.addEventListener("change", () => {
  const duration = media.duration() || episode?.duration || 0;
  media.seek(duration * Number(els.seek.value) / 1000);
  seekDragging = false;
  saveProgress(true);
});

els.coverButton.addEventListener("click", () => {
  els.coverDialogImg.src = els.coverImg.currentSrc || els.coverImg.src;
  els.coverDialogImg.alt = els.coverImg.alt;
  openDialog(els.coverDialog, els.closeCoverBtn);
});
bindDialogDismiss(els.coverDialog, els.closeCoverBtn, () => { els.coverDialogImg.removeAttribute("src"); });
bindDialogDismiss(els.onboardingDialog, els.onboardingCloseX, () => storage.markOnboardingSeen());
bindDialogDismiss(els.resetDialog, els.resetCloseX);
els.onboardingOk.addEventListener("click", acceptOnboarding);
els.resetBtn.addEventListener("click", () => openDialog(els.resetDialog, els.resetOk));
els.resetCancel.addEventListener("click", () => closeDialog(els.resetDialog));
els.resetOk.addEventListener("click", async () => {
  if (resetInProgress) return;
  resetInProgress = true;
  els.resetOk.disabled = true;
  setText(els.resetOk, t("resetting"));
  if (progressTimer) clearTimeout(progressTimer);
  progressTimer = null;
  media.destroy();
  storage.reset();
  try { await offline.reset(); }
  catch (error) { reportError("offline reset", error); }
  location.reload();
});

document.addEventListener("click", (event) => { if (!els.player.contains(event.target)) closeAllPanels(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { closeAllPanels(null, true); return; }
  if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest("button, input, select, textarea, a, dialog")) return;
  if (event.code === "Space") {
    event.preventDefault();
    durationUnlocked = true;
    if (media.state === "playing" || (media.state === "stalled" && media.hasStarted)) media.requestPause();
    else if (!media.playbackIntent) void media.requestPlay();
  }
  else if (event.code === "ArrowLeft") { event.preventDefault(); media.seek(media.position() - 5); }
  else if (event.code === "ArrowRight") { event.preventDefault(); media.seek(media.position() + 5); }
  else if (event.code === "ArrowUp") { event.preventDefault(); media.seek(media.position() + uiPrefs.skipSeconds); }
  else if (event.code === "ArrowDown") { event.preventDefault(); media.seek(media.position() - uiPrefs.skipSeconds); }
});
window.addEventListener("pagehide", () => saveProgress(true), { capture: true });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveProgress(true); });
window.addEventListener("offline", () => {
  cancelAvailabilityWork();
  offlinePlaybackIntent = media.playbackIntent;
  showToast(t("connectionLost"), "warning", 7000, "offline");
  renderOfflineUi();
});
window.addEventListener("online", () => {
  showToast(t("connectionRestored"), "success", 4000, "online");
  if (chaptersFailed && chapterUrl) void ensureChapters({ force: true, notifyFailure: false, showLoading: !els.chaptersPanel.hidden });
  scannedAvailabilityLanguages.delete(languageCode);
  requestAvailabilityScan(episodeGeneration, languageCode);
  if (offlinePlaybackIntent) { offlinePlaybackIntent = false; void media.requestPlay(); }
  renderOfflineUi();
});

async function boot() {
  setLoading(true);
  applyUiPreferences();
  applyStrings();
  initializeMediaSession();
  const offlineReady = offline.init();
  if (navigator.onLine === false) await offlineReady;
  const bootController = new AbortController();
  library = await loadLibrary(bootController.signal);
  const rawQueryId = new URL(location.href).searchParams.get("episode") || "";
  const queryId = library.byId.has(rawQueryId) || (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rawQueryId) && rawQueryId !== "..") ? rawQueryId : "";
  const savedId = storage.getLastEpisode();
  const downloadedId = navigator.onLine === false ? offline.active?.episodeId || "" : "";
  const initialId = downloadedId || queryId || (library.byId.has(savedId) ? savedId : "") || library.defaultId || "episode-001";
  try {
    await loadEpisode(initialId);
    if (library.ui.onboardingEnabled && !storage.hasSeenOnboarding()) openOnboarding();
  } catch (error) {
    setLoading(false);
    setMeta(t("errorLoading"), true);
    reportError("startup", error, `${t("errorLoading")} ${error.message}`);
  }
}

void boot();
