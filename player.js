/* Compact Audio Player
 * - WebVTT chapters with dropdown
 * - Language + Quality selectors
 * - Codec preference: iOS17→AAC-first, iOS26+→Opus-first; non-iOS→Opus-first
 * - Volume + Playback speed sliders
 * - Configurable Focus Mode skip interval (5/10/15/30/60)
 * - Sleep timer (pause after X minutes)
 * - Optional cover image from episode.json (cover)
 * - Fix: switching language/quality no longer reloads episode.json (prevents stuck “Loading…”)
 * - JSON config validation: show file + line/col for syntax errors
 */

(() => {
  "use strict";

  // --- UI language (i18n) ----------------------------------------------------
  // Loaded from i18n.js (defer) into window.CAP_UI_STRINGS
  const UI_STRINGS = (window.CAP_UI_STRINGS && typeof window.CAP_UI_STRINGS === "object")
    ? window.CAP_UI_STRINGS
    : {
        en: {
          loading: "Loading…",
          audio: "Audio",
          playerAria: "Audio player",
          play: "Play",
          pause: "Pause",
          seek: "Seek",
          chapters: "Chapters",
          options: "Options",
          connectionRestored: "Connection restored.",
          connectionLost: "You are offline.",
          retryingRequest: "Retrying…",
          loadingChapters: "Loading chapters…",
          chaptersLoadFailed: "Could not load chapters.",
          close: "Close",
          closeChapters: "Close chapters",
          languageLabel: "Audio language",
          qualityLabel: "Quality",
          volumeLabel: "Volume",
          playbackSpeedLabel: "Playback speed",
          skipIntervalLabel: "Skip interval",
          focusMode: "Focus mode",
          skipBackAria: "Skip back {s} seconds",
          skipForwardAria: "Skip forward {s} seconds",
          timeLeftLessThanMinute: "Less than a minute left",
          timeLeftMinutes: "{m} minutes left",
          timeLeftHoursMinutes: "{h} hours, {m} minutes left",
          appearanceGroup: "Appearance",
          appearanceModeLabel: "Mode",
          themeSystem: "System",
          themeLight: "Light",
          themeDark: "Dark",
          fontSizeLabel: "Text size",
          fontSizeSmall: "Small",
          fontSizeMedium: "Medium",
          fontSizeLarge: "Large",
          bookLabel: "Audiobook",
          resetLink: "Reset player",
          resetTitle: "Reset player",
          resetBody: "This will clear your saved settings, playback position, and cached file availability for this episode on this device.\n\nSelect Reset to continue (the page will reload), or Cancel to keep everything as-is.",
          resetOk: "Reset",
          resetCancel: "Cancel",
          onboardTitle: "How this player works",
          onboardP1: "Quick tips:",
          onboardItemChapters: "Use ☰︎ to open chapters and jump to a chapter.",
          onboardItemExpand: "Use Skip back/Skip forward to jump, and Previous chapter/Next chapter to move between chapters.",
          onboardItemOptions: "Use ⚙︎ to change Audio language, Audio quality, Appearance and Player language.",
          onboardItemLang: "Use Audio language to choose the audio language and chapters.",
          onboardItemQuality: "Use Quality to choose audio quality bitrate.",
          onboardItemTheme: "Use Appearance to change the theme and text size.",
          onboardItemUiLang: "Use Player language to choose the player interface language.",
          onboardLangTitle: "Choose languages:",
          onboardOk: "Got it",
          errorTitle: "Player error",
          errorLoading: "Error loading episode.",
          audioLoadError: "Error: Could not load audio.",
        },
      };

  const normalizeLangTag = (tag) => {
    const raw = String(tag || "").trim().toLowerCase();
    if (!raw) return "";
    const base = raw.split(/[-_]/)[0];
    // Common non-standard tags seen in the wild
    const map = { no: "nb", nn: "nb", dk: "da"};
    return map[base] || base;
  };

  function detectBrowserUiLocale() {
    const candidates = [];
    try {
      const intlLocale = (Intl && Intl.DateTimeFormat) ? (Intl.DateTimeFormat().resolvedOptions().locale || "") : "";
      if (intlLocale) candidates.push(intlLocale);
    } catch (_) {}

    try {
      const nav = (navigator.languages && navigator.languages.length) ? navigator.languages : [];
      for (const v of nav) candidates.push(v);
    } catch (_) {}

    try {
      if (navigator.language) candidates.push(navigator.language);
    } catch (_) {}

    for (const raw of candidates) {
      const b = normalizeLangTag(raw);
      if (b && UI_STRINGS[b]) return b;
    }
    return "en";
  }

  function detectUiLocale() {
    // 0) User override (stored in compactPlayer:ui.uiLang)
    try {
      const raw = localStorage.getItem("compactPlayer:ui");
      if (raw) {
        const obj = JSON.parse(raw);
        const pref = normalizeLangTag(obj && obj.uiLang);
        if (pref === "auto") return detectBrowserUiLocale();
        if (pref && UI_STRINGS[pref]) return pref;
      }
    } catch (_) {}

    // Default UI language: English (unless user explicitly selects another language or Auto).
    return "en";
  }

  function detectPreferredEpisodeLang(availableLangs, fallbackLang) {
    const nav = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || ""];
    for (const raw of nav) {
      const base = normalizeLangTag(raw);
      if (availableLangs.includes(base)) return base;
    }
    return fallbackLang;
  }

  let UI_LOCALE = detectUiLocale();

  function fmt(str, vars = {}) {
    let out = String(str || "");
    for (const k of Object.keys(vars || {})) {
      out = out.replaceAll(`{${k}}`, String(vars[k]));
    }
    return out;
  }

  function t(key) {
    const dict = UI_STRINGS[UI_LOCALE] || UI_STRINGS.en || {};
    return (key in dict) ? dict[key] : ((UI_STRINGS.en && UI_STRINGS.en[key]) || key);
  }

  // Onboarding/help modal can preview a different UI language without committing the setting.
  let ONBOARD_LOCALE = null;
  function tOnboard(key) {
    const locale = ONBOARD_LOCALE || UI_LOCALE;
    const dict = UI_STRINGS[locale] || UI_STRINGS.en || {};
    return (key in dict) ? dict[key] : ((UI_STRINGS.en && UI_STRINGS.en[key]) || key);
  }


  function setTooltip(el, text) {
    if (!el) return;
    const s = (text == null) ? "" : String(text);
    if (!s) {
      try { el.removeAttribute("data-tooltip"); } catch {}
      try { el.removeAttribute("title"); } catch {}
      return;
    }
    try { el.setAttribute("title", s); } catch {}
    try { el.dataset.tooltip = s; } catch {}
  }

  // ---------------------------------------------------------------------------

  const els = {
    playerCard: document.querySelector(".playerCard"),
    title: document.getElementById("episodeTitle"),
    meta: document.getElementById("episodeMeta"),
    coverWrap: document.getElementById("coverWrap"),
    coverImg: document.getElementById("coverImg"),
    coverLightbox: document.getElementById("coverLightbox"),
    coverLightboxBox: document.getElementById("coverLightboxBox"),
    coverLightboxImg: document.getElementById("coverLightboxImg"),
    optionsBtn: document.getElementById("optionsBtn"),
    focusBtn: document.getElementById("focusBtn"),
    focusRow: document.getElementById("focusRow"),
    focusCloseBtn: document.getElementById("focusCloseBtn"),
    focusSkipBack: document.getElementById("focusSkipBack"),
    focusSkipForward: document.getElementById("focusSkipForward"),
    sleepBtn: document.getElementById("sleepBtn"),
    sleepMenu: document.getElementById("sleepMenu"),
    sleepList: document.getElementById("sleepList"),
    closeSleepBtn: document.getElementById("closeSleepBtn"),
    focusChaptersBtn: document.getElementById("focusChaptersBtn"),
    focusPrevChapterBtn: document.getElementById("focusPrevChapterBtn"),
    focusNextChapterBtn: document.getElementById("focusNextChapterBtn"),
    focusOptionsBtn: document.getElementById("focusOptionsBtn"),
    optionsPanel: document.getElementById("optionsPanel"),
    onboardingModal: document.getElementById("onboardingModal"),
    onboardingTitle: document.getElementById("onboardingTitle"),
    onboardingBody: document.getElementById("onboardingBody"),
    onboardingOk: document.getElementById("onboardingOk"),
    resetBtn: document.getElementById("resetBtn"),
    resetModal: document.getElementById("resetModal"),
    resetTitle: document.getElementById("resetTitle"),
    resetBody: document.getElementById("resetBody"),
    resetCloseX: document.getElementById("resetCloseX"),
    resetCancel: document.getElementById("resetCancel"),
    resetOk: document.getElementById("resetOk"),
    onboardingCloseX: document.getElementById("onboardingCloseX"),
    chaptersBtn: document.getElementById("chaptersBtn"),
    closeChaptersBtn: document.getElementById("closeChaptersBtn"),
    chaptersMenu: document.getElementById("chaptersMenu"),
    chaptersList: document.getElementById("chaptersList"),
    episodeSelect: document.getElementById("episodeSelect"),
    episodeRow: document.getElementById("episodeRow"),
    langSelect: document.getElementById("langSelect"),
    qualitySelect: document.getElementById("qualitySelect"),
    volumeRow: document.getElementById("volumeRow"),
    volumeRange: document.getElementById("volumeRange"),
    volumeValue: document.getElementById("volumeValue"),
    speedRange: document.getElementById("speedRange"),
    speedValue: document.getElementById("speedValue"),
    themeSelect: document.getElementById("themeSelect"),
    fontSizeSelect: document.getElementById("fontSizeSelect"),
    uiLangSelect: document.getElementById("uiLangSelect"),
    skipSelect: document.getElementById("skipSelect"),
    appearanceGroupLabel: document.getElementById("appearanceGroupLabel"),
    playPauseBtn: document.getElementById("playPauseBtn"),
    seek: document.getElementById("seek"),
    timeCur: document.getElementById("timeCur"),
    timeDur: document.getElementById("timeDur"),
    audio: document.getElementById("audio"),
    chaptersTrack: document.getElementById("chaptersTrack"),
    toastHost: document.getElementById("toastHost"),
    statusAnnouncer: document.getElementById("statusAnnouncer"),
  };

  
// --- Config + utilities ----------------------------------------------------
const CONFIG = {
  STORAGE_PREFIX: "compactPlayer",
  FETCH_RETRIES: 3,
  FETCH_RETRY_BASE_DELAY_MS: 1000,
  TOAST_DURATION_MS: 3000,
  SEEK_UPDATE_THROTTLE_MS: 100,
  CHAPTER_MARK_THROTTLE_MS: 120,
  PROGRESS_SAVE_INTERVAL_MS: 5000,
  SLEEP_FADE_MS: 2200,
  SLEEP_TICK_INTERVAL_MS: 30000,
};

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Fetch with basic retry/backoff (network errors + 5xx/429 only).
 * Returns the final Response (even if !ok).
 */
async function fetchWithRetry(url, options = {}, retries = CONFIG.FETCH_RETRIES) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      const status = res.status || 0;
      if (res.ok) return res;
      // Retry transient errors only
      if (status >= 500 || status === 429) {
        if (i < retries - 1) {
          if (i === 0) { try { showToast(t("retryingRequest"), "warning", 1500); } catch {} }
          await sleep(CONFIG.FETCH_RETRY_BASE_DELAY_MS * (i + 1));
          continue;
        }
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i < retries - 1) {
        await sleep(CONFIG.FETCH_RETRY_BASE_DELAY_MS * (i + 1));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr || new Error("Fetch failed");
}

function throttle(fn, limitMs) {
  let last = 0;
  let timer = null;
  let lastArgs = null;
  return function throttled(...args) {
    const now = Date.now();
    const remaining = limitMs - (now - last);
    if (remaining <= 0) {
      last = now;
      if (timer) { window.clearTimeout(timer); timer = null; }
      fn.apply(this, args);
    } else {
      lastArgs = args;
      if (!timer) {
        timer = window.setTimeout(() => {
          timer = null;
          last = Date.now();
          const a = lastArgs;
          lastArgs = null;
          fn.apply(this, a);
        }, remaining);
      }
    }
  };
}

function ensureToastHost() {
  if (els.toastHost) return els.toastHost;
  const host = document.createElement("div");
  host.id = "toastHost";
  host.className = "toastHost";
  host.setAttribute("aria-live", "polite");
  host.setAttribute("aria-atomic", "true");
  document.body.appendChild(host);
  els.toastHost = host;
  return host;
}

function announce(message) {
  try {
    const el = els.statusAnnouncer || document.getElementById("statusAnnouncer");
    if (!el) return;
    el.textContent = String(message || "");
    window.setTimeout(() => { try { el.textContent = ""; } catch {} }, 1000);
  } catch {}
}

function showToast(message, type = "info", durationMs = CONFIG.TOAST_DURATION_MS) {
  const host = ensureToastHost();
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = String(message || "");
  host.appendChild(toast);

  // Animate in
  window.setTimeout(() => toast.classList.add("show"), 10);

  window.setTimeout(() => {
    toast.classList.remove("show");
    window.setTimeout(() => { try { toast.remove(); } catch {} }, 300);
  }, Math.max(1000, durationMs));

  announce(message);
}


// --- JSON config parsing with file + line/col diagnostics -----------------
function computeLineColFromIndex(text, index) {
  const safeIdx = Math.max(0, Math.min(Number(index) || 0, text.length));
  let line = 1;
  let lastNl = -1;
  for (let i = 0; i < safeIdx; i++) {
    if (text.charCodeAt(i) === 10) { // '\n'
      line++;
      lastNl = i;
    }
  }
  const col = (safeIdx - lastNl);
  return { line, col };
}

function extractJsonErrorLocation(err, text) {
  const msg = String((err && err.message) ? err.message : err);

  // Firefox / Safari style: "... at line X column Y ..."
  let m = msg.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  if (m) return { line: parseInt(m[1], 10), col: parseInt(m[2], 10) };

  // Chrome style: "... at position N"
  m = msg.match(/position\s+(\d+)/i);
  if (m) {
    const pos = parseInt(m[1], 10);
    if (isFinite(pos)) {
      const lc = computeLineColFromIndex(text || "", pos);
      return { line: lc.line, col: lc.col };
    }
  }

  // Some engines expose numeric properties
  const ln = (err && typeof err.lineNumber === "number") ? err.lineNumber : null;
  const cn = (err && typeof err.columnNumber === "number") ? err.columnNumber : null;
  if (ln != null) return { line: ln, col: cn };

  return { line: null, col: null };
}

function formatJsonSyntaxError(fileLabel, err, text) {
  const loc = extractJsonErrorLocation(err, text || "");
  const baseMsg = String((err && err.message) ? err.message : err);
  const where = (loc.line != null)
    ? ` (line ${loc.line}${loc.col != null ? `, col ${loc.col}` : ""})`
    : "";
  return `JSON syntax error in ${fileLabel}${where}: ${baseMsg}`;
}

function parseJsonTextOrThrow(text, fileLabel) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(formatJsonSyntaxError(fileLabel, err, text));
  }
}

function tryParseJsonText(text, fileLabel, onError) {
  try {
    return JSON.parse(text);
  } catch (err) {
    const msg = formatJsonSyntaxError(fileLabel, err, text);
    if (typeof onError === "function") onError(msg);
    return null;
  }
}

function approximateLineForKey(text, key) {
  try {
    const needle = `"${String(key || "").replace(/"/g, "")}"`;
    const idx = String(text || "").indexOf(needle);
    if (idx < 0) return null;
    return computeLineColFromIndex(String(text || ""), idx).line;
  } catch {
    return null;
  }
}

function validateEpisodeConfigOrThrow(cfg, rawText, fileLabel) {
  try {
    return validateEpisodeConfig(cfg);
  } catch (err) {
    const msg = String((err && err.message) ? err.message : err);
    let line = null;

    // If the message contains a list of missing keys, try to locate the first key.
    const m = msg.match(/missing\s+(.+)$/i);
    if (m && m[1] && rawText) {
      const keys = String(m[1]).split(",").map(s => s.trim()).filter(Boolean);
      for (const k of keys) {
        const ln = approximateLineForKey(rawText, k);
        if (ln != null) { line = ln; break; }
      }
    }

    const where = (line != null) ? ` (near line ${line})` : "";
    throw new Error(`${fileLabel}${where}: ${msg}`);
  }
}



function validateEpisodeConfig(cfg) {
  if (!cfg || typeof cfg !== "object") throw new Error("Invalid episode config: not an object");
  const missing = [];
  if (!cfg.id) missing.push("id");
  if (!cfg.defaultLanguage) missing.push("defaultLanguage");
  if (!cfg.languages || typeof cfg.languages !== "object") missing.push("languages");
  if (missing.length) throw new Error(`Invalid episode config: missing ${missing.join(", ")}`);
  return true;
}

// --- Media Session API (lock screen controls) ----------------------------
  const HAS_MEDIA_SESSION = ("mediaSession" in navigator) && navigator.mediaSession;
  let _mediaSessionInitialized = false;
  let _mediaEpisodeTitle = "";
  let _mediaChapterTitle = "";
  let _lastPositionStateMs = 0;

  function updateMediaSessionPlaybackState() {
    if (!HAS_MEDIA_SESSION) return;
    try {
      navigator.mediaSession.playbackState = els.audio && !els.audio.paused ? "playing" : "paused";
    } catch {}
  }

  function updateMediaSessionMetadata() {
    if (!HAS_MEDIA_SESSION || typeof window.MediaMetadata !== "function") return;

    const episodeTitle = (_mediaEpisodeTitle || (els.title && els.title.textContent) || t("audio") || "Audio").trim();
    const chapterTitle = String(_mediaChapterTitle || "").trim();
    const title = chapterTitle ? `${episodeTitle} — ${chapterTitle}` : episodeTitle;

    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title });
    } catch {}
  }

  function updateMediaSessionPositionState(force) {
    if (!HAS_MEDIA_SESSION) return;
    if (typeof navigator.mediaSession.setPositionState !== "function") return;

    const now = Date.now();
    if (!force && (now - _lastPositionStateMs) < 1000) return;
    _lastPositionStateMs = now;

    const dur = getKnownDuration();
    if (!dur || !isFinite(dur) || dur <= 0) return;

    const pos = (els.audio && isFinite(els.audio.currentTime)) ? els.audio.currentTime : 0;
    const rate = (els.audio && isFinite(els.audio.playbackRate)) ? els.audio.playbackRate : 1;

    try {
      navigator.mediaSession.setPositionState({
        duration: dur,
        position: clamp(pos, 0, dur),
        playbackRate: rate,
      });
    } catch {}
  }

  function setMediaEpisodeTitle(title) {
    _mediaEpisodeTitle = String(title || "");
    updateMediaSessionMetadata();
  }

  function setMediaChapterTitle(title) {
    const next = String(title || "");
    if (next === _mediaChapterTitle) return;
    _mediaChapterTitle = next;
    updateMediaSessionMetadata();
  }

  function mediaSeekBy(seconds) {
    const cur = (els.audio && isFinite(els.audio.currentTime)) ? els.audio.currentTime : 0;
    const next = cur + seconds;
    seekTo(next, { resumeIfPlaying: true, persist: true });
  }

  function jumpChapter(delta) {
    if (!cues.length) return;
    const idx = (activeCueIndex >= 0) ? activeCueIndex : 0;
    const nextIdx = clamp(idx + delta, 0, cues.length - 1);
    const cue = cues[nextIdx];
    if (!cue) return;
    seekTo(cue.start, { resumeIfPlaying: true, persist: true });
  }

  function initMediaSession() {
    if (!HAS_MEDIA_SESSION || _mediaSessionInitialized) return;
    _mediaSessionInitialized = true;

    const setHandler = (action, fn) => {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch {}
    };

    setHandler("play", () => {
      try { userWantsPlaying = true; } catch {}
      safePlay().catch(() => {});
    });

    setHandler("pause", () => {
      try { userWantsPlaying = false; } catch {}
      try { els.audio.pause(); } catch {}
    });

    setHandler("seekbackward", (details) => {
      const offset = (details && typeof details.seekOffset === "number") ? details.seekOffset : skipSeconds;
      mediaSeekBy(-Math.abs(offset));
    });

    setHandler("seekforward", (details) => {
      const offset = (details && typeof details.seekOffset === "number") ? details.seekOffset : skipSeconds;
      mediaSeekBy(Math.abs(offset));
    });

    setHandler("seekto", (details) => {
      if (!details || typeof details.seekTime !== "number") return;
      seekTo(details.seekTime, { resumeIfPlaying: true, persist: true });
    });

    // Map next/previous to chapter navigation when chapters exist
    setHandler("previoustrack", () => jumpChapter(-1));
    setHandler("nexttrack", () => jumpChapter(1));

    updateMediaSessionMetadata();
    updateMediaSessionPlaybackState();
  }
  // -------------------------------------------------------------------------


/** Platform helpers **/
const IS_IOS = (() => {
  const ua = navigator.userAgent || "";
  const iOS = /iPad|iPhone|iPod/.test(ua);
  const iPadOS13Plus = (navigator.platform === "MacIntel" && navigator.maxTouchPoints && navigator.maxTouchPoints > 1);
  return iOS || iPadOS13Plus;
})();


// iOS version detection for version-specific workarounds
const IOS_VERSION = (() => {
  if (!IS_IOS) return null;
  const ua = navigator.userAgent || "";
  const match = ua.match(/OS (\d+)[._]/);
  return match ? parseInt(match[1], 10) : null;
})();

// Centralized codec preference order.
// - iOS 17: prefer AAC (Opus-in-WebM can fail to load/decode)
// - iOS 26+: prefer Opus (better quality/size, and Safari support is expected to be stable)
// - other iOS versions: prefer AAC (safest default)
// - non-iOS: prefer Opus
const IOS_PREFERS_OPUS = !!(IS_IOS && IOS_VERSION != null && IOS_VERSION >= 26);

function preferredCodecOrder() {
  if (!IS_IOS) return ["opus", "aac", "mp3"];
  return IOS_PREFERS_OPUS ? ["opus", "aac", "mp3"] : ["aac", "mp3", "opus"];
}

function codecRankFromOrder(order) {
  const rank = {};
  const arr = Array.isArray(order) ? order : [];
  for (let i = 0; i < arr.length; i++) rank[arr[i]] = i;
  return rank;
}

// iOS Safari does not allow programmatic volume control for <audio>.
// Hide the Volume slider on iOS to avoid a non-functional UI control.
try {
  if (IS_IOS) {
    const row = els.volumeRow || (els.volumeRange && els.volumeRange.closest(".drawerRow"));
    if (row) row.hidden = true;
    if (els.volumeRange) els.volumeRange.disabled = true;
  }
} catch {}

let _uiLockCount = 0;
function setUiLocked(locked) {
  _uiLockCount += locked ? 1 : -1;
  if (_uiLockCount < 0) _uiLockCount = 0;
  const disabled = _uiLockCount > 0;

  try {
    if (els.episodeSelect) els.episodeSelect.disabled = disabled;
    if (els.langSelect) els.langSelect.disabled = disabled;
    if (els.qualitySelect) els.qualitySelect.disabled = disabled;
    if (els.themeSelect) els.themeSelect.disabled = disabled;
    if (els.fontSizeSelect) els.fontSizeSelect.disabled = disabled;
    if (els.uiLangSelect) els.uiLangSelect.disabled = disabled;
    if (els.chaptersBtn) els.chaptersBtn.disabled = disabled;
    if (els.optionsBtn) els.optionsBtn.disabled = disabled;
  } catch {}

  if (els.chaptersList) {
    els.chaptersList.setAttribute("aria-disabled", disabled ? "true" : "false");
  }

  document.documentElement.classList.toggle("uiLocked", disabled);
}

function lockUiFor(ms) {
  setUiLocked(true);
  window.setTimeout(() => setUiLocked(false), ms);
}

function clearChildren(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

function renderParagraphs(container, text) {
  if (!container) return;
  clearChildren(container);
  const raw = String(text || "");
  const parts = raw.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  for (const part of parts) {
    const pEl = document.createElement("p");
    pEl.textContent = part;
    container.appendChild(pEl);
  }
}

let _onboardUiLangSelect = null;
let _onboardAudioLangSelect = null;

function renderOnboardingBody(container, preset = null) {
  if (!container) return;
  clearChildren(container);

  // Reset references
  _onboardUiLangSelect = null;
  _onboardAudioLangSelect = null;

  const presetUiValue = (preset && typeof preset.uiValue === "string") ? preset.uiValue : null;
  const presetAudioValue = (preset && typeof preset.audioValue === "string") ? preset.audioValue : null;

  const p = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = tOnboard("onboardP1");
  p.appendChild(strong);
  container.appendChild(p);

  const ul1 = document.createElement("ul");
  const li1 = document.createElement("li");
  li1.textContent = tOnboard("onboardItemChapters");
  ul1.appendChild(li1);

  const liExpand = document.createElement("li");
  liExpand.textContent = tOnboard("onboardItemExpand");
  ul1.appendChild(liExpand);
  container.appendChild(ul1);

  const gap = document.createElement("div");
  gap.className = "onboardGap";
  container.appendChild(gap);

  const ul2 = document.createElement("ul");
  const li2 = document.createElement("li");
  li2.textContent = tOnboard("onboardItemOptions");

  const ulNested = document.createElement("ul");

  const liLang = document.createElement("li");
  liLang.textContent = tOnboard("onboardItemLang");

  const liQuality = document.createElement("li");
  liQuality.textContent = tOnboard("onboardItemQuality");

  const liUiLang = document.createElement("li");
  liUiLang.textContent = tOnboard("onboardItemUiLang");

  const liAppearance = document.createElement("li");
  liAppearance.textContent = tOnboard("onboardItemTheme");

  ulNested.appendChild(liLang);
  ulNested.appendChild(liQuality);
  ulNested.appendChild(liUiLang);
  ulNested.appendChild(liAppearance);

  li2.appendChild(ulNested);
  ul2.appendChild(li2);
  container.appendChild(ul2);

  // Language selectors (apply on "Got it")
  const controls = document.createElement("div");
  controls.className = "onboardControls";

  const title = document.createElement("p");
  const strong2 = document.createElement("strong");
  strong2.textContent = tOnboard("onboardLangTitle");
  title.appendChild(strong2);
  controls.appendChild(title);

  // Player language select
  const rowUi = document.createElement("div");
  rowUi.className = "onboardRow";
  const labUi = document.createElement("label");
  labUi.className = "label";
  labUi.textContent = tOnboard("uiLanguageLabel");
  const selUi = document.createElement("select");
  selUi.className = "select";
  // Build options locally so labels match the onboarding language preview.
  const uiValueRaw = (presetUiValue != null)
    ? presetUiValue
    : ((els && els.uiLangSelect && els.uiLangSelect.value) ? els.uiLangSelect.value : "en");
  const uiNorm = (uiValueRaw === "auto") ? "auto" : normalizeLangTag(uiValueRaw);

  selUi.innerHTML = "";

  const optAuto = document.createElement("option");
  optAuto.value = "auto";
  optAuto.textContent = tOnboard("uiLanguageAuto");
  selUi.appendChild(optAuto);

  for (const code of Object.keys(UI_STRINGS)) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = UI_LANG_NAMES[code] || code.toUpperCase();
    selUi.appendChild(opt);
  }

  selUi.value = (uiNorm === "auto" || (uiNorm && UI_STRINGS[uiNorm])) ? uiNorm : "en";
  rowUi.appendChild(labUi);
  rowUi.appendChild(selUi);
  controls.appendChild(rowUi);

  // Audio language select
  const rowAu = document.createElement("div");
  rowAu.className = "onboardRow";
  const labAu = document.createElement("label");
  labAu.className = "label";
  labAu.textContent = tOnboard("languageLabel");
  const selAu = document.createElement("select");
  selAu.className = "select";

  if (els && els.langSelect) {
    for (const opt of Array.from(els.langSelect.options || [])) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.textContent;
      selAu.appendChild(o);
    }
    const fallbackAu = els.langSelect.value || (els.langSelect.options[0] ? els.langSelect.options[0].value : "");
    const desiredAu = (presetAudioValue != null) ? presetAudioValue : fallbackAu;
    if (Array.from(selAu.options || []).some(o => o.value === desiredAu)) {
      selAu.value = desiredAu;
    } else {
      selAu.value = fallbackAu;
    }
  }

  rowAu.appendChild(labAu);
  rowAu.appendChild(selAu);
  controls.appendChild(rowAu);

  container.appendChild(controls);

  _onboardUiLangSelect = selUi;
  _onboardAudioLangSelect = selAu;

  // Live-preview onboarding/help text in the selected Player language.
  selUi.addEventListener("change", () => {
    const uiVal = selUi.value || "en";
    const auVal = selAu ? (selAu.value || "") : "";
    const preview = (uiVal === "auto") ? detectBrowserUiLocale() : normalizeLangTag(uiVal);
    ONBOARD_LOCALE = (preview && UI_STRINGS[preview]) ? preview : "en";
    renderOnboardingModal({ uiValue: uiVal, audioValue: auVal });
  });
}

function renderOnboardingModal(preset = null) {
  // Preserve ONBOARD_LOCALE if the user is previewing a language inside the modal.
  try { if (els.onboardingTitle) els.onboardingTitle.textContent = tOnboard("onboardTitle"); } catch {}
  try { if (els.onboardingBody) renderOnboardingBody(els.onboardingBody, preset); } catch {}
  try {
    if (els.onboardingOk) {
      const okLabel = tOnboard("onboardOk");
      els.onboardingOk.textContent = okLabel;
      setTooltip(els.onboardingOk, okLabel);
    }
  } catch {}
  if (els.onboardingCloseX) {
    try {
      const closeLabel = tOnboard("close");
      els.onboardingCloseX.setAttribute("aria-label", closeLabel);
      setTooltip(els.onboardingCloseX, closeLabel);
    } catch {}
  }
}


const UI_LANG_NAMES = {
  en: "English",
  da: "Dansk",
  nb: "Norsk (bokmål)",
  sv: "Svenska",
};

function isUiLangOverrideActive() {
  try {
    const ui = readUiPrefs();
    const v = normalizeLangTag(ui && ui.uiLang);
    return !!(v && v !== "auto" && UI_STRINGS[v]);
  } catch {
    return false;
  }
}

function populateUiLanguageSelect() {
  if (!els.uiLangSelect) return;

  // Default Player language: English (unless the user explicitly chooses Auto or another language)
  let pref = "en";
  try {
    const ui = readUiPrefs();
    pref = (ui && ui.uiLang) ? String(ui.uiLang) : "en";
  } catch {}

  const prefNorm = (pref === "auto") ? "auto" : normalizeLangTag(pref);

  const sel = els.uiLangSelect;
  sel.innerHTML = "";

  const optAuto = document.createElement("option");
  optAuto.value = "auto";
  optAuto.textContent = t("uiLanguageAuto");
  sel.appendChild(optAuto);

  for (const code of Object.keys(UI_STRINGS)) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = UI_LANG_NAMES[code] || code.toUpperCase();
    sel.appendChild(opt);
  }

  sel.value = (prefNorm && (prefNorm === "auto" || UI_STRINGS[prefNorm])) ? prefNorm : "en";
}

function refreshQualitySelectLabelsFromDom() {
  if (!els.qualitySelect) return;
  const opts = els.qualitySelect.options;
  for (let i = 0; i < opts.length; i++) {
    const opt = opts[i];
    const parts = String(opt.value || "").split("-");
    const codec = parts[0] || "";
    const br = parseInt(parts[1] || "", 10);
    if (!codec || !isFinite(br)) continue;
    // Quality selector labels should be human-readable without bitrate.
    opt.textContent = qualityDisplayLabel({ codec, bitrate: br }, { includeBitrate: false });
  }
}

function updateMetaLineAfterUiLangChange() {
  try {
    if (!config || !config.languages || !els.langSelect || !els.qualitySelect) return;
    const langCode = els.langSelect.value;
    const langCfg = config.languages[langCode];
    if (!langCfg) return;

    const parts = String(els.qualitySelect.value || "").split("-");
    const codec = parts[0] || "";
    const br = parseInt(parts[1] || "", 10);
    const qLabel = (codec && isFinite(br)) ? qualityDisplayLabel({ codec, bitrate: br }) : "";

    setMeta(metaWithQuality(langCfg.label || langCode, episodeId, qLabel));
  } catch {}
}

function applyUiStrings() {
  // Note: We intentionally do not mutate the page's <html lang>. The Player language selector
  // only affects strings inside the player UI.

  // Header defaults (title often replaced by episode.json later)
  if (els.meta && String(els.meta.textContent || "").trim() === "Loading…") {
    els.meta.textContent = t("loading");
  }
  if (els.title && String(els.title.textContent || "").trim() === "Audio") {
    els.title.textContent = t("audio");
  }

  const playerCard = document.querySelector(".playerCard");
  if (playerCard) playerCard.setAttribute("aria-label", t("playerAria"));

  if (els.playPauseBtn) els.playPauseBtn.setAttribute("aria-label", t("play"));
  if (els.seek) els.seek.setAttribute("aria-label", t("seek"));
  if (els.volumeRange) els.volumeRange.setAttribute("aria-label", t("volumeLabel"));
  if (els.speedRange) els.speedRange.setAttribute("aria-label", t("playbackSpeedLabel"));

  if (els.chaptersBtn) {
    const label = t("chapters");
    els.chaptersBtn.setAttribute("aria-label", label);
    setTooltip(els.chaptersBtn, label);
  }
  if (els.optionsBtn) {
    const label = t("options");
    els.optionsBtn.setAttribute("aria-label", label);
    setTooltip(els.optionsBtn, label);
  }
  if (els.focusBtn) {
    const label = (t("expandPlayer") || t("focusMode"));
    els.focusBtn.setAttribute("aria-label", label);
    setTooltip(els.focusBtn, label);
  }

  const langLabel = document.querySelector('label[for="langSelect"]');
  if (langLabel) langLabel.textContent = t("languageLabel");
  const episodeLabel = document.querySelector('label[for="episodeSelect"]');
  if (episodeLabel) episodeLabel.textContent = t("bookLabel");
  const qualityLabel = document.querySelector('label[for="qualitySelect"]');
  if (qualityLabel) qualityLabel.textContent = t("qualityLabel");

  const volumeLabel = document.querySelector('label[for="volumeRange"]');
  if (volumeLabel) volumeLabel.textContent = t("volumeLabel");
  if (els.volumeRange) els.volumeRange.setAttribute("aria-label", t("volumeLabel"));

  const speedLabel = document.querySelector('label[for="speedRange"]');
  if (speedLabel) speedLabel.textContent = t("playbackSpeedLabel");
  if (els.speedRange) els.speedRange.setAttribute("aria-label", t("playbackSpeedLabel"));

  const skipLabel = document.querySelector('label[for="skipSelect"]');
  if (skipLabel) skipLabel.textContent = t("skipIntervalLabel");
  const appearanceGroupLabel = document.getElementById("appearanceGroupLabel");
  if (appearanceGroupLabel) appearanceGroupLabel.textContent = t("appearanceGroup");
  const themeLabel = document.querySelector('label[for="themeSelect"]');
  if (themeLabel) themeLabel.textContent = t("appearanceModeLabel");
  const fontSizeLabel = document.querySelector('label[for="fontSizeSelect"]');
  if (fontSizeLabel) fontSizeLabel.textContent = t("fontSizeLabel");

  const uiLangLabel = document.querySelector('label[for="uiLangSelect"]');
  if (uiLangLabel) uiLangLabel.textContent = t("uiLanguageLabel");
  if (els.uiLangSelect) populateUiLanguageSelect();

  const themeSelect = document.getElementById("themeSelect");
  if (themeSelect) {
    const optSystem = themeSelect.querySelector('option[value="system"]');
    const optLight = themeSelect.querySelector('option[value="light"]');
    const optDark = themeSelect.querySelector('option[value="dark"]');
    if (optSystem) optSystem.textContent = t("themeSystem");
    if (optLight) optLight.textContent = t("themeLight");
    if (optDark) optDark.textContent = t("themeDark");
  }

  const fontSizeSelect = document.getElementById("fontSizeSelect");
  if (fontSizeSelect) {
    const optS = fontSizeSelect.querySelector('option[value="s"]');
    const optM = fontSizeSelect.querySelector('option[value="m"]');
    const optL = fontSizeSelect.querySelector('option[value="l"]');
    if (optS) optS.textContent = t("fontSizeSmall");
    if (optM) optM.textContent = t("fontSizeMedium");
    if (optL) optL.textContent = t("fontSizeLarge");
  }

  if (els.focusChaptersBtn) {
    const label = t("chapters");
    els.focusChaptersBtn.setAttribute("aria-label", label);
    setTooltip(els.focusChaptersBtn, label);
  }

  if (els.focusPrevChapterBtn) {
    const label = t("prevChapter");
    els.focusPrevChapterBtn.setAttribute("aria-label", label);
    setTooltip(els.focusPrevChapterBtn, label);
  }
  if (els.focusNextChapterBtn) {
    const label = t("nextChapter");
    els.focusNextChapterBtn.setAttribute("aria-label", label);
    setTooltip(els.focusNextChapterBtn, label);
  }
  if (els.focusOptionsBtn) {
    const label = t("options");
    els.focusOptionsBtn.setAttribute("aria-label", label);
    setTooltip(els.focusOptionsBtn, label);
  }
  if (els.focusCloseBtn) {
    const label = (t("collapsePlayer") || t("close"));
    els.focusCloseBtn.setAttribute("aria-label", label);
    setTooltip(els.focusCloseBtn, label);
  }

  if (els.sleepBtn) {
    const label = t("sleepTimer");
    els.sleepBtn.setAttribute("aria-label", label);
    // Tooltip + remaining time is managed by updateSleepUi()
  }
  const sleepMenu = document.getElementById("sleepMenu");
  if (sleepMenu) sleepMenu.setAttribute("aria-label", t("sleepTimer"));
  const sleepTitle = document.getElementById("sleepMenuTitle");
  if (sleepTitle) sleepTitle.textContent = t("sleepTimer");
  if (els.closeSleepBtn) {
    const label = t("close");
    els.closeSleepBtn.setAttribute("aria-label", label);
    setTooltip(els.closeSleepBtn, label);
  }
  try { ensureSleepMenuBuilt(); } catch {}
  try { updateSleepUi(); } catch {}

  const chaptersMenu = document.getElementById("chaptersMenu");
  if (chaptersMenu) chaptersMenu.setAttribute("aria-label", t("chapters"));
  const chaptersTitle = document.querySelector("#chaptersMenu .menuTitle");
  if (chaptersTitle) chaptersTitle.textContent = t("chapters");
  const closeBtn = document.getElementById("closeChaptersBtn");
  if (closeBtn) {
    const label = t("closeChapters");
    closeBtn.setAttribute("aria-label", label);
    setTooltip(closeBtn, label);
  }

  // Onboarding modal content (supports live Player language preview inside the modal)
  if (!(els.onboardingModal && !els.onboardingModal.hidden)) {
    ONBOARD_LOCALE = null;
  } else if (!ONBOARD_LOCALE) {
    ONBOARD_LOCALE = UI_LOCALE;
  }
  renderOnboardingModal();

  // Update skip-related labels in the active UI language
  try { applySkipSeconds(skipSeconds); } catch {}

if (els.resetBtn) {
    const label = t("resetLink");
    const lt = els.resetBtn.querySelector(".linkText");
    if (lt) lt.textContent = label;
    else els.resetBtn.textContent = label;
    setTooltip(els.resetBtn, label);
  }
if (els.resetTitle) els.resetTitle.textContent = t("resetTitle");
if (els.resetCloseX) {
  const label = t("close");
  els.resetCloseX.setAttribute("aria-label", label);
  setTooltip(els.resetCloseX, label);
}
if (els.resetBody) renderParagraphs(els.resetBody, t("resetBody"));
if (els.resetCancel) {
  const label = t("resetCancel");
  els.resetCancel.textContent = label;
  setTooltip(els.resetCancel, label);
}
if (els.resetOk) {
  const label = t("resetOk");
  els.resetOk.textContent = label;
  setTooltip(els.resetOk, label);
}

}



  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
  function pad2(n) { return String(n).padStart(2, "0"); }

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return "0:00";
    seconds = Math.floor(seconds);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
  }

  function formatTimeLeftHuman(remainingSeconds) {
    const r = (typeof remainingSeconds === "number" && isFinite(remainingSeconds)) ? Math.max(0, Math.floor(remainingSeconds)) : 0;
    if (r < 60) return t("timeLeftLessThanMinute");
    const h = Math.floor(r / 3600);
    const m = Math.floor((r % 3600) / 60);
    if (h <= 0) return fmt(t("timeLeftMinutes"), { m });
    return fmt(t("timeLeftHoursMinutes"), { h, m });
  }


function getKnownDuration() {
  // Hide duration (and any duration hints) until the user explicitly starts playback.
  if (!durationUnlocked) return 0;
  const dur = (els.audio && isFinite(els.audio.duration)) ? els.audio.duration : 0;
  if (dur > 0) return dur;
  const hint = (typeof knownDuration === "number" && isFinite(knownDuration)) ? knownDuration : 0;
  return hint > 0 ? hint : 0;
}

const UNKNOWN_TIME = "—:—";

function setSeekEnabled(enabled) {
  try {
    if (!els.seek) return;
    els.seek.disabled = !enabled;
    els.seek.setAttribute("aria-disabled", String(!enabled));
  } catch {}
}

function clearAudioSourceForLazyLoad() {
  try {
    // Remove any <source> children and reset the media element to NO_SOURCE
    Array.from(els.audio.querySelectorAll("source")).forEach(s => s.remove());
  } catch {}
  try { els.audio.removeAttribute("src"); } catch {}
  try { els.audio.preload = "none"; } catch {}
  try { els.audio.load(); } catch {}
  audioPrimed = false;
}

function primeAudioSource(url, mime, startTimeSec) {
  pendingAudio = {
    url: String(url || ""),
    mime: String(mime || ""),
    startTime: (typeof startTimeSec === "number" && isFinite(startTimeSec) && startTimeSec >= 0) ? startTimeSec : 0
  };

  // Reset duration UI until user presses Play
  durationUnlocked = false;

  // Reset media element so it won't fetch anything until Play
  try { els.audio.pause(); } catch {}
  clearAudioSourceForLazyLoad();

  // Keep state consistent for seek/chapters/progress labels
  lastKnownTime = pendingAudio.startTime;
  pendingSeekTime = pendingAudio.startTime;

  setSeekEnabled(false);
  try { updateTimes(); } catch {}
}



function seekTo(seconds, opts = {}) {
  const { resumeIfPlaying = true, persist = true, forcePlay = false } = opts;

  const wasPlaying = !els.audio.paused && !els.audio.ended;

    // Preserve intent across iOS source switches
    if (wasPlaying) userWantsPlaying = true;
  const shouldResume = resumeIfPlaying && (forcePlay || wasPlaying);

  const dur = getKnownDuration();

  const raw = (typeof seconds === "number" && isFinite(seconds)) ? seconds : 0;
  const target = (dur && dur > 0) ? clamp(raw, 0, Math.max(0, dur - 0.01)) : Math.max(0, raw);

  // Update state immediately (important for subsequent quality switches)
  pendingSeekTime = target;
  lastKnownTime = target;

  // If a source switch is in progress, defer the actual media seek until the new source is ready.
  if (isSourceSwitching) {
    sourceSwitchTargetTime = target;
    updateTimes();
    markActiveChapterByTime(target);
    return target;
  }

  const doSeekOnce = async () => {
    try {
      // Ensure metadata is available on iOS before seeking
      await waitForMediaReady(8000);

      let attempted = false;
      try {
        if (typeof els.audio.fastSeek === "function") {
          els.audio.fastSeek(target);
          attempted = true;
        }
      } catch {}
      if (!attempted) {
        try { els.audio.currentTime = target; } catch {}
      }

      // Wait briefly for seek to complete
      await new Promise((resolve) => {
        const done = () => resolve();
        els.audio.addEventListener("seeked", done, { once: true });
        window.setTimeout(done, 900);
      });

      const now = isFinite(els.audio.currentTime) ? els.audio.currentTime : target;
      const ok = Math.abs(now - target) <= 0.75 || !isFinite(now);

      if (!ok) {
        // Retry once after canplay/loadedmetadata (iOS sometimes ignores first seek)
        await waitForMediaReady(4000);
        try { els.audio.currentTime = target; } catch {}
        await new Promise((resolve) => {
          const done = () => resolve();
          els.audio.addEventListener("seeked", done, { once: true });
          window.setTimeout(done, 900);
        });
      }
    } finally {
      updateTimes();
      markActiveChapterByTime(target);

      if (persist) saveProgressAt(target);

      if (shouldResume) {
        // Some browsers reset playbackRate during/after seeks, especially
        // following src swaps. Re-apply the persisted speed right before resuming.
        try { reapplyPlaybackRateFromPrefs(); } catch {}
        safePlay().catch(() => {});
      }

      setUiBusy(false);
    }
  };

  setUiBusy(true);
  doSeekOnce();

  return target;
}



  function getQueryParam(name, fallback) {
    const u = new URL(window.location.href);
    return u.searchParams.get(name) || fallback;
  }

  function storageKey(episodeId) { return `compactPlayer:${episodeId}`; }

  // --- Episode library (media/library.json) -------------------------------
  // Users can add new audiobooks by creating media/<folder>/episode.json and
  // listing them in media/library.json.
  const LAST_EPISODE_KEY = "compactPlayer:lastEpisode";
  let libraryIndex = null; // { defaultId, episodes: [{id, folder, title, label}], byId }

  function normalizeLibraryIndex(raw) {
    const out = { defaultId: "", episodes: [], byId: {} };
    if (!raw || typeof raw !== "object") return out;

    const eps = Array.isArray(raw.audiofiles) ? raw.audiofiles : Array.isArray(raw.episodes) ? raw.episodes : Array.isArray(raw.items) ? raw.items : [];
    for (const it of eps) {
      if (!it || typeof it !== "object") continue;
      const id = String(it.id || it.episode || it.key || "").trim();
      const folder = String(it.folder || it.path || id || "").trim();
      if (!id || !folder) continue;

      const title = (it.title && typeof it.title === "object") ? it.title : null;
      const label = (it.label != null) ? String(it.label) : "";
      const rec = { id, folder, title, label };
      out.episodes.push(rec);
      out.byId[id] = rec;
    }

    const def = String(raw.default || raw.defaultId || "").trim();
    out.defaultId = def || (out.episodes[0] ? out.episodes[0].id : "");
    return out;
  }

  function getEpisodeFolder(epId) {
    const rec = libraryIndex && libraryIndex.byId ? libraryIndex.byId[epId] : null;
    const folder = rec && rec.folder ? String(rec.folder) : "";
    return folder || epId;
  }

  function pickEpisodeLabel(rec) {
    if (!rec) return "";
    // Prefer localized titles (matching Player language) when provided
    const loc = normalizeLangTag(UI_LOCALE);
    if (rec.title && typeof rec.title === "object") {
      const direct = rec.title[loc] || rec.title[String(loc || "").split("-")[0]];
      if (direct) return String(direct);
      if (rec.title.en) return String(rec.title.en);
      const first = Object.keys(rec.title)[0];
      if (first) return String(rec.title[first]);
    }
    if (rec.label) return String(rec.label);
    return String(rec.id || "");
  }

  function readLastEpisodeId() {
    try { return String(localStorage.getItem(LAST_EPISODE_KEY) || "").trim(); } catch { return ""; }
  }

  function writeLastEpisodeId(epId) {
    try { localStorage.setItem(LAST_EPISODE_KEY, String(epId || "")); } catch {}
  }

  function setUrlEpisodeParam(epId) {
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("episode", String(epId || ""));
      history.replaceState(null, "", u.toString());
    } catch {}
  }

  async function loadLibraryIndex() {
    const baseUrl = new URL(".", window.location.href);
    const url = new URL("media/library.json", baseUrl).toString();
    const fileLabel = "media/library.json";

    const res = await fetchWithRetry(url, { cache: "no-store", credentials: "include" });
    if (!res.ok) return null;

    const text = await res.text();
    const raw = tryParseJsonText(text, fileLabel, (msg) => {
      console.error(msg);
      try { showToast(msg, "error", 9000); } catch {}
      try { flashMetaError(msg, 9000); } catch {}
    });
    if (!raw) return null;

    const idx = normalizeLibraryIndex(raw);
    if (!idx.episodes.length) {
      const warn = `No valid entries found in ${fileLabel}.`;
      try { console.warn(warn); } catch {}
      try { showToast(warn, "warning", 7000); } catch {}
      try { flashMetaError(warn, 7000); } catch {}
      return null;
    }
    return idx;
  }

  let _suppressEpisodeSelect = false;
  function populateEpisodeSelect(selectedId) {
    if (!els.episodeSelect) return;

    const sel = els.episodeSelect;
    sel.innerHTML = "";

    const eps = (libraryIndex && libraryIndex.episodes) ? libraryIndex.episodes : [];
    if (!eps.length) {
      const opt = document.createElement("option");
      opt.value = episodeId || "episode-001";
      opt.textContent = episodeId || "episode-001";
      sel.appendChild(opt);
    } else {
      for (const rec of eps) {
        const opt = document.createElement("option");
        opt.value = rec.id;
        opt.textContent = pickEpisodeLabel(rec);
        sel.appendChild(opt);
      }
    }

    const desired = selectedId || episodeId;
    _suppressEpisodeSelect = true;
    try {
      if (desired) {
        const has = Array.from(sel.options).some(o => o.value === desired);
        if (!has) {
          const opt = document.createElement("option");
          opt.value = desired;
          opt.textContent = desired;
          sel.appendChild(opt);
        }
        sel.value = desired;
      }
    } finally {
      _suppressEpisodeSelect = false;
    }
    try { updateEpisodeRowVisibility(); } catch {}

  }

  function updateEpisodeRowVisibility() {
    if (!els.episodeRow) return;
    let n = 0;
    if (libraryIndex && Array.isArray(libraryIndex.episodes)) {
      n = libraryIndex.episodes.length;
    } else if (els.episodeSelect && els.episodeSelect.options) {
      n = els.episodeSelect.options.length;
    }
    // Hide when there is 0 or 1 entry
    els.episodeRow.hidden = !(n > 1);
  }

  function resolveInitialEpisodeId() {
    const q = String(getQueryParam("episode", "") || "").trim();
    if (q) return q;

    const last = readLastEpisodeId();
    if (last && libraryIndex && libraryIndex.byId && libraryIndex.byId[last]) return last;

    if (libraryIndex && libraryIndex.defaultId) return libraryIndex.defaultId;
    return "episode-001";
  }

  // --- Modal accessibility: inert + focus trap ----------------------------
  const MAIN_APP_ID = "mainApp";
  let _lastFocusedBeforeModal = null;
  let _activeModalBackdrop = null;
  let _focusTrapHandler = null;

  function setAppInert(isInert) {
    const app = document.getElementById(MAIN_APP_ID);
    if (!app) return;
    try { app.inert = !!isInert; } catch {}
    // Fallback for older browsers: hide from accessibility tree
    try {
      if (isInert) app.setAttribute("aria-hidden", "true");
      else app.removeAttribute("aria-hidden");
    } catch {}
  }

  function getFocusable(container) {
    if (!container) return [];
    const selectors = [
      "button:not([disabled])",
      "[href]",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    return Array.from(container.querySelectorAll(selectors)).filter((el) => {
      if (!el) return false;
      if (el.getAttribute("aria-hidden") === "true") return false;
      const style = window.getComputedStyle(el);
      return style && style.visibility !== "hidden" && style.display !== "none";
    });
  }

  function trapFocus(backdropEl) {
    if (!backdropEl) return;
    const modal = backdropEl.querySelector(".modal") || backdropEl;
    const handler = (e) => {
      if (e.key !== "Tab") return;
      const focusables = getFocusable(modal);
      if (!focusables.length) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || active === modal) {
          e.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first.focus({ preventScroll: true });
        }
      }
    };
    modal.addEventListener("keydown", handler);
    _focusTrapHandler = () => modal.removeEventListener("keydown", handler);
  }

  function openModal(backdropEl, preferredFocusEl) {
    if (!backdropEl) return;
    _lastFocusedBeforeModal = document.activeElement;
    _activeModalBackdrop = backdropEl;
    setAppInert(true);
    backdropEl.hidden = false;
    trapFocus(backdropEl);
    const focusTarget = preferredFocusEl || getFocusable(backdropEl)[0] || backdropEl;
    try { focusTarget.focus({ preventScroll: true }); } catch {}
  }

  function closeModal(backdropEl) {
    if (!backdropEl) return;
    backdropEl.hidden = true;
    if (_focusTrapHandler) {
      try { _focusTrapHandler(); } catch {}
      _focusTrapHandler = null;
    }
    setAppInert(false);
    const toFocus = _lastFocusedBeforeModal;
    _lastFocusedBeforeModal = null;
    _activeModalBackdrop = null;
    if (toFocus && typeof toFocus.focus === "function") {
      try { toFocus.focus({ preventScroll: true }); } catch {}
    }
  }

  function isAnyModalOpen() {
    return !!((els.onboardingModal && !els.onboardingModal.hidden) || (els.resetModal && !els.resetModal.hidden));
  }

// --- First-visit onboarding ------------------------------------------------
const ONBOARDING_KEY = "compactAudioPlayer.onboardingShown.v1";

function hasSeenOnboarding() {
  try { return localStorage.getItem(ONBOARDING_KEY) === "1"; } catch { return false; }
}

function markOnboardingSeen() {
  try { localStorage.setItem(ONBOARDING_KEY, "1"); } catch {}
}

function confirmOnboarding() {
  try {
    // Apply language selections from onboarding controls (if present).
    const uiChoice = _onboardUiLangSelect ? (_onboardUiLangSelect.value || "en") : null;
    const audioChoice = _onboardAudioLangSelect ? (_onboardAudioLangSelect.value || "") : null;

    if (uiChoice && els && els.uiLangSelect && els.uiLangSelect.value !== uiChoice) {
      els.uiLangSelect.value = uiChoice;
      try { els.uiLangSelect.dispatchEvent(new Event("change", { bubbles: true })); } catch {
        // Fallback: apply directly
        const ui = readUiPrefs();
        ui.uiLang = uiChoice;
        writeUiPrefs(ui);
        UI_LOCALE = detectUiLocale();
        applyUiStrings();
        refreshQualitySelectLabelsFromDom();
        updateMetaLineAfterUiLangChange();
        try { updatePlayButton(); } catch {}
      }
    }

    if (audioChoice && els && els.langSelect && els.langSelect.value !== audioChoice) {
      els.langSelect.value = audioChoice;
      try { els.langSelect.dispatchEvent(new Event("change", { bubbles: true })); } catch {}
    }
  } catch {}
}

function openOnboarding() {
  if (!els.onboardingModal) return;
  ONBOARD_LOCALE = UI_LOCALE;
  try { renderOnboardingModal(); } catch {}
  openModal(els.onboardingModal, els.onboardingOk);
}

function closeOnboarding() {
  if (!els.onboardingModal) return;
  markOnboardingSeen();
  ONBOARD_LOCALE = null;
  closeModal(els.onboardingModal);
}

function openResetModal() {
  if (!els.resetModal) return;
  openModal(els.resetModal, els.resetOk);
}

function closeResetModal() {
  if (!els.resetModal) return;
  closeModal(els.resetModal);
}

function resetPlayerAndStorage() {
  try {
    // Remove everything this player stores, across all episodes/languages/versions.
    // This is intentionally prefix-based so older/newer builds are also cleared.
    const prefixes = ["compactPlayer:", "compactAudioPlayer.", "cap_avail_"];

    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (prefixes.some(p => k.startsWith(p))) {
        try { localStorage.removeItem(k); } catch {}
      }
    }

    // Backward-compat: some builds may have used these exact keys
    try { localStorage.removeItem(UI_PREFS_KEY); } catch {}
    try { localStorage.removeItem(ONBOARDING_KEY); } catch {}
    try { if (episodeId) localStorage.removeItem(storageKey(episodeId)); } catch {}
  } catch {}

  // Also reset the in-memory/player state immediately (useful if reload is blocked).
  try { els.audio.pause(); } catch {}
  try { els.audio.currentTime = 0; } catch {}
  try { userWantsPlaying = false; } catch {}

  // Reload to ensure the runtime state is fully reset
  try { location.replace(location.href.split("#")[0]); } catch {
    try { location.reload(); } catch {}
  }
}

// ---------------------------------------------------------------------------

const AVAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function availabilityCacheKey(epId, cacheVersion) {
  const v = (cacheVersion == null) ? 1 : cacheVersion;
  return `cap_avail_${epId}_v${v}`;
}

function readAvailabilityCache(epId, cacheVersion) {
  try {
    const sp = new URLSearchParams(location.search);
    if (sp.get("clearAvailCache") === "1") {
      localStorage.removeItem(availabilityCacheKey(epId, cacheVersion));
      return null;
    }
  } catch {}

  try {
    const key = availabilityCacheKey(epId, cacheVersion);
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    if (!obj.ts || (Date.now() - obj.ts) > AVAIL_TTL_MS) return null;
    if (!obj.existsByLang || typeof obj.existsByLang !== "object") return null;
    return obj;
  } catch {
    return null;
  }
}

function writeAvailabilityCache(epId, cacheVersion, config) {
  try {
    const key = availabilityCacheKey(epId, cacheVersion);
    const existsByLang = {};
    const codes = Object.keys((config && config._qualityByLang) || {});
    for (const code of codes) {
      const opts = config._qualityByLang[code] || [];
      const map = {};
      for (const o of opts) {
        if (!o || !o.id) continue;
        map[o.id] = !!o.exists;
      }
      existsByLang[code] = map;
    }
    const payload = {
      ts: Date.now(),
      existsByLang,
      availableLangCodes: Array.isArray(config._availableLangCodes) ? config._availableLangCodes : []
    };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {}
}
function isLangFullyScanned(code) {
  return !!(config && config._fullScanByLang && config._fullScanByLang[code]);
}

async function quickProbeLanguage(langCfg, allOpts, maxTries = 6) {
  // Probe only a small prioritized subset to decide if the language should be shown.
  const supported = (allOpts || []).filter(o => o && o.supported);

  // Prioritize codecs and bitrates (high -> low), but include lower bitrates as fallback.
  const codecRank = codecRankFromOrder(preferredCodecOrder());
  const bitrateOf = (o) => {
    if (typeof o.bitrate === "number") return o.bitrate;
    const m = (o.id || "").match(/-(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  };

  supported.sort((a, b) => {
    const ca = codecRank[a.codec] ?? 99;
    const cb = codecRank[b.codec] ?? 99;
    if (ca !== cb) return ca - cb;
    return bitrateOf(b) - bitrateOf(a);
  });

  // Add a few explicit "lowest" fallbacks per codec (covers "only 64k exists" cases)
  const lowestPerCodec = {};
  for (const o of supported) {
    const br = bitrateOf(o);
    if (!lowestPerCodec[o.codec] || br < bitrateOf(lowestPerCodec[o.codec])) lowestPerCodec[o.codec] = o;
  }
  const fallbacks = Object.values(lowestPerCodec);

  const candidates = [];
  for (const o of supported) { if (!candidates.includes(o)) candidates.push(o); }
  for (const o of fallbacks) { if (o && !candidates.includes(o)) candidates.push(o); }

  let tries = 0;
  for (const o of candidates) {
    if (tries >= maxTries) break;
    tries += 1;
    const url = buildUrlFor(langCfg, o.url);
    const ok = await urlExists(url);
    if (ok) {
      o.exists = true;
      return true;
    }
  }
  return false;
}

async function ensureFullScanForLanguage(code) {
  if (!config || !config.languages || !config.languages[code]) return;
  if (!config._fullScanByLang) config._fullScanByLang = {};

  // If we already have a scan result for this language, trust it in general.
  // On iOS/iPadOS, however, a fetch() based existence probe can occasionally yield
  // false negatives for AAC sources (while <audio> can still play them). If the cached
  // scan claims "no AAC exists" but MP3 exists and AAC is configured, re-validate once.
  if (config._fullScanByLang[code]) {
    if (!IS_IOS) return;
    try {
      const langCfg = config.languages[code];
      const aacCfg = (langCfg && langCfg.sources && langCfg.sources.aac) ? langCfg.sources.aac : null;
      const cachedOpts = (config._qualityByLang && config._qualityByLang[code]) ? config._qualityByLang[code] : null;
      const hasAacCfg = !!(aacCfg && Object.keys(aacCfg).length);
      if (!hasAacCfg || !cachedOpts || !cachedOpts.length) return;

      const anyAac = cachedOpts.some(o => o && o.codec === "aac" && !!o.exists);
      if (anyAac) return;

      const anyMp3 = cachedOpts.some(o => o && o.codec === "mp3" && !!o.exists);
      if (!anyMp3) return;

      const brs = Object.keys(aacCfg)
        .map(x => parseInt(x, 10))
        .filter(n => isFinite(n) && n > 0)
        .sort((a, b) => b - a);

      // Probe up to two AAC qualities (best -> next best) to avoid getting stuck
      // on an unavailable top bitrate.
      let ok = false;
      for (const br of brs.slice(0, 2)) {
        const rel = aacCfg[String(br)];
        if (!rel) continue;
        ok = await urlExists(buildUrlFor(langCfg, rel));
        if (ok) break;
      }
      if (!ok) return;

      // Cache looks wrong; clear the scan flag so we can do a proper scan now.
      config._fullScanByLang[code] = false;
    } catch {
      return;
    }

    if (config._fullScanByLang[code]) return;
  }

  const langCfg = config.languages[code];
  const allOpts = buildQualityOptionsForLanguage(langCfg);
  await enrichQualityOptionsWithExists(langCfg, allOpts);
  config._qualityByLang[code] = allOpts;
  config._fullScanByLang[code] = true;

  // When we fully scan a language, update the available languages list as well.
  const debugShowAllQualities = !!(config.debug && config.debug.showAllQualities);
  if (!config._availableLangCodes) config._availableLangCodes = [];
  const displayOpts = filterQualityOptionsForDisplay(allOpts, debugShowAllQualities);
  const hasPlayable = displayOpts.some(o => o.supported);
  if (hasPlayable && !config._availableLangCodes.includes(code)) config._availableLangCodes.push(code);

  // Write cache only when we have a full scan for all languages or a usable partial set.
  // We keep writing on each full scan to improve repeat visits.
  try {
    const cacheVersion = (config.cacheVersion == null) ? 1 : config.cacheVersion;
    writeAvailabilityCache(episodeId, cacheVersion, config);
  } catch {}
}

function scheduleBackgroundFullScan(preferredLangCode) {
  if (!config || !config.languages) return;
  if (config._bgScanScheduled) return;
  config._bgScanScheduled = true;

  const codes = Object.keys(config.languages || {});
  const work = async () => {
    try {
      // Scan non-selected languages first; keep selected fast path.
      for (const code of codes) {
        if (code === preferredLangCode) continue;
        await ensureFullScanForLanguage(code);
      }
    } catch {}
  };

  // Let the UI render first, then scan in idle time.
  try {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => { work(); }, { timeout: 2000 });
      return;
    }
  } catch {}
  window.setTimeout(() => { work(); }, 800);
}


function readPrefs(episodeId) {
    try { return JSON.parse(localStorage.getItem(storageKey(episodeId)) || "{}"); }
    catch { return {}; }
  }

  function writePrefs(episodeId, prefs) {
    try { localStorage.setItem(storageKey(episodeId), JSON.stringify(prefs)); } catch {}
  }


  const UI_PREFS_KEY = "compactPlayer:ui";

  function readUiPrefs() {
    try { return JSON.parse(localStorage.getItem(UI_PREFS_KEY) || "{}"); }
    catch { return {}; }
  }

  function writeUiPrefs(prefs) {
    try { localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs)); } catch {}
  }

  function applyTheme(mode) {
    const root = document.documentElement;
    if (mode === "light") {
      root.setAttribute("data-theme", "light");
    } else if (mode === "dark") {
      root.setAttribute("data-theme", "dark");
    } else {
      // system default
      root.removeAttribute("data-theme");
    }
  }

  function initTheme() {
    const ui = readUiPrefs();
    const mode = ui.theme || "system";
    applyTheme(mode);
    if (els.themeSelect) els.themeSelect.value = mode;
  }

  function applyFontSize(size) {
    const root = document.documentElement;
    if (size === "s" || size === "l") root.setAttribute("data-font", size);
    else root.removeAttribute("data-font");
  }

  function initFontSize() {
    const ui = readUiPrefs();
    const size = ui.fontSize || "m";
    applyFontSize(size);
    if (els.fontSizeSelect) els.fontSizeSelect.value = size;
  }

  function clampPlaybackRate(rate) {
    const r = (typeof rate === "number" && isFinite(rate)) ? rate : 1;
    return clamp(r, 0.5, 2);
  }

  function formatPlaybackRate(rate) {
    const r = clampPlaybackRate(rate);
    let s = r.toFixed(2);
    s = s.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
    return `${s}×`;
  }

  function applyPlaybackRate(rate) {
    const r = clampPlaybackRate(rate);
    // Important: several browsers reset `playbackRate` to `defaultPlaybackRate`
    // (often 1.0) on src swaps, load(), and sometimes after seeks. Setting BOTH
    // ensures the chosen speed survives quality/language/episode switches.
    try { if (els.audio) els.audio.defaultPlaybackRate = r; } catch {}
    try { if (els.audio) els.audio.playbackRate = r; } catch {}
    try {
      if (els.speedValue) els.speedValue.textContent = formatPlaybackRate(r);
      if (els.speedRange) {
        els.speedRange.value = String(r);
        els.speedRange.setAttribute("aria-valuetext", formatPlaybackRate(r));
      }
    } catch {}
    try { updateMediaSessionPositionState(true); } catch {}
    return r;
  }


  // Persist playback speed immediately so it survives source swaps even if the
  // user drags the slider and switches language/quality/episode without a
  // "change" commit event firing.
  function persistPlaybackRate(rate) {
    const r = clampPlaybackRate(rate);
    try {
      const ui = readUiPrefs();
      ui.playbackRate = r;
      writeUiPrefs(ui);
    } catch {}
    return r;
  }

  // Some browsers reset playbackRate to 1.0 when changing src/load() or during
  // certain quality/language switches. Re-apply the persisted preference.
  function reapplyPlaybackRateFromPrefs() {
    try {
      const ui = readUiPrefs();
      if (ui && typeof ui.playbackRate === "number" && isFinite(ui.playbackRate)) {
        applyPlaybackRate(ui.playbackRate);
      }
    } catch {}
  }

  function clampVolume01(v) {
    const n = (typeof v === "number" && isFinite(v)) ? v : 1;
    return clamp(n, 0, 1);
  }

  function volumeToPercentString(v01) {
    const v = clampVolume01(v01);
    return `${Math.round(v * 100)}%`;
  }

  function applyVolume(v01) {
    const v = clampVolume01(v01);
    try { if (els.audio) els.audio.volume = v; } catch {}
    try {
      if (els.volumeValue) els.volumeValue.textContent = volumeToPercentString(v);
      if (els.volumeRange) {
        const p = String(Math.round(v * 100));
        els.volumeRange.value = p;
        els.volumeRange.setAttribute("aria-valuetext", `${p}%`);
      }
    } catch {}
    return v;
  }

  function initVolume() {
    const ui = readUiPrefs();
    const stored = (ui && typeof ui.volume === "number" && isFinite(ui.volume)) ? ui.volume : 1;
    const v = applyVolume(stored);
    if (els.volumeRange) {
      try { els.volumeRange.value = String(Math.round(v * 100)); } catch {}
    }
  }

  function clampSkipSeconds(v) {
    const n = parseInt(v, 10);
    if (n === 5 || n === 10 || n === 15 || n === 30 || n === 60) return n;
    return 15;
  }

  function applySkipSeconds(v) {
    skipSeconds = clampSkipSeconds(v);

    try { if (els.skipSelect) els.skipSelect.value = String(skipSeconds); } catch {}

    // Update expanded-mode skip button labels + accessible text
    try {
      const backLabel = fmt(t("skipBackAria"), { s: skipSeconds });
      const fwdLabel = fmt(t("skipForwardAria"), { s: skipSeconds });

      if (els.focusSkipBack) {
        els.focusSkipBack.textContent = `<<${skipSeconds}`;
        els.focusSkipBack.setAttribute("aria-label", backLabel);
        els.focusSkipBack.setAttribute("title", backLabel);
        els.focusSkipBack.dataset.tooltip = backLabel;
      }
      if (els.focusSkipForward) {
        els.focusSkipForward.textContent = `${skipSeconds}>>`;
        els.focusSkipForward.setAttribute("aria-label", fwdLabel);
        els.focusSkipForward.setAttribute("title", fwdLabel);
        els.focusSkipForward.dataset.tooltip = fwdLabel;
      }
    } catch {}

    // Update Media Session seek offsets (best-effort)
    try {
      if ("mediaSession" in navigator && navigator.mediaSession) {
        // No direct setter for default offsets; the action handlers read skipSeconds when invoked.
      }
    } catch {}

    return skipSeconds;
  }

  function initSkipSeconds() {
    const ui = readUiPrefs();
    const stored = (ui && ("skipSeconds" in ui)) ? ui.skipSeconds : 15;
    applySkipSeconds(stored);
    if (els.skipSelect) {
      try { els.skipSelect.value = String(skipSeconds); } catch {}
    }
  }

  function initPlaybackRate() {
    const ui = readUiPrefs();
    const stored = (ui && typeof ui.playbackRate === "number" && isFinite(ui.playbackRate)) ? ui.playbackRate : 1;
    const r = applyPlaybackRate(stored);
    if (els.speedRange) {
      try { els.speedRange.value = String(r); } catch {}
    }
  }

  function getProgress(prefs, langCode) {
    const byLang = (prefs && prefs.progressByLang) ? prefs.progressByLang : {};
    const t = byLang && typeof byLang[langCode] === "number" ? byLang[langCode] : null;
    if (typeof t === "number" && isFinite(t) && t >= 0) return t;
    // Back-compat / fallback
    if (typeof prefs.lastTime === "number" && isFinite(prefs.lastTime) && prefs.lastTime >= 0) return prefs.lastTime;
    return 0;
  }

  function setProgress(prefs, langCode, seconds) {
    if (!prefs.progressByLang || typeof prefs.progressByLang !== "object") prefs.progressByLang = {};
    prefs.progressByLang[langCode] = seconds;
    prefs.lastTime = seconds; // simple fallback
  }
  function guessBestLanguage(availableLangs, fallbackLang) {
    const nav = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || ""];

    // Exact match (full language tag)
    for (const raw of nav) {
      const tag = String(raw || "").toLowerCase();
      if (tag && availableLangs.includes(tag)) return tag;
    }

    // Base tag match (with Norwegian normalization)
    for (const raw of nav) {
      const base = normalizeLangTag(raw);
      if (base && availableLangs.includes(base)) return base;
    }

    return fallbackLang;
  }

  /** Codec support detection **/
  function canPlay(mime) {
    const v = els.audio.canPlayType(mime);
    return v === "probably" ? 2 : (v === "maybe" ? 1 : 0);
  }

  function extFromPath(p) {
    const m = String(p).toLowerCase().match(/\.([a-z0-9]+)(?:\?|#|$)/);
    return m ? m[1] : "";
  }

  function mimeFor(codec, ext) {
    if (codec === "opus") {
      if (ext === "webm") return 'audio/webm; codecs="opus"';
      if (ext === "ogg") return 'audio/ogg; codecs="opus"';
      return 'audio/webm; codecs="opus"';
    }
    if (codec === "aac") return 'audio/mp4; codecs="mp4a.40.2"';
    if (codec === "mp3") return "audio/mpeg";
    return "";
  }

  /** WebVTT parsing (chapter cues) **/
  function parseVttTime(t) {
    const s = t.trim();
    const parts = s.split(":");
    let h = 0, m = 0, secms = "";
    if (parts.length === 3) {
      h = parseInt(parts[0], 10);
      m = parseInt(parts[1], 10);
      secms = parts[2];
    } else if (parts.length === 2) {
      m = parseInt(parts[0], 10);
      secms = parts[1];
    } else {
      return NaN;
    }
    const [secStr, msStr] = secms.split(".");
    const sec = parseInt(secStr, 10);
    const ms = msStr ? parseInt(msStr.padEnd(3, "0").slice(0, 3), 10) : 0;
    return (h * 3600) + (m * 60) + sec + (ms / 1000);
  }

  function parseVtt(text) {
  // Robust WebVTT chapters parser with a permissive timestamp parser.
  // - Supports optional cue identifiers
  // - Skips NOTE/STYLE/REGION
  // - Accepts timestamps with "." or "," milliseconds and with/without milliseconds
  // - Strips basic WebVTT cue markup tags from titles
  const raw = String(text || "");
  const lines = raw.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
  const cues = [];
  let i = 0;

  // Skip WEBVTT header and header metadata until first blank line
  if (lines[i] && lines[i].trim().startsWith("WEBVTT")) {
    i++;
    while (i < lines.length && lines[i].trim() !== "") i++;
  }

  function parseTimestamp(ts) {
    // Accepts:
    //  - hh:mm:ss.mmm
    //  - hh:mm:ss,mmm
    //  - mm:ss.mmm
    //  - mm:ss,mmm
    //  - hh:mm:ss
    //  - mm:ss
    const t = (ts || "").trim().replace(",", ".");
    const parts = t.split(":");
    if (parts.length < 2) return NaN;

    let h = 0, m = 0, s = 0;

    if (parts.length === 3) {
      h = parseInt(parts[0], 10);
      m = parseInt(parts[1], 10);
      s = parseFloat(parts[2]);
    } else {
      m = parseInt(parts[0], 10);
      s = parseFloat(parts[1]);
    }

    if (![h, m, s].every((x) => Number.isFinite(x))) return NaN;
    return h * 3600 + m * 60 + s;
  }

  function cleanTitle(t) {
    const s = String(t || "").trim();
    // Strip WebVTT cue markup (basic HTML-like tags)
    const noTags = s.replace(/<[^>]+>/g, "");
    // Collapse whitespace
    return noTags.replace(/\s+/g, " ").trim();
  }

  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length) break;

    // Skip NOTE / STYLE / REGION blocks
    const head = lines[i].trim();
    if (/^(NOTE|STYLE|REGION)\b/.test(head)) {
      i++;
      while (i < lines.length && lines[i].trim() !== "") i++;
      continue;
    }

    // Optional cue identifier
    const maybeId = lines[i].trim();
    const next = (lines[i + 1] || "").trim();
    const timingLine = maybeId.includes("-->") ? maybeId : next;

    if (!timingLine.includes("-->")) {
      i++;
      continue;
    }

    // Move i to timing line
    if (!maybeId.includes("-->")) i++;

    const parts = timingLine.split("-->");
    const startStr = (parts[0] || "").trim();
    // End may include cue settings; keep only first token
    const endStr = ((parts[1] || "").trim().split(/\s+/)[0] || "").trim();

    const start = parseTimestamp(startStr);
    const end = parseTimestamp(endStr);

    // Move to first text line after timing
    i++;

    const textLines = [];
    while (i < lines.length && lines[i].trim() !== "") {
      const ln = lines[i].trim();
      if (!/^NOTE\b/.test(ln)) textLines.push(ln);
      i++;
    }

    const titleRaw = textLines.join(" ");
    const title = cleanTitle(titleRaw) || "Chapter";

    if (Number.isFinite(start) && start >= 0) {
      cues.push({ start, end: Number.isFinite(end) ? end : null, title });
    }
  }

  // Deduplicate by start time + title
  const seen = new Set();
  const out = [];
  for (const c of cues.sort((a, b) => a.start - b.start)) {
    const key = `${Math.round(c.start * 1000)}|${c.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

  /** Quality labels & filtering **/
function qualityDisplayLabel(q, opts) {
  if (!q) return "";
  const o = opts || {};
  const includeBitrate = (o.includeBitrate !== false);
  const br = (includeBitrate && typeof q.bitrate === "number" && q.bitrate > 0)
    ? `${q.bitrate} kb/s — `
    : "";

  if (q.codec === "opus") {
    if (q.bitrate >= 256) return br + t("qPremium");
    if (q.bitrate >= 128) return br + t("qHigh");
    if (q.bitrate >= 96) return br + t("qLow");
    return br + t("qUltraLow");
  }

  if (q.codec === "aac") {
    if (q.bitrate >= 256) return br + t("qPremium");
    if (q.bitrate >= 128) return br + t("qHigh");
    if (q.bitrate >= 96) return br + t("qLow");
    return br + t("qUltraLow");
  }

  if (q.codec === "mp3") {
    // MP3 is treated as a legacy format; keep labels distinct from modern codecs.
    if (q.bitrate >= 128) return br + t("qLegacyFair");
    if (q.bitrate >= 96) return br + t("qLegacyLow");
    return br + t("qLegacyUltraLow");
  }

  return br.trim();
}



function metaWithQuality(langLabel, epId, qualityLabel) {
  // epId intentionally omitted from UI meta line
  const base = `${langLabel}`;
  return qualityLabel ? `${base} • ${qualityLabel}` : base;
}

function currentQualityLabelFromOptions(langCfg) {
  try {
    const allQualityOptions = buildQualityOptionsForLanguage(langCfg);
    const debugShowAllQualities = !!(config && config.debug && config.debug.showAllQualities);
    const displayQualityOptions = filterQualityOptionsForDisplay(allQualityOptions, debugShowAllQualities);
    const selId = els.qualitySelect ? els.qualitySelect.value : null;
    const q = displayQualityOptions.find(o => o.id === selId) || displayQualityOptions.find(o => o.supported) || null;
    return q ? qualityDisplayLabel(q) : "";
  } catch {
    return "";
  }
}

function filterQualityOptionsForDisplay(allOptions, debugShowAllQualities) {
    // Always hide missing files
    const existing = (allOptions || []).filter(o => o && o.exists);

    if (debugShowAllQualities) return existing;

    // Prefer AAC on iOS/iPadOS. WebM/Opus support in Safari can be inconsistent,
    // and canPlayType() may be overly optimistic on some builds.
    const codecOrder = preferredCodecOrder();
    for (const codec of codecOrder) {
      const ok = existing.some(o => o.codec === codec && o.supported);
      if (ok) return existing.filter(o => o.codec === codec);
    }
    return existing;
  }

  function getSafeCurrentTime(fallback = 0) {
    try {
      // If the element is in an error state, currentTime may be 0 even though
      // we have a better last-known value.
      const hasError = !!(els.audio && els.audio.error);
      const t = (!hasError && isFinite(els.audio.currentTime) && els.audio.currentTime >= 0)
        ? els.audio.currentTime
        : (isFinite(lastKnownTime) && lastKnownTime >= 0 ? lastKnownTime : fallback);
      return t;
    } catch {
      return (isFinite(lastKnownTime) && lastKnownTime >= 0) ? lastKnownTime : fallback;
    }
  }

  // iOS/iPadOS: Opus-in-WebM can appear supported but fail to load/decode.
  // When that happens, fall back to AAC/MP3 without breaking playback.
  let _opusFallbackBusy = false;
  let _opusFallbackLastKey = "";
  let _opusFallbackLastAt = 0;

  function findFallbackForOpus(langCode, currentQualityId) {
    if (!config || !langCode) return null;
    const opts = (config._qualityByLang && config._qualityByLang[langCode]) ? config._qualityByLang[langCode] : [];
    const playable = (opts || []).filter(o => o && o.exists && o.supported);
    if (!playable.length) return null;

    const cur = playable.find(o => o.id === currentQualityId) || null;
    const bitrate = cur ? cur.bitrate : (parseInt(String(currentQualityId || "").split("-")[1] || "0", 10) || 0);

    const pickSame = (codec) => playable.find(o => o.codec === codec && o.bitrate === bitrate) || null;
    const pickBest = (codec) => {
      const list = playable.filter(o => o.codec === codec);
      list.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      return list[0] || null;
    };

    return pickSame("aac") || pickBest("aac") || pickSame("mp3") || pickBest("mp3") || null;
  }

  function applyQualityOption(langCode, q, seekTimeSec, shouldPlay) {
    if (!q || !config) return;
    const langCfg = config.languages[langCode];
    if (!langCfg) return;

    try { if (els.qualitySelect) els.qualitySelect.value = q.id; } catch {}
    try { applySelections(episodeId, langCode, q.id); } catch {}
    try { setMeta(metaWithQuality(langCfg.label || langCode, episodeId, qualityDisplayLabel(q))); } catch {}

    const audioUrl = buildUrlFor(langCfg, q.url);
    const mime = mimeFor(q.codec, q.ext);
    const tSec = (typeof seekTimeSec === "number" && isFinite(seekTimeSec) && seekTimeSec >= 0) ? seekTimeSec : getSafeCurrentTime(0);

    if (IS_IOS) {
      iosImmediateSwitchSource(audioUrl, mime, tSec, !!shouldPlay);
    } else {
      setAudioSource(audioUrl, mime, tSec, null, () => {
        if (shouldPlay) safePlay().catch(() => {});
      });
    }
  }

  async function attemptOpusFallback(seekTimeSec, reason = "") {
    try {
      if (!IS_IOS) return false;
      if (_opusFallbackBusy) return false;
      if (!config || !episodeId || !els.qualitySelect || !els.langSelect) return false;

      const langCode = String(els.langSelect.value || config.defaultLanguage || "");
      const curId = String(els.qualitySelect.value || "");
      if (!curId.startsWith("opus-")) return false;

      const key = `${episodeId}|${langCode}|${curId}`;
      const now = Date.now();
      if (_opusFallbackLastKey === key && (now - _opusFallbackLastAt) < 15000) return false;

      const fallback = findFallbackForOpus(langCode, curId);
      if (!fallback) return false;

      _opusFallbackBusy = true;
      _opusFallbackLastKey = key;
      _opusFallbackLastAt = now;

      const shouldPlay = userWantsPlaying || (!els.audio.paused && !els.audio.ended);
      applyQualityOption(langCode, fallback, seekTimeSec, shouldPlay);

      try { showToast(t("audioFallbackCompatible"), "info"); } catch {}
      return true;
    } catch {
      return false;
    } finally {
      _opusFallbackBusy = false;
    }
  }

  

  // iOS/iPadOS: AAC can load but fail to decode/play on certain Safari builds.
  // When that happens, fall back to MP3 without breaking playback.
  let _aacFallbackBusy = false;
  let _aacFallbackLastKey = "";
  let _aacFallbackLastAt = 0;

  function findFallbackForAac(langCode, currentQualityId) {
    if (!config || !langCode) return null;
    const opts = (config._qualityByLang && config._qualityByLang[langCode]) ? config._qualityByLang[langCode] : [];
    const playable = (opts || []).filter(o => o && o.exists && o.supported);
    if (!playable.length) return null;

    const cur = playable.find(o => o.id === currentQualityId) || null;
    const bitrate = cur ? cur.bitrate : (parseInt(String(currentQualityId || "").split("-")[1] || "0", 10) || 0);

    const pickSame = (codec) => playable.find(o => o.codec === codec && o.bitrate === bitrate) || null;
    const pickBest = (codec) => {
      const list = playable.filter(o => o.codec === codec);
      list.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      return list[0] || null;
    };

    return pickSame("mp3") || pickBest("mp3") || null;
  }

  async function attemptAacFallback(seekTimeSec, reason = "") {
    try {
      if (!IS_IOS) return false;
      if (_aacFallbackBusy) return false;
      if (!config || !episodeId || !els.qualitySelect || !els.langSelect) return false;

      const langCode = String(els.langSelect.value || config.defaultLanguage || "");
      const curId = String(els.qualitySelect.value || "");
      if (!curId.startsWith("aac-")) return false;

      const key = `${episodeId}|${langCode}|${curId}`;
      const now = Date.now();
      if (_aacFallbackLastKey === key && (now - _aacFallbackLastAt) < 15000) return false;

      const fallback = findFallbackForAac(langCode, curId);
      if (!fallback) return false;

      _aacFallbackBusy = true;
      _aacFallbackLastKey = key;
      _aacFallbackLastAt = now;

      const shouldPlay = userWantsPlaying || (!els.audio.paused && !els.audio.ended);
      applyQualityOption(langCode, fallback, seekTimeSec, shouldPlay);

      try { showToast(t("audioFallbackCompatible"), "info"); } catch {}
      return true;
    } catch {
      return false;
    } finally {
      _aacFallbackBusy = false;
    }
  }

  // Unified iOS codec fallback (Opus -> AAC/MP3, AAC -> MP3)
  async function attemptCodecFallback(seekTimeSec, reason = "") {
    try {
      if (!IS_IOS) return false;
      const curId = String((els.qualitySelect && els.qualitySelect.value) || "");
      if (curId.startsWith("opus-")) return await attemptOpusFallback(seekTimeSec, reason);
      if (curId.startsWith("aac-")) return await attemptAacFallback(seekTimeSec, reason);
      return false;
    } catch {
      return false;
    }
  }

/** UI State **/
  let episodeId = getQueryParam("episode", "episode-001");
  let config = null;
  let knownDuration = 0; // optional duration hint from episode.json (seconds)
  let cues = [];
  let activeCueIndex = -1;
  let chaptersUrlPending = "";
  let chaptersLoaded = false;
  let chaptersLoadError = false;
  let chaptersLoadInFlight = null;
  let isSeeking = false;
  let isExpanded = true;
  let sleepTimeout = null;
  let sleepEndAtMs = 0;
  let sleepMinutes = 0;
  let sleepTicker = null;

  // Lazy audio loading (A): do not set the audio source until the user presses Play.
  // This keeps initial page load fast and avoids fetching metadata/duration upfront.
  let durationUnlocked = false;
  let audioPrimed = false;
  let pendingAudio = { url: "", mime: "", startTime: 0 };

  let skipSeconds = 15;
  let playbackRatePersistTimer = null;
  let lastKnownTime = 0;
  let pendingSeekTime = null; // set when user jumps chapters/seeks; cleared on 'seeked'
  let isSourceSwitching = false;
let userWantsPlaying = false;

  let sourceSwitchTargetTime = null; // latest desired time during a source switch
  let lastProgressSaveMs = 0;
  let pendingProgressSave = false;

// iOS Safari smoothing: brief interaction lock during seeks/switches
let isUiBusy = false;
let _busyTimer = null;
function setUiBusy(busy, minMs = 350) {
  if (_busyTimer) { window.clearTimeout(_busyTimer); _busyTimer = null; }

  if (!busy) {
    // release after minMs to avoid rapid double-actions
    _busyTimer = window.setTimeout(() => {
      isUiBusy = false;
      document.documentElement.classList.remove("capBusy");
      try { if (els.episodeSelect) els.episodeSelect.disabled = false; } catch {}
      try { els.langSelect.disabled = false; } catch {}
      try { els.qualitySelect.disabled = false; } catch {}
      try { if (els.fontSizeSelect) els.fontSizeSelect.disabled = false; } catch {}
      try { els.themeSelect.disabled = false; } catch {}
      try { els.chaptersBtn.disabled = false; } catch {}
      try { els.optionsBtn.disabled = false; } catch {}
      try { if (els.chaptersList) els.chaptersList.setAttribute("aria-disabled", "false"); } catch {}
    }, minMs);
    return;
  }

  isUiBusy = true;
  document.documentElement.classList.add("capBusy");
  try { if (els.episodeSelect) els.episodeSelect.disabled = true; } catch {}
  try { els.langSelect.disabled = true; } catch {}
  try { els.qualitySelect.disabled = true; } catch {}
  try { if (els.fontSizeSelect) els.fontSizeSelect.disabled = true; } catch {}
  try { els.themeSelect.disabled = true; } catch {}
  try { els.chaptersBtn.disabled = true; } catch {}
  try { els.optionsBtn.disabled = true; } catch {}
  try { if (els.chaptersList) els.chaptersList.setAttribute("aria-disabled", "true"); } catch {}
}

function waitForMediaReady(timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (els.audio.readyState >= 1) return resolve(true);
    const t = window.setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    const onReady = () => { cleanup(); resolve(true); };
    function cleanup() {
      window.clearTimeout(t);
      els.audio.removeEventListener("loadedmetadata", onReady);
      els.audio.removeEventListener("canplay", onReady);
    }
    els.audio.addEventListener("loadedmetadata", onReady);
    els.audio.addEventListener("canplay", onReady);
  });
}


  function setTitle(text) {
    els.title.textContent = text;
    document.title = text || "Compact Audio Player";
    try {
      if (els.coverImg && els.coverWrap && !els.coverWrap.hidden) {
        els.coverImg.alt = text || "";
      }
    } catch {}
  }

  // Toggles a lightweight skeleton loader. Keeps layout stable and avoids the
  // "broken" look on slow networks.
  function setLoadingState(isLoading) {
    const v = !!isLoading;
    try { document.body.classList.toggle("isLoading", v); } catch {}
    try { if (els.playerCard) els.playerCard.classList.toggle("isLoading", v); } catch {}
  }

  function clearCover() {
    if (!els.coverWrap || !els.coverImg) return;
    els.coverWrap.hidden = true;
    try { closeCoverLightbox(); } catch {}
    try { els.coverWrap.classList.remove("isClickable"); } catch {}
    try { els.coverWrap.removeAttribute("role"); els.coverWrap.removeAttribute("tabindex"); els.coverWrap.removeAttribute("aria-label"); } catch {}
    try { els.coverWrap.classList.remove("isLoading"); } catch {}
    try { els.coverWrap.removeAttribute("aria-busy"); } catch {}
    try { els.coverImg.removeAttribute("src"); } catch {}
    try { els.coverImg.removeAttribute("srcset"); } catch {}
    try { delete els.coverImg.dataset.coverSrc; } catch {}
    els.coverImg.alt = "";
  }

  function resolveCoverSrc(coverValue, folder) {
    const v = String(coverValue == null ? "" : coverValue).trim();
    if (!v) return null;

    // Allow data URIs
    if (/^data:/i.test(v)) return v;

    // Absolute URLs
    if (/^https?:\/\//i.test(v)) return normalizeFetchUrl(v);

    // Protocol-relative URLs
    if (/^\/\//.test(v)) return normalizeFetchUrl(window.location.protocol + v);

    // Relative path: resolve against the episode folder
    try {
      const baseUrl = new URL(".", window.location.href);
      const episodeBase = new URL(`media/${encodeURIComponent(folder)}/`, baseUrl);
      return normalizeFetchUrl(new URL(v, episodeBase).toString());
    } catch {
      return v;
    }
  }

  function applyCoverFromConfig(cfg, folder, titleText) {
    if (!els.coverWrap || !els.coverImg) return;

    const src = resolveCoverSrc(cfg && cfg.cover, folder);
    if (!src) {
      clearCover();
      return;
    }

    const img = els.coverImg;
    const wrap = els.coverWrap;

    const schedule = (fn) => {
      try {
        if (window.queueMicrotask) return window.queueMicrotask(fn);
      } catch {}
      return window.setTimeout(fn, 0);
    };

    // Show the container immediately. Some browsers won't start fetching images
    // while the element is hidden (especially combined with lazy-loading).
    wrap.hidden = false;
    try { wrap.setAttribute("aria-busy", "true"); } catch {}
    try { wrap.classList.add("isLoading"); } catch {}

    const existing = (img.dataset && img.dataset.coverSrc) ? img.dataset.coverSrc : "";

    // If unchanged and already loaded, just ensure state is correct.
    if (existing === src && img.complete && img.naturalWidth > 0) {
      try { img.alt = titleText || ""; } catch {}
      try { wrap.classList.remove("isLoading"); } catch {}
      try { wrap.removeAttribute("aria-busy"); } catch {}
      return;
    }

    // Track the current intended source (used to avoid reloading on every call)
    try { img.dataset.coverSrc = src; } catch {}
    try { img.alt = titleText || ""; } catch {}

    let settled = false;
    const cleanup = () => { try { img.onload = null; img.onerror = null; } catch {} };

    img.onload = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try { wrap.classList.remove("isLoading"); } catch {}
      try { wrap.removeAttribute("aria-busy"); } catch {}
      try { wrap.classList.add("isClickable"); } catch {}
      try { wrap.setAttribute("role","button"); wrap.setAttribute("tabindex","0"); wrap.setAttribute("aria-label", t("openCover")); } catch {}
      wrap.hidden = false;
    };

    img.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try { wrap.classList.remove("isLoading"); } catch {}
      try { wrap.removeAttribute("aria-busy"); } catch {}
      clearCover();
      // Non-fatal
      try { showToast(t("coverLoadFailed"), "warning", 6000); } catch {}
    };

    schedule(() => {
      try {
        // Setting src after we made the container visible avoids deadlocks in some engines.
        img.src = src;
      } catch {}
    });
  }


  // ---------------------
  // Cover lightbox (full-size view)
  // ---------------------
  function isCoverLightboxOpen() {
    return !!(els.coverLightbox && !els.coverLightbox.hidden);
  }

  function openCoverLightbox() {
    if (!els.coverLightbox || !els.coverLightboxImg || !els.coverImg) return;
    if (!els.coverWrap || els.coverWrap.hidden) return;

    const src = (els.coverImg.currentSrc || els.coverImg.src || (els.coverImg.dataset ? els.coverImg.dataset.coverSrc : "")) || "";
    if (!src) return;

    try { els.coverLightboxImg.src = src; } catch {}
    try { els.coverLightboxImg.alt = els.coverImg.alt || ""; } catch {}

    try { els.coverLightbox.hidden = false; } catch {}
    try { els.coverLightbox.removeAttribute("aria-hidden"); } catch {}
    try { document.body.classList.add("isCoverLightboxOpen"); } catch {}

    // Focus for keyboard users (Escape closes)
    try { els.coverLightbox.focus(); } catch {}
  }

  function closeCoverLightbox() {
    if (!els.coverLightbox || els.coverLightbox.hidden) return;
    try { els.coverLightbox.hidden = true; } catch {}
    try { els.coverLightbox.setAttribute("aria-hidden", "true"); } catch {}
    try { document.body.classList.remove("isCoverLightboxOpen"); } catch {}
    try { els.coverLightboxImg && els.coverLightboxImg.removeAttribute("src"); } catch {}
    try { if (els.coverLightboxImg) els.coverLightboxImg.alt = ""; } catch {}
  }



  let _metaBaseText = "";
  let _metaErrorTimer = null;

  function setMeta(text, opts = {}) {
    if (!els.meta) return;
    els.meta.textContent = text;
    if (!opts || opts.base !== false) {
      _metaBaseText = String(text || "");
    }
  }

  function clearMetaError() {
    if (!els.meta) return;
    if (_metaErrorTimer) {
      window.clearTimeout(_metaErrorTimer);
      _metaErrorTimer = null;
    }
    els.meta.classList.remove("isError");
  }

  function flashMetaError(text, ms = 5000) {
    if (!els.meta) return;
    clearMetaError();
    els.meta.textContent = String(text || "");
    try { announce(text); } catch {}
    els.meta.classList.add("isError");
    _metaErrorTimer = window.setTimeout(() => {
      _metaErrorTimer = null;
      els.meta.classList.remove("isError");
      if (_metaBaseText) els.meta.textContent = _metaBaseText;
    }, ms);
  }
  function showFatalError(err) {
    const msg = (err && err.message) ? String(err.message) : String(err);

    try { setTitle(t("errorTitle")); } catch { try { setTitle("Player error"); } catch {} }

    // Make sure we do not leave the user on a forever "Loading…" state.
    try {
      const prefix = t("errorLoading");
      setMeta(prefix ? `${prefix} ${msg}`.trim() : msg);
    } catch {
      try { setMeta(msg); } catch {}
    }

    // Disable interaction in a fatal state.
    try { setUiLocked(true); } catch {}
    try { if (els.playPauseBtn) els.playPauseBtn.disabled = true; } catch {}
    try { if (els.seek) els.seek.disabled = true; } catch {}

    // Close any open drawers/menus.
    try { if (els.optionsPanel) els.optionsPanel.hidden = true; } catch {}
    try { if (els.chaptersMenu) els.chaptersMenu.hidden = true; } catch {}
    try { if (els.sleepMenu) els.sleepMenu.hidden = true; } catch {}
  }


  function setChaptersExpanded(expanded) {
    const v = expanded ? "true" : "false";
    try { if (els.chaptersBtn) els.chaptersBtn.setAttribute("aria-expanded", v); } catch {}
    try { if (els.focusChaptersBtn) els.focusChaptersBtn.setAttribute("aria-expanded", v); } catch {}
  }

  function setOptionsExpanded(expanded) {
    const v = expanded ? "true" : "false";
    try { if (els.optionsBtn) els.optionsBtn.setAttribute("aria-expanded", v); } catch {}
    try { if (els.focusOptionsBtn) els.focusOptionsBtn.setAttribute("aria-expanded", v); } catch {}
  }

  function closeChapters() {
    if (els.chaptersMenu) els.chaptersMenu.hidden = true;
    setChaptersExpanded(false);
  }

  function closeOptions() {
    if (els.optionsPanel) els.optionsPanel.hidden = true;
    setOptionsExpanded(false);
  }

  function setSleepExpanded(expanded) {
    const v = expanded ? "true" : "false";
    try { if (els.sleepBtn) els.sleepBtn.setAttribute("aria-expanded", v); } catch {}
  }

  function closeSleepMenu() {
    if (els.sleepMenu) els.sleepMenu.hidden = true;
    setSleepExpanded(false);
  }

  const SLEEP_DURATIONS_MIN = [5, 10, 15, 30, 45, 60, 90, 120];

  function sleepTimerIsActive() { return !!sleepTimeout; }

  function sleepRemainingMs() {
    if (!sleepTimerIsActive()) return 0;
    return Math.max(0, (sleepEndAtMs || 0) - Date.now());
  }

  function sleepRemainingMinutes() {
    const ms = sleepRemainingMs();
    return ms > 0 ? Math.ceil(ms / 60000) : 0;
  }

  function stopSleepTicker() {
    try { if (sleepTicker) window.clearInterval(sleepTicker); } catch {}
    sleepTicker = null;
  }

  function updateSleepUi() {
    if (!els.sleepBtn) return;

    const baseLabel = t("sleepTimer");
    if (sleepTimerIsActive()) {
      try { els.sleepBtn.classList.add("isActive"); } catch {}
      const rem = sleepRemainingMinutes();
      const tip = rem ? `${baseLabel}: ${fmt(t("sleepTimerOption"), { m: rem })}` : baseLabel;
      try { els.sleepBtn.setAttribute("aria-label", tip); } catch {}
      try { setTooltip(els.sleepBtn, tip); } catch {}
    } else {
      try { els.sleepBtn.classList.remove("isActive"); } catch {}
      try { els.sleepBtn.setAttribute("aria-label", baseLabel); } catch {}
      try { setTooltip(els.sleepBtn, baseLabel); } catch {}
    }

    // Update menu checkmarks (radio semantics)
    try {
      if (!els.sleepList) return;
      const items = els.sleepList.querySelectorAll("button.sleepItem");
      items.forEach((btn) => {
        const m = parseInt(btn.dataset.minutes || "0", 10) || 0;
        const checked = sleepTimerIsActive() ? (m === sleepMinutes) : (m === 0);
        btn.setAttribute("aria-checked", checked ? "true" : "false");
      });
    } catch {}
  }

  function refreshSleepMenuLabels() {
    if (!els.sleepList) return;
    const items = els.sleepList.querySelectorAll("button.sleepItem");
    items.forEach((btn) => {
      const m = parseInt(btn.dataset.minutes || "0", 10) || 0;
      const label = (m <= 0) ? t("sleepTimerOff") : fmt(t("sleepTimerOption"), { m });
      const labelEl = btn.querySelector(".sleepLabel");
      const pillEl = btn.querySelector(".sleepPill");
      if (labelEl) labelEl.textContent = label;
      if (pillEl) {
        if (m <= 0) {
          pillEl.textContent = "";
          pillEl.hidden = true;
        } else {
          pillEl.hidden = false;
          pillEl.textContent = fmt(t("sleepTimerOption"), { m });
        }
      }
    });
  }

  function ensureSleepMenuBuilt() {
    if (!els.sleepList) return;
    if (els.sleepList.dataset.built === "1") {
      refreshSleepMenuLabels();
      updateSleepUi();
      return;
    }
    els.sleepList.dataset.built = "1";

    const buildItem = (minutes) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sleepItem";
      btn.setAttribute("role", "menuitemradio");
      btn.dataset.minutes = String(minutes);

      const labelSpan = document.createElement("span");
      labelSpan.className = "sleepLabel";

      const pillSpan = document.createElement("span");
      pillSpan.className = "sleepPill";

      btn.appendChild(labelSpan);
      btn.appendChild(pillSpan);

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        startSleepTimer(minutes);
        closeSleepMenu();
      });

      els.sleepList.appendChild(btn);
    };

    SLEEP_DURATIONS_MIN.forEach(buildItem);
    buildItem(0); // Off

    refreshSleepMenuLabels();
    updateSleepUi();
  }

  async function fadeOutAndPause() {
    const audio = els.audio;
    if (!audio) return;

    // iOS Safari blocks programmatic volume control, so we only do a best-effort pause.
    if (IS_IOS) {
      try { audio.pause(); } catch {}
      return;
    }

    const startVol = (typeof audio.volume === "number" && isFinite(audio.volume)) ? audio.volume : 1;
    const fadeMs = CONFIG.SLEEP_FADE_MS || 2200;
    const steps = 12;
    const stepMs = Math.max(50, Math.floor(fadeMs / steps));

    try {
      for (let i = 1; i <= steps; i++) {
        const v = clamp(startVol * (1 - (i / steps)), 0, 1);
        try { audio.volume = v; } catch {}
        await sleep(stepMs);
      }
    } catch {}

    try { audio.pause(); } catch {}
    try { applyVolume(startVol); } catch {}
  }

  function cancelSleepTimer(silent = false) {
    try { if (sleepTimeout) window.clearTimeout(sleepTimeout); } catch {}
    sleepTimeout = null;
    sleepEndAtMs = 0;
    sleepMinutes = 0;
    stopSleepTicker();
    updateSleepUi();
    if (!silent) {
      try { showToast(t("sleepTimerCanceled"), "info"); } catch {}
    }
  }

  function startSleepTimer(minutes) {
    const m = parseInt(minutes, 10) || 0;
    if (m <= 0) {
      cancelSleepTimer(false);
      return;
    }

    // Reset and arm
    cancelSleepTimer(true);
    sleepMinutes = m;
    sleepEndAtMs = Date.now() + (m * 60 * 1000);

    sleepTimeout = window.setTimeout(async () => {
      // Mark inactive first so UI doesn't show stale remaining time
      sleepTimeout = null;
      stopSleepTicker();
      try { showToast(t("sleepTimerEnded"), "info"); } catch {}
      try { await fadeOutAndPause(); } catch {}
      sleepEndAtMs = 0;
      sleepMinutes = 0;
      updateSleepUi();
    }, m * 60 * 1000);

    // Update tooltip periodically (remaining minutes)
    sleepTicker = window.setInterval(() => {
      updateSleepUi();
    }, CONFIG.SLEEP_TICK_INTERVAL_MS || 30000);

    updateSleepUi();
    try { showToast(fmt(t("sleepTimerSet"), { m }), "success"); } catch {}
  }

  function toggleSleepMenu() {
    if (!els.sleepMenu) return;
    const willOpen = !!els.sleepMenu.hidden;
    if (willOpen) {
      closeChapters();
      closeOptions();
      ensureSleepMenuBuilt();
      els.sleepMenu.hidden = false;
      setSleepExpanded(true);
    } else {
      closeSleepMenu();
    }
  }

  function toggleChapters() {
    if (!els.chaptersMenu) return;
    const willOpen = !!els.chaptersMenu.hidden;
    if (willOpen) {
      closeOptions();
      closeSleepMenu();
      els.chaptersMenu.hidden = false;
      setChaptersExpanded(true);
      try { void ensureChaptersReady(); } catch {}
    } else {
      closeChapters();
    }
  }

  function toggleOptions() {
    if (!els.optionsPanel) return;
    const willOpen = !!els.optionsPanel.hidden;
    if (willOpen) {
      closeChapters();
      closeSleepMenu();
      els.optionsPanel.hidden = false;
      setOptionsExpanded(true);
    } else {
      closeOptions();
    }
  }

  // Expanded ("Focus") mode in v132 is a simple in-card layout change.
  function setExpanded(next) {
    const v = !!next;
    // The player always runs in Expanded / Focus mode.
    // Collapsing to the mini mode is disabled.
    if (!v) return;

    isExpanded = true;
    try { if (els.playerCard) els.playerCard.classList.add("isExpanded"); } catch {}
    try { if (els.focusRow) els.focusRow.hidden = false; } catch {}
    try { applySkipSeconds(skipSeconds); } catch {}
  }

  function toggleExpanded() {
    setExpanded(!isExpanded);
  }

  function getAvailableLangCodes(cfg) { return (cfg && cfg._availableLangCodes && cfg._availableLangCodes.length) ? cfg._availableLangCodes : Object.keys((cfg && cfg.languages) || {}); }

  function buildQualityOptionsForLanguage(langCfg) {
    const out = [];
    const sources = langCfg.sources || {};
    // Prefer AAC on iOS/iPadOS (WebM/Opus support in Safari can be inconsistent).
    const codecOrder = preferredCodecOrder();

    for (const codec of codecOrder) {
      const byBr = sources[codec] || {};
      for (const bitrateStr of Object.keys(byBr)) {
        const bitrate = parseInt(bitrateStr, 10);
        const url = byBr[bitrateStr];
        if (!url) continue;

        const ext = extFromPath(url);
        const mime = mimeFor(codec, ext);
        const confidence = mime ? canPlay(mime) : 0;

        out.push({
          id: `${codec}-${bitrate}`,
          codec,
          bitrate,
          url,
          ext,
          supported: confidence > 0,
          confidence
        });
      }
    }

    const codecRank = codecRankFromOrder(codecOrder);
    out.sort((a, b) => {
      if (codecRank[a.codec] !== codecRank[b.codec]) return codecRank[a.codec] - codecRank[b.codec];
      if (a.bitrate !== b.bitrate) return b.bitrate - a.bitrate;
      return b.confidence - a.confidence;
    });

    return out;
  }

  
function chooseDefaultQuality(qualityOptions) {
    const list = Array.isArray(qualityOptions) ? qualityOptions : [];
    const codecOrder = preferredCodecOrder();
    const codecRank = codecRankFromOrder(codecOrder);

    // Pick the best available (highest bitrate) within the preferred codec family.
    for (const codec of codecOrder) {
      const candidates = list.filter(o => o && o.codec === codec && o.supported && o.exists);
      if (!candidates.length) continue;
      candidates.sort((a, b) => {
        const ba = (typeof a.bitrate === "number" ? a.bitrate : 0);
        const bb = (typeof b.bitrate === "number" ? b.bitrate : 0);
        if (bb !== ba) return bb - ba;
        return (b.confidence || 0) - (a.confidence || 0);
      });
      return candidates[0] || null;
    }

    // Fallback: any supported+existing option.
    const any = list.filter(o => o && o.supported && o.exists);
    if (any.length) {
      any.sort((a, b) => {
        const ra = (codecRank[a.codec] ?? 99);
        const rb = (codecRank[b.codec] ?? 99);
        if (ra !== rb) return ra - rb;
        const ba = (typeof a.bitrate === "number" ? a.bitrate : 0);
        const bb = (typeof b.bitrate === "number" ? b.bitrate : 0);
        if (bb !== ba) return bb - ba;
        return (b.confidence || 0) - (a.confidence || 0);
      });
      return any[0] || null;
    }

    return list[0] || null;
  }

function populateLanguageSelect(cfg, selectedLang) {
    els.langSelect.innerHTML = "";
    for (const code of getAvailableLangCodes(cfg)) {
      const langCfg = cfg.languages[code];
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = langCfg.label || code;
      if (code === selectedLang) opt.selected = true;
      els.langSelect.appendChild(opt);
    }
  }

  function populateQualitySelect(qualityOptions, selectedId, debugShowAllQualities) {
    els.qualitySelect.innerHTML = "";

    // When debug.showAllQualities=true, the dropdown can contain duplicates across codecs.
    // Make options visually distinct by including bitrate + container/format.
    function extToType(ext, codec) {
      const e = String(ext || "").toLowerCase();
      if (e === "m4a") return "M4A";
      if (e === "webm") return "WEBM";
      if (e === "mp3") return "MP3";
      // Fallback: infer from codec
      if (codec === "aac") return "M4A";
      if (codec === "opus") return "WEBM";
      if (codec === "mp3") return "MP3";
      return e ? e.toUpperCase() : "";
    }

    // Ensure "best" qualities render first. Do NOT rely on object key ordering
    // (integer-like keys can be reordered by the JS engine).
    const codecRank = codecRankFromOrder(preferredCodecOrder());
    const sorted = [...(qualityOptions || [])].sort((a, b) => {
      const ra = codecRank[a.codec] ?? 99;
      const rb = codecRank[b.codec] ?? 99;
      if (ra !== rb) return ra - rb;
      if (a.bitrate !== b.bitrate) return b.bitrate - a.bitrate;
      // Prefer higher confidence when bitrates tie
      return (b.confidence || 0) - (a.confidence || 0);
    });

    const showDetails = !!debugShowAllQualities;

    for (const q of sorted) {
      const opt = document.createElement("option");
      opt.value = q.id;
      // Quality selector labels are human-readable without bitrate.
      // In debug mode we append bitrate + format so duplicates are distinguishable.
      const base = qualityDisplayLabel(q, { includeBitrate: false });
      if (showDetails) {
        const parts = [];
        if (typeof q.bitrate === "number" && q.bitrate > 0) parts.push(`${q.bitrate} kb/s`);
        const ft = extToType(q.ext, q.codec);
        if (ft) parts.push(ft);
        opt.textContent = parts.length ? `${base} — ${parts.join(" · ")}` : base;
      } else {
        opt.textContent = base;
      }
      opt.disabled = !q.supported;
      if (q.id === selectedId) opt.selected = true;
      els.qualitySelect.appendChild(opt);
    }
  }

  function absoluteUrl(basePath, maybeRelative) {
    if (!maybeRelative) return maybeRelative;
    if (/^(https?:)?\/\//i.test(maybeRelative) || maybeRelative.startsWith("/")) return maybeRelative;
    return basePath.replace(/\/+$/, "/") + maybeRelative.replace(/^\/+/, "");
  }

  function buildUrlFor(langCfg, relOrAbs) {
    const basePath = langCfg.basePath || "";
    return absoluteUrl(basePath, relOrAbs);
  }

// --- Static asset availability (hide missing languages/qualities) ----------
function normalizeFetchUrl(input) {
  try {
    // Ensure we never keep username/password from the document URL (e.g. https://user:pass@host/)
    const u = new URL(input, window.location.origin + window.location.pathname);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return input;
  }
}


const _urlExistsCache = new Map();

let _probeDisabled = false;
let _probeFailStreak = 0;
// Some environments (notably some Firefox/PC + Basic Auth setups) return 404 for fetch() probes
// even when files exist and are playable via <audio>. If we detect that pattern, we stop probing
// and assume URLs exist to avoid hiding all options.
try {
  _probeDisabled = sessionStorage.getItem("cap_disable_probe") === "1";
  // Optional: allow manual reset by adding ?resetProbe=1
  try {
    const sp = new URLSearchParams(location.search);
    if (sp.get("resetProbe") === "1") {
      sessionStorage.removeItem("cap_disable_probe");
      _probeDisabled = false;
      _probeFailStreak = 0;
    }
  } catch {}

} catch {}

function _recordProbeResult(status) {
  if (_probeDisabled) return;
  if (status === 200 || status === 206 || status === 401 || status === 403) {
    _probeFailStreak = 0;
    return;
  }
  if (status === 404) {
    _probeFailStreak += 1;
    if (_probeFailStreak >= 3) {
      _probeDisabled = true;
      try { sessionStorage.setItem("cap_disable_probe", "1"); } catch {}
    }
  }
}


async function audioProbeExists(url, timeoutMs = 3500) {
  // Uses the media pipeline (not fetch/XHR) which works better with some auth/proxy setups,
  // and correctly fails fast when a file is genuinely missing.
  return await new Promise((resolve) => {
    try {
      const a = document.createElement("audio");
      a.preload = "metadata";
      a.muted = true;

      let settled = false;
      const cleanup = () => {
        try { a.removeEventListener("loadedmetadata", onOk); } catch {}
        try { a.removeEventListener("canplay", onOk); } catch {}
        try { a.removeEventListener("error", onErr); } catch {}
        try { a.src = ""; a.load(); } catch {}
      };

      const finish = (ok) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        cleanup();
        resolve(ok);
      };

      const onOk = () => finish(true);
      const onErr = () => finish(false);

      const timer = window.setTimeout(() => finish(false), timeoutMs);

      a.addEventListener("loadedmetadata", onOk, { once: true });
      a.addEventListener("canplay", onOk, { once: true });
      a.addEventListener("error", onErr, { once: true });

      a.src = url;
      a.load();
    } catch {
      resolve(false);
    }
  });
}

async function urlExists(url) {
  if (!url) return false;

  const safeUrl = normalizeFetchUrl(url);
  if (_urlExistsCache.has(safeUrl)) return _urlExistsCache.get(safeUrl);

  const p = (async () => {
    // If probing is disabled (fetch/XHR unreliable), fall back to media-pipeline probe.
    if (_probeDisabled) {
      return await audioProbeExists(safeUrl);
    }

    // 1) Try HEAD (fast)
    try {
      const r = await fetch(safeUrl, { method: "HEAD", cache: "no-store", credentials: "include" });
      _recordProbeResult(r.status);
      if (r.ok) return true;
      if (r.status === 401 || r.status === 403) return true;

      // Some environments (and some proxies/caches) return 404 for fetch() probes
      // even when the media is playable via <audio>. If we see a 404, verify once
      // via the media pipeline before declaring the file missing.
      if (r.status === 404) {
        const ok = await audioProbeExists(safeUrl);
        if (ok) {
          _probeDisabled = true;
          try { sessionStorage.setItem("cap_disable_probe", "1"); } catch {}
          _probeFailStreak = 0;
          return true;
        }
      }

      // If we just disabled probing due to repeated 404s, fall back to media probe.
      if (_probeDisabled) return await audioProbeExists(safeUrl);
    } catch {
      // If fetch fails (CORS/proxy/auth oddities), try media probe.
      return await audioProbeExists(safeUrl);
    }

    // 2) Fallback to a tiny ranged GET
    try {
      const r = await fetch(safeUrl, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        cache: "no-store",
        credentials: "include",
      });
      _recordProbeResult(r.status);
      if (r.ok) return true;
      if (r.status === 401 || r.status === 403) return true;

      // Same 404 verification for the ranged GET path.
      if (r.status === 404) {
        const ok = await audioProbeExists(safeUrl);
        if (ok) {
          _probeDisabled = true;
          try { sessionStorage.setItem("cap_disable_probe", "1"); } catch {}
          _probeFailStreak = 0;
          return true;
        }
      }

      if (_probeDisabled) return await audioProbeExists(safeUrl);
      return false;
    } catch {
      return await audioProbeExists(safeUrl);
    }
  })();

  _urlExistsCache.set(safeUrl, p);
  return p;
}



async function enrichQualityOptionsWithExists(langCfg, qualityOptions) {
  await Promise.all(
    (qualityOptions || []).map(async (o) => {
      const abs = buildUrlFor(langCfg, o.url);
      o.exists = await urlExists(abs);
    })
  );
  return qualityOptions;
}
// --------------------------------------------------------------------------


async function loadChapters(chaptersUrl) {
  cues = [];
  activeCueIndex = -1;
  els.chaptersList.innerHTML = "";

  if (!chaptersUrl) return;

  const safeChaptersUrl = normalizeFetchUrl(chaptersUrl);

  // Prefer native WebVTT parsing via <track> for correct timestamps.
  // Fallback to fetch+parse if track cues are unavailable.
  const cueObjs = await (async () => {
    try {
      const trackEl = els.chaptersTrack;
      const tt = trackEl.track;
      tt.mode = "hidden";
      trackEl.src = safeChaptersUrl;

      const loaded = await new Promise((resolve) => {
        const timeout = window.setTimeout(() => {
          cleanup();
          resolve(false);
        }, 4000);

        const onLoad = () => { cleanup(); resolve(true); };
        const onError = () => { cleanup(); resolve(false); };

        function cleanup() {
          window.clearTimeout(timeout);
          trackEl.removeEventListener("load", onLoad);
          trackEl.removeEventListener("error", onError);
        }

        trackEl.addEventListener("load", onLoad);
        trackEl.addEventListener("error", onError);
      });

      if (loaded && tt && tt.cues && tt.cues.length) return Array.from(tt.cues);
    } catch {}
    return null;
  })();

  let normalized = null;

  if (cueObjs) {
    normalized = cueObjs.map(c => ({
      start: Number(c.startTime),
      end: (typeof c.endTime === "number" && isFinite(c.endTime)) ? Number(c.endTime) : null,
      title: String(c.text || "Chapter").replace(/\s+/g, " ").trim() || "Chapter"
    }));
  } else {
    const res = await fetchWithRetry(safeChaptersUrl, { cache: "no-store", credentials: "include" });
    if (!res.ok) throw new Error(`Failed to load chapters: ${res.status}`);
    const parsed = parseVtt(await res.text());
    normalized = parsed.map(c => ({
      start: Number(c.start),
      end: (typeof c.end === "number" && isFinite(c.end)) ? Number(c.end) : null,
      title: String(c.title || "Chapter").replace(/\s+/g, " ").trim() || "Chapter"
    }));
  }

  cues = (normalized || []).filter(c => isFinite(c.start) && c.start >= 0).sort((a, b) => a.start - b.start);

  if (!cues.length) {
    const item = document.createElement("div");
    item.className = "chapterItem";

    const titleEl = document.createElement("div");
    titleEl.className = "chapterTitle";
    titleEl.textContent = t("noChaptersFound");

    const timeEl = document.createElement("div");
    timeEl.className = "chapterTime";
    timeEl.textContent = "—";

    item.appendChild(titleEl);
    item.appendChild(timeEl);

    els.chaptersList.appendChild(item);
    return;
  }

  for (let idx = 0; idx < cues.length; idx++) {
    const cue = cues[idx];
    const item = document.createElement("div");
    item.className = "chapterItem";
    item.setAttribute("role", "menuitem");
    item.tabIndex = 0;
    item.dataset.index = String(idx);

    const titleEl = document.createElement("div");
    titleEl.className = "chapterTitle";
    titleEl.textContent = cue.title;

    const timeEl = document.createElement("div");
    timeEl.className = "chapterTime";
    timeEl.textContent = formatTime(cue.start);

    item.appendChild(titleEl);
    item.appendChild(timeEl);

    const activate = () => {
      if (isUiBusy || _uiLockCount > 0) return;

      const dur = getKnownDuration();
        const target = cue.start;
        const t = (dur && dur > 0) ? clamp(target, 0, Math.max(0, dur - 0.01)) : Math.max(0, target);
        seekTo(t, { resumeIfPlaying: true, persist: true });
        closeChapters();
      };

    item.addEventListener("click", activate);
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
    });

    els.chaptersList.appendChild(item);
  }
}

function showChaptersLoadingState() {
  try {
    cues = [];
    activeCueIndex = -1;
    els.chaptersList.innerHTML = "";

    const item = document.createElement("div");
    item.className = "chapterItem";

    const titleEl = document.createElement("div");
    titleEl.className = "chapterTitle";
    titleEl.textContent = t("loadingChapters");

    const timeEl = document.createElement("div");
    timeEl.className = "chapterTime";
    timeEl.textContent = "…";

    item.appendChild(titleEl);
    item.appendChild(timeEl);
    els.chaptersList.appendChild(item);
  } catch {}
}

function renderNoChaptersState() {
  try {
    cues = [];
    activeCueIndex = -1;
    els.chaptersList.innerHTML = "";

    const item = document.createElement("div");
    item.className = "chapterItem";

    const titleEl = document.createElement("div");
    titleEl.className = "chapterTitle";
    titleEl.textContent = t("noChaptersFound");

    const timeEl = document.createElement("div");
    timeEl.className = "chapterTime";
    timeEl.textContent = "—";

    item.appendChild(titleEl);
    item.appendChild(timeEl);
    els.chaptersList.appendChild(item);
  } catch {}
}

async function ensureChaptersReady() {
  if (chaptersLoaded) return;
  if (chaptersLoadInFlight) return chaptersLoadInFlight;

  if (!chaptersUrlPending) {
    renderNoChaptersState();
    chaptersLoaded = true;
    chaptersLoadError = false;
    try { updateChapterNavButtons(); } catch {}
    return;
  }

  chaptersLoadInFlight = (async () => {
    showChaptersLoadingState();
    try {
      await loadChapters(chaptersUrlPending);
      chaptersLoaded = true;
      chaptersLoadError = false;
      // Update selection highlight immediately
      try { markActiveChapterByTime(lastKnownTime || 0); } catch {}
    } catch (e) {
      console.warn("Chapters load failed; continuing without chapters.", e);
      chaptersLoaded = true;
      chaptersLoadError = true;
      renderNoChaptersState();
      try { showToast(t("chaptersLoadFailed"), "warning"); } catch {}    } finally {
      chaptersLoadInFlight = null;
      try { updateChapterNavButtons(); } catch {}
    }
  })();

  return chaptersLoadInFlight;
}

function updateChapterNavButtons() {
  const haveCfg = !!chaptersUrlPending;
  let disabled = !haveCfg;
  if (haveCfg && chaptersLoaded) {
    disabled = (!cues.length) || !!chaptersLoadError;
  }
  const btns = [els.focusPrevChapterBtn, els.focusNextChapterBtn];
  for (const b of btns) {
    if (!b) continue;
    b.disabled = disabled;
    try { b.setAttribute('aria-disabled', disabled ? 'true' : 'false'); } catch {}
  }
}

/** Determine active chapter index for a given time (seconds). */
function chapterIndexForTime(timeSec) {
  if (!cues.length) return -1;
  const t = (typeof timeSec === 'number' && isFinite(timeSec)) ? timeSec : 0;
  let idx = -1;
  for (let i = 0; i < cues.length; i++) {
    if (t + 0.05 >= cues[i].start) idx = i;
    else break;
  }
  return idx;
}

async function goToPrevChapter() {
  if (!chaptersUrlPending) {
    updateChapterNavButtons();
    try { showToast(t('noChaptersFound'), 'info'); } catch {}
    return;
  }
  await ensureChaptersReady();
  updateChapterNavButtons();
  if (!cues.length) {
    try { showToast(t('noChaptersFound'), chaptersLoadError ? 'warning' : 'info'); } catch {}
    return;
  }
  const cur = (els.audio && isFinite(els.audio.currentTime)) ? els.audio.currentTime : (lastKnownTime || 0);
  const idx = chapterIndexForTime(cur);
  if (idx < 0) {
    seekTo(cues[0].start, { resumeIfPlaying: true, persist: true });
    return;
  }
  // 3-second snap rule: if we're more than 3s into the current chapter, go to its start;
  // otherwise go to the previous chapter.
  const into = cur - cues[idx].start;
  const targetIdx = (into > 3) ? idx : Math.max(0, idx - 1);
  seekTo(cues[targetIdx].start, { resumeIfPlaying: true, persist: true });
}

async function goToNextChapter() {
  if (!chaptersUrlPending) {
    updateChapterNavButtons();
    try { showToast(t('noChaptersFound'), 'info'); } catch {}
    return;
  }
  await ensureChaptersReady();
  updateChapterNavButtons();
  if (!cues.length) {
    try { showToast(t('noChaptersFound'), chaptersLoadError ? 'warning' : 'info'); } catch {}
    return;
  }
  const cur = (els.audio && isFinite(els.audio.currentTime)) ? els.audio.currentTime : (lastKnownTime || 0);
  let nextIdx = -1;
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].start > cur + 0.05) { nextIdx = i; break; }
  }
  if (nextIdx < 0) return;
  seekTo(cues[nextIdx].start, { resumeIfPlaying: true, persist: true });
}




  function markActiveChapterByTime(t) {
    if (!cues.length) return;
    let idx = -1;
    for (let i = 0; i < cues.length; i++) {
      if (t + 0.05 >= cues[i].start) idx = i;
      else break;
    }
    if (idx === activeCueIndex) return;
    activeCueIndex = idx;

    try {
      const cueTitle = (activeCueIndex >= 0 && cues[activeCueIndex]) ? cues[activeCueIndex].title : "";
      setMediaChapterTitle(cueTitle);
    } catch {}

    const items = els.chaptersList.querySelectorAll(".chapterItem");
    items.forEach((el, i) => el.setAttribute("aria-current", String(i === activeCueIndex)));
  }


// iOS Safari: resuming playback AFTER async work (fetch/probing) is often blocked.
// For language/quality switches we can do a synchronous source switch and call play()
// in the same user gesture, then apply the seek once metadata is available.
function iosImmediateSwitchSource(audioUrl, mime, targetTime, shouldPlay) {
  try { setUiBusy(true); } catch {}
  try { els.audio.pause(); } catch {}

  // Ensure playback speed is re-applied on iOS (rate can reset on some source switches)
  try {
    const ui = readUiPrefs();
    if (ui && typeof ui.playbackRate === "number" && isFinite(ui.playbackRate)) {
      applyPlaybackRate(ui.playbackRate);
    }
  } catch {}

  // Update state immediately for chapter highlighting and future switches
  const t = (typeof targetTime === "number" && isFinite(targetTime) && targetTime >= 0) ? targetTime : 0;
  lastKnownTime = t;
  pendingSeekTime = t;
  sourceSwitchTargetTime = t;
  // Replace <source> (iOS immediate) and load
  audioPrimed = true;
  try { els.audio.preload = "auto"; } catch {}
  try { els.audio.dataset.currentMime = mime || ""; } catch {}
  try { Array.from(els.audio.querySelectorAll("source")).forEach(s => s.remove()); } catch {}
  try { els.audio.removeAttribute("src"); } catch {}
  const src = document.createElement("source");
  const safeUrl = normalizeFetchUrl(audioUrl);
  src.src = safeUrl;
  if (mime) src.type = mime;
  els.audio.insertBefore(src, els.chaptersTrack);
  try { els.audio.load(); } catch {}

  // If user intended playback, call play() immediately (user-gesture safe on iOS)
  if (shouldPlay) {
    try { userWantsPlaying = true; } catch {}
    try { els.audio.play().catch(() => {}); } catch {}
  }

  const applySeek = () => {
    // iOS may reset playbackRate after src/load; enforce persisted value again.
    try { reapplyPlaybackRateFromPrefs(); } catch {}
    try {
      // Apply the seek after metadata; works on iOS
      if (isFinite(els.audio.duration)) {
        const dur = els.audio.duration;
        const clamped = (dur && dur > 0) ? clamp(t, 0, Math.max(0, dur - 0.01)) : Math.max(0, t);
        try { els.audio.currentTime = clamped; } catch {}
      } else {
        try { els.audio.currentTime = t; } catch {}
      }
    } catch {}
    try { updateTimes(); } catch {}
    try { markActiveChapterByTime(t); } catch {}
    try { saveProgressAt(t); } catch {}
    try { setUiBusy(false); } catch {}
  };

  // Wait for metadata/canplay once; then apply seek
  els.audio.addEventListener("loadedmetadata", applySeek, { once: true });
  els.audio.addEventListener("canplay", applySeek, { once: true });

  // Safety: unlock UI even if iOS never fires events
  window.setTimeout(() => { try { setUiBusy(false); } catch {} }, 2500);
}

function setAudioSource(url, mime, desiredStartTime, onErrorRevert, onSuccess) {
  audioPrimed = true;
  isSourceSwitching = true;
  setUiBusy(true);
  const token = String(Date.now()) + ":" + Math.random().toString(16).slice(2);
  els.audio.dataset.switchToken = token;

  const wasPlaying = !els.audio.paused && !els.audio.ended;
  const wantPlay = (IS_IOS ? userWantsPlaying : wasPlaying);

  const existingTime = isFinite(els.audio.currentTime) ? els.audio.currentTime : 0;
  const targetTime = (typeof desiredStartTime === "number" && isFinite(desiredStartTime) && desiredStartTime >= 0)
    ? desiredStartTime
    : existingTime;

  // Pause immediately; ensures we actually swap the buffer
  try { els.audio.pause(); } catch {}

  // Replace <source>
  Array.from(els.audio.querySelectorAll("source")).forEach(s => s.remove());
  const src = document.createElement("source");
  const safeUrl = normalizeFetchUrl(url);
  src.src = safeUrl;
  if (mime) src.type = mime;
  els.audio.insertBefore(src, els.chaptersTrack);

  // Apply persisted playback speed before load/play
  try {
    const ui = readUiPrefs();
    if (ui && typeof ui.volume === "number" && isFinite(ui.volume)) {
      applyVolume(ui.volume);
    }
    if (ui && typeof ui.playbackRate === "number" && isFinite(ui.playbackRate)) {
      applyPlaybackRate(ui.playbackRate);
    }
  } catch {}

  els.audio.load();

  // Some browsers reset playbackRate during/after load when switching sources.
  // Re-apply it once metadata is available and once playback starts.
  try {
    els.audio.addEventListener("loadedmetadata", reapplyPlaybackRateFromPrefs, { once: true });
    els.audio.addEventListener("canplay", reapplyPlaybackRateFromPrefs, { once: true });
    els.audio.addEventListener("playing", reapplyPlaybackRateFromPrefs, { once: true });
  } catch {}

  let finalized = false;
  let pollTimer = null;
  let timeoutTimer = null;

  const cleanup = () => {
    els.audio.removeEventListener("loadedmetadata", onReady);
    els.audio.removeEventListener("loadeddata", onReady);
    els.audio.removeEventListener("canplay", onReady);
    els.audio.removeEventListener("error", onErr);
    try { src.removeEventListener("error", onErr); } catch {}
    if (pollTimer) window.clearInterval(pollTimer);
    if (timeoutTimer) window.clearTimeout(timeoutTimer);
  };

  const finalizeSuccess = () => {
    if (finalized) return;
    finalized = true;
    cleanup();
    isSourceSwitching = false;

    try { clearMetaError(); } catch {}

    const dur = getKnownDuration();
    const effectiveTarget = (typeof sourceSwitchTargetTime === "number" && isFinite(sourceSwitchTargetTime) && sourceSwitchTargetTime >= 0)
      ? sourceSwitchTargetTime
      : targetTime;
    const nt = (dur && dur > 0) ? clamp(effectiveTarget, 0, Math.max(0, dur - 0.01)) : Math.max(0, effectiveTarget);

    lastKnownTime = nt;
    pendingSeekTime = null;
    sourceSwitchTargetTime = null;

    // Use robust seek helper (iOS-friendly)
    seekTo(nt, { resumeIfPlaying: true, persist: true, forcePlay: wasPlaying });

    // Some browsers reset playbackRate during src swaps or the subsequent seek.
    try { reapplyPlaybackRateFromPrefs(); } catch {}

    const _apClear = () => { try { els.audio.autoplay = false; } catch {} };
    els.audio.addEventListener("playing", _apClear, { once: true });
    window.setTimeout(_apClear, 2000);
    if (typeof onSuccess === "function") onSuccess();
  };

  const onReady = () => {
    if (els.audio.dataset.switchToken !== token) return;
    if (els.audio.readyState >= 1) finalizeSuccess();
  };

  const onErr = () => {
    if (els.audio.dataset.switchToken !== token) return;
    if (finalized) return;
    finalized = true;
    cleanup();
    isSourceSwitching = false;
    const effectiveTarget = (typeof sourceSwitchTargetTime === "number" && isFinite(sourceSwitchTargetTime) && sourceSwitchTargetTime >= 0)
      ? sourceSwitchTargetTime
      : targetTime;
    sourceSwitchTargetTime = null;
    if (typeof onErrorRevert === "function") onErrorRevert();
    try { flashMetaError(t("audioLoadError")); } catch {}
    try { showToast(t("audioLoadError"), "warning"); } catch {}
    setUiBusy(false);
    try { attemptCodecFallback(effectiveTarget, "source-error"); } catch {}
  };

  els.audio.addEventListener("loadedmetadata", onReady);
  els.audio.addEventListener("loadeddata", onReady);
  els.audio.addEventListener("canplay", onReady);
  els.audio.addEventListener("error", onErr);
  try { src.addEventListener("error", onErr); } catch {}

  const startMs = Date.now();
  pollTimer = window.setInterval(() => {
    if (els.audio.dataset.switchToken !== token) return;
    if (els.audio.error) { onErr(); return; }
    if (els.audio.readyState >= 1) { finalizeSuccess(); return; }
    if (els.audio.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) { onErr(); return; }
    if ((Date.now() - startMs) > 9000) {
      if (els.audio.readyState >= 1) finalizeSuccess();
      else onErr();
    }
  }, 250);

  timeoutTimer = window.setTimeout(() => {
    if (els.audio.dataset.switchToken !== token) return;
    if (finalized) return;
    if (els.audio.readyState >= 1) finalizeSuccess();
    else onErr();
  }, 10000);
}

function updatePlayButton() {
    const paused = !!(els.audio && els.audio.paused);
    if (els.playPauseBtn) {
      els.playPauseBtn.textContent = paused ? "▶︎" : "⏸︎";
      els.playPauseBtn.setAttribute("aria-label", paused ? t("play") : t("pause"));
    }
    updateMediaSessionPlaybackState();
  }

async function togglePlay() {
  if (els.audio.paused) {
    userWantsPlaying = true;
    // Unlock duration UI and allow the player to load the audio source on first Play.
    durationUnlocked = true;

    // Lazy audio: set the source only when Play is pressed.
    if (!audioPrimed && pendingAudio && pendingAudio.url) {
      try { setAudioSource(pendingAudio.url, pendingAudio.mime, pendingAudio.startTime); } catch {}
    }
    // iOS/iPadOS: if the user somehow ends up on Opus-in-WebM, prefer a safer fallback
    // while we still have a user gesture to start playback.
    try {
      if (IS_IOS && !IOS_PREFERS_OPUS && config && els.langSelect && els.qualitySelect) {
        const langCode = String(els.langSelect.value || config.defaultLanguage || "");
        const curId = String(els.qualitySelect.value || "");
        if (curId.startsWith("opus-")) {
          const fallback = findFallbackForOpus(langCode, curId);
          if (fallback) {
            applyQualityOption(langCode, fallback, getSafeCurrentTime(0), true);
            try { showToast(t("audioFallbackCompatible"), "info"); } catch {}
            return;
          }
        }
      }
    } catch {}
    await safePlay();
  } else {
    userWantsPlaying = false;
    try { els.audio.pause(); } catch {}
  }
}

async function safePlay(timeoutMs = 1400) {
  // iOS Safari can report "playing" but be stalled; verify playback actually starts.
  try {
    const p = els.audio.play();
    if (p && typeof p.then === "function") await p;
  } catch {
    try { els.audio.pause(); } catch {}
    updatePlayButton();
    try { await attemptCodecFallback(getSafeCurrentTime(0), "play() rejected"); } catch {}
    return false;
  }

  const started = await new Promise((resolve) => {
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      els.audio.removeEventListener("playing", onPlaying);
      els.audio.removeEventListener("timeupdate", onTime);
      els.audio.removeEventListener("pause", onPause);
      window.clearTimeout(t);
    };
    const onPlaying = () => { cleanup(); resolve(true); };
    const onTime = () => {
      if (isFinite(els.audio.currentTime) && els.audio.currentTime > 0) {
        cleanup(); resolve(true);
      }
    };
    const onPause = () => { cleanup(); resolve(false); };
    const t = window.setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);

    els.audio.addEventListener("playing", onPlaying);
    els.audio.addEventListener("timeupdate", onTime);
    els.audio.addEventListener("pause", onPause);
  });

  if (!started) {
    // Force a consistent paused state if playback didn't actually start.
    try { els.audio.pause(); } catch {}
    updatePlayButton();
    try { await attemptCodecFallback(getSafeCurrentTime(0), "playback start timeout"); } catch {}
    return false;
  }

  updatePlayButton();
  return true;
}


  function updateTimes() {
    const dur = getKnownDuration();
    const cur = (els.audio && isFinite(els.audio.currentTime)) ? els.audio.currentTime : 0;

    // Seekbar + duration remain disabled/unknown until playback is user-initiated and metadata is available.
    const hasDuration = (dur > 0);
    setSeekEnabled(hasDuration);

    if (els.seek && !isSeeking) {
      const v = hasDuration ? Math.round((cur / dur) * 1000) : 0;
      els.seek.value = String(clamp(v, 0, 1000));
    }
    try { if (els.timeCur) els.timeCur.textContent = formatTime(cur); } catch {}
    try { if (els.timeDur) els.timeDur.textContent = hasDuration ? formatTime(dur) : UNKNOWN_TIME; } catch {}


    updateMediaSessionPositionState(false);
  }

const markActiveChapterThrottled = throttle((timeSec) => {
  try { markActiveChapterByTime(timeSec); } catch {}
}, CONFIG.CHAPTER_MARK_THROTTLE_MS);

let _progressRafPending = false;
function scheduleProgressUiUpdate() {
  if (_progressRafPending) return;
  _progressRafPending = true;
  window.requestAnimationFrame(() => {
    _progressRafPending = false;
    updateTimes();
    if (!isSeeking) {
      markActiveChapterThrottled(lastKnownTime);
    }
  });
}



  function selectedLangCfg() { return config.languages[els.langSelect.value]; }


  function saveProgressNow() {
    if (isSourceSwitching) return;
    if (!config) return;
    const epId = episodeId;
    const langCode = els.langSelect.value || (config.defaultLanguage || "");
    const t = (isFinite(els.audio.currentTime) && els.audio.currentTime >= 0) ? els.audio.currentTime : 0;

    const prefs = readPrefs(epId);
    setProgress(prefs, langCode, t);
    if (els.qualitySelect && els.qualitySelect.value) prefs.quality = els.qualitySelect.value;
    if (langCode) prefs.lang = langCode;

    writePrefs(epId, prefs);
  }

  function saveProgressAt(seconds) {
    if (isSourceSwitching) return;
    if (!config) return;
    const epId = episodeId;
    const langCode = els.langSelect.value || (config.defaultLanguage || "");
    const t = (typeof seconds === "number" && isFinite(seconds) && seconds >= 0) ? seconds : 0;

    const prefs = readPrefs(epId);
    setProgress(prefs, langCode, t);
    if (els.qualitySelect && els.qualitySelect.value) prefs.quality = els.qualitySelect.value;
    if (langCode) prefs.lang = langCode;

    writePrefs(epId, prefs);
  }

  function saveProgressThrottled(force) {
    if (isSourceSwitching) return;
    const now = Date.now();
    if (force || (now - lastProgressSaveMs) > CONFIG.PROGRESS_SAVE_INTERVAL_MS) {
      lastProgressSaveMs = now;
      pendingProgressSave = false;
      saveProgressNow();
      return;
    }
    pendingProgressSave = true;
  }
  function applySelections(epId, langCode, qualityId) {
    const prefs = readPrefs(epId);
    prefs.lang = langCode;
    prefs.quality = qualityId;
    const t = (isFinite(els.audio.currentTime) && els.audio.currentTime >= 0) ? els.audio.currentTime : getProgress(prefs, langCode);
    setProgress(prefs, langCode, t);
    writePrefs(epId, prefs);
  }

  async function loadEpisode(epId) {
    setLoadingState(true);
    try {
      episodeId = epId;
    setTitle(t("audio"));
    setMeta(t("loading"));
    try { clearCover(); } catch {}

    const baseUrl = new URL(".", window.location.href);
    const folder = getEpisodeFolder(episodeId);
    const cfgUrl = new URL(`media/${encodeURIComponent(folder)}/episode.json`, baseUrl).toString();
    const safeCfgUrl = normalizeFetchUrl(cfgUrl);

    const res = await fetchWithRetry(safeCfgUrl, { cache: "no-store", credentials: "include" });
    if (!res.ok) throw new Error(`Could not load episode config (HTTP ${res.status})`);
    const relCfgPath = `media/${folder}/episode.json`;
    const cfgText = await res.text();
    config = parseJsonTextOrThrow(cfgText, relCfgPath);
    validateEpisodeConfigOrThrow(config, cfgText, relCfgPath);

    // Optional duration hint (seconds) lets us show total time before media metadata loads
    knownDuration = (typeof config.duration === "number" && isFinite(config.duration) && config.duration > 0) ? config.duration : 0;
    if (knownDuration > 0 && els.timeDur) {
      try { els.timeDur.textContent = formatTime(knownDuration); } catch {}
    }

    // Availability caches (computed at load)
    config._qualityByLang = {};
    config._availableLangCodes = [];
    config._fullScanByLang = {};

    const allLangCodes = Object.keys((config && config.languages) || {});
    if (!allLangCodes.length) throw new Error("No languages defined in episode.json");

    const prefs = readPrefs(episodeId);

    

    // Pick a preferred language WITHOUT probing everything
    let preferredLangCode = (prefs.lang && allLangCodes.includes(prefs.lang)) ? prefs.lang : null;
    if (!preferredLangCode) preferredLangCode = guessBestLanguage(allLangCodes, config.defaultLanguage || allLangCodes[0]);

    const cacheVersion = (config.cacheVersion == null) ? 1 : config.cacheVersion;
    const availCache = readAvailabilityCache(episodeId, cacheVersion);

    {
      const debugShowAllQualities = !!(config.debug && config.debug.showAllQualities);
      const codes = allLangCodes;

      const cachedExists = availCache && availCache.existsByLang ? availCache.existsByLang : null;

      for (const code of codes) {
        const langCfg = config.languages[code];
        const allOpts = buildQualityOptionsForLanguage(langCfg);

        let useCache = !!(cachedExists && cachedExists[code]);

        // iOS/iPadOS: avoid getting stuck with a stale/false-negative availability cache
        // that hides AAC qualities. Safari (and some network/proxy layers) can occasionally
        // return 404 to fetch() probes while <audio> can still load/play the same URL.
        if (useCache && IS_IOS && code === preferredLangCode) {
          const map = cachedExists[code] || {};
          const aacCfg = (langCfg && langCfg.sources && langCfg.sources.aac) ? langCfg.sources.aac : null;
          const hasAacCfg = !!(aacCfg && Object.keys(aacCfg).length);
          if (hasAacCfg) {
            const anyAacTrue = Object.keys(map).some(k => k.startsWith("aac-") && !!map[k]);
            if (!anyAacTrue) {
              try {
                // Probe the best AAC URL once; if it exists, invalidate cache for this language.
                const brs = Object.keys(aacCfg)
                  .map(x => parseInt(x, 10))
                  .filter(n => isFinite(n) && n > 0)
                  .sort((a, b) => b - a);

                // Probe up to two AAC qualities (best -> next best). This keeps it fast,
                // and still recovers if the top bitrate file is missing but a lower one exists.
                for (const br of brs.slice(0, 2)) {
                  const rel = aacCfg[String(br)];
                  if (!rel) continue;
                  const abs = buildUrlFor(langCfg, rel);
                  const ok = await urlExists(abs);
                  if (ok) { useCache = false; break; }
                }
              } catch {}
            }
          }
        }

        if (useCache) {
          // Cache path: apply exists flags for all options (fast)
          const map = cachedExists[code];
          for (const o of allOpts) o.exists = !!map[o.id];
          config._fullScanByLang[code] = true;
        } else if (code === preferredLangCode) {
          // Full scan only for the preferred language (so quality list is complete)
          await enrichQualityOptionsWithExists(langCfg, allOpts);
          config._fullScanByLang[code] = true;
        } else {
          // Quick probe for other languages (avoid probing the entire matrix)
          const ok = await quickProbeLanguage(langCfg, allOpts, 6);
          config._fullScanByLang[code] = false;
          if (!ok) {
            // No quick hit found; leave exists undefined (language may still be available, background scan will decide)
          }
        }

        config._qualityByLang[code] = allOpts;

        const displayOpts = filterQualityOptionsForDisplay(allOpts, debugShowAllQualities);
        const hasPlayable = displayOpts.some(o => o.supported);
        if (hasPlayable) config._availableLangCodes.push(code);
      }
    }

    // Write cache if we used cache or fully scanned the preferred language (partial info still helps, and later full scans overwrite)
    try { writeAvailabilityCache(episodeId, cacheVersion, config); } catch {}

    const langs = getAvailableLangCodes(config);

    if (!langs.length) throw new Error("No languages defined in episode.json");

    

    let langCode = (prefs.lang && langs.includes(prefs.lang)) ? prefs.lang : null;
    if (!langCode) langCode = guessBestLanguage(langs, config.defaultLanguage || langs[0]);

// If the preferred language has no playable files, fall back to the first available language
const availableLangs = getAvailableLangCodes(config);
if (availableLangs.length && !availableLangs.includes(langCode)) {
  langCode = availableLangs[0];
}

    populateLanguageSelect(config, langCode);

    // Background: complete full availability scan for other languages (improves next visit without slowing first load)
    if (!availCache) scheduleBackgroundFullScan(langCode);


    const langCfg = config.languages[langCode];

    await ensureFullScanForLanguage(langCode);
    const allQualityOptions = (config._qualityByLang && config._qualityByLang[langCode]) ? config._qualityByLang[langCode] : buildQualityOptionsForLanguage(langCfg);
    const debugShowAllQualities = !!(config.debug && config.debug.showAllQualities);
    const displayQualityOptions = filterQualityOptionsForDisplay(allQualityOptions, debugShowAllQualities);

    let selected = null;
    if (prefs.quality) {
      const candidate = displayQualityOptions.find(o => o.id === prefs.quality && o.supported);
      if (candidate) selected = candidate;
    }
    if (!selected) selected = chooseDefaultQuality(displayQualityOptions);
    if (!selected) throw new Error("No playable audio formats found for this browser.");

    populateQualitySelect(displayQualityOptions, selected.id, debugShowAllQualities);

    const title = (config.title && (config.title[langCode] || config.title[langCode.split("-")[0]])) || config.id || episodeId;
    setTitle(title);
    try { setMediaEpisodeTitle(title); } catch {}
    try { setMediaChapterTitle(""); } catch {}
    setMeta(metaWithQuality(langCfg.label || langCode, episodeId, qualityDisplayLabel(selected)));

    const audioUrl = buildUrlFor(langCfg, selected.url);
    const startTime = getProgress(prefs, langCode);
    primeAudioSource(audioUrl, mimeFor(selected.codec, selected.ext), startTime);
    try { applyCoverFromConfig(config, folder, title); } catch {}

    // Chapters should never block language switching/playback.
    // Some languages may not ship chapters (or may 404 temporarily).
const chaptersUrl = buildUrlFor(langCfg, langCfg.chapters);
// Chapters are loaded lazily (on first open) to reduce initial load work.
chaptersUrlPending = chaptersUrl || "";
chaptersLoaded = false;
chaptersLoadError = false;
chaptersLoadInFlight = null;
cues = [];
activeCueIndex = -1;
try { updateChapterNavButtons(); } catch {}
try { if (els.chaptersList) els.chaptersList.innerHTML = ""; } catch {}


    applySelections(episodeId, langCode, selected.id);
    } finally {
      setLoadingState(false);
    }
  }

  /** Events **/
  if (els.optionsBtn) {
    els.optionsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleOptions();
    });
  }
  els.optionsPanel.addEventListener("click", (e) => e.stopPropagation());

  // Cover: click to open full-size lightbox (audio keeps playing)
  if (els.coverWrap) {
    els.coverWrap.addEventListener("click", (e) => {
      e.stopPropagation();
      openCoverLightbox();
    });
    els.coverWrap.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        openCoverLightbox();
      }
    });
  }
  if (els.coverLightbox) {
    els.coverLightbox.addEventListener("click", (e) => {
      // Clicking anywhere closes the full-size cover
      closeCoverLightbox();
    });
  }

  // Audiobook selector (from media/library.json)
  if (els.episodeSelect) {
    els.episodeSelect.addEventListener("change", async () => {
      if (_suppressEpisodeSelect) return;
      const nextId = String(els.episodeSelect.value || "").trim();
      if (!nextId || nextId === episodeId) return;

      const prevId = episodeId;

      // Stop playback and persist current progress in the previous episode
      try { saveProgressNow(); } catch {}
      try { els.audio.pause(); } catch {}
      userWantsPlaying = false;
      try { closeChapters(); } catch {}

      setUiLocked(true);
      try {
        writeLastEpisodeId(nextId);
        setUrlEpisodeParam(nextId);
        await loadEpisode(nextId);
        // Re-apply strings (some episode labels can be localized)
        try { populateEpisodeSelect(nextId); } catch {}
      } catch (err) {
        console.error(err);
        // Revert selection
        writeLastEpisodeId(prevId);
        setUrlEpisodeParam(prevId);
        try { populateEpisodeSelect(prevId); } catch {}
        try { await loadEpisode(prevId); } catch {}
        try { flashMetaError(t("errorLoading")); } catch {}
        try { showToast(t("errorLoading"), "error"); } catch {}
      } finally {
        setUiLocked(false);
      }
    });
  }

  if (els.volumeRange && !IS_IOS) {
    // Live preview on drag
    els.volumeRange.addEventListener("input", () => {
      const p = clamp(parseInt(els.volumeRange.value, 10) || 0, 0, 100);
      applyVolume(p / 100);
    });

    // Persist when the user commits the change (mouse up / keyboard commit)
    els.volumeRange.addEventListener("change", () => {
      const p = clamp(parseInt(els.volumeRange.value, 10) || 0, 0, 100);
      const ui = readUiPrefs();
      ui.volume = p / 100;
      writeUiPrefs(ui);
      applyVolume(p / 100);
    });
  }

  if (els.speedRange) {
    // Live preview on drag
    els.speedRange.addEventListener("input", () => {
      const r = clampPlaybackRate(parseFloat(els.speedRange.value));
      applyPlaybackRate(r);

      // Persist quickly (debounced) so changing language/quality/episode right
      // after dragging the slider still keeps the chosen speed.
      try {
        if (playbackRatePersistTimer) window.clearTimeout(playbackRatePersistTimer);
        playbackRatePersistTimer = window.setTimeout(() => {
          try { persistPlaybackRate(r); } catch {}
        }, 200);
      } catch {}
    });

    // Persist when the user commits the change (mouse up / keyboard commit)
    els.speedRange.addEventListener("change", () => {
      const r = clampPlaybackRate(parseFloat(els.speedRange.value));
      try {
        if (playbackRatePersistTimer) window.clearTimeout(playbackRatePersistTimer);
        playbackRatePersistTimer = null;
      } catch {}
      persistPlaybackRate(r);
      applyPlaybackRate(r);
    });
  }

  if (els.themeSelect) {
    els.themeSelect.addEventListener("change", () => {
      const mode = els.themeSelect.value || "system";
      const ui = readUiPrefs();
      ui.theme = mode;
      writeUiPrefs(ui);
      applyTheme(mode);
    });
  }

  if (els.fontSizeSelect) {
    els.fontSizeSelect.addEventListener("change", () => {
      const size = els.fontSizeSelect.value || "m";
      const ui = readUiPrefs();
      ui.fontSize = size;
      writeUiPrefs(ui);
      applyFontSize(size);
    });
  }

  if (els.uiLangSelect) {
    els.uiLangSelect.addEventListener("change", () => {
      const v = els.uiLangSelect.value || "auto";
      const ui = readUiPrefs();
      ui.uiLang = v;
      writeUiPrefs(ui);

      UI_LOCALE = detectUiLocale();
      applyUiStrings();
      try { populateEpisodeSelect(episodeId); } catch {}
      refreshQualitySelectLabelsFromDom();
      updateMetaLineAfterUiLangChange();
      try { updatePlayButton(); } catch {}
    });
  }





  if (els.skipSelect) {
    els.skipSelect.addEventListener("change", () => {
      const v = parseInt(els.skipSelect.value, 10);
      const ui = readUiPrefs();
      ui.skipSeconds = v;
      writeUiPrefs(ui);
      applySkipSeconds(v);
    });
  }
  if (els.chaptersBtn) {
    els.chaptersBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleChapters();
    });
  }
  els.closeChaptersBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeChapters();
  });
  if (els.focusSkipBack) els.focusSkipBack.addEventListener("click", () => { mediaSeekBy(-skipSeconds); });
  if (els.focusSkipForward) els.focusSkipForward.addEventListener("click", () => { mediaSeekBy(skipSeconds); });
  if (els.focusChaptersBtn) {
    els.focusChaptersBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleChapters(); });
  }

  if (els.focusPrevChapterBtn) {
    els.focusPrevChapterBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      goToPrevChapter();
    });
  }
  if (els.focusNextChapterBtn) {
    els.focusNextChapterBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      goToNextChapter();
    });
  }
  if (els.focusOptionsBtn) {
    els.focusOptionsBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleOptions(); });
  }

  if (els.sleepBtn) {
    els.sleepBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleSleepMenu(); });
  }
  if (els.closeSleepBtn) {
    els.closeSleepBtn.addEventListener("click", (e) => { e.stopPropagation(); closeSleepMenu(); });
  }
  if (els.sleepMenu) {
    els.sleepMenu.addEventListener("click", (e) => e.stopPropagation());
  }

  document.addEventListener("click", (e) => {
    // Close menus on outside click
    closeChapters();
    closeSleepMenu();
    const card = document.querySelector(".playerCard");
    if (card && !card.contains(e.target)) {
      closeOptions();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (isCoverLightboxOpen()) { closeCoverLightbox(); return; }
      if (els.onboardingModal && !els.onboardingModal.hidden) { closeOnboarding(); return; }
      if (els.resetModal && !els.resetModal.hidden) { closeResetModal(); return; }

      if (isExpanded) {
        if (els.chaptersMenu && !els.chaptersMenu.hidden) { closeChapters(); return; }
        if (els.sleepMenu && !els.sleepMenu.hidden) { closeSleepMenu(); return; }
        if (els.optionsPanel && !els.optionsPanel.hidden) { closeOptions(); return; }
        return;
      }

      closeChapters();
      closeSleepMenu();
      closeOptions();
      return;
    }

    // Global keyboard shortcuts (desktop)
    if (isAnyModalOpen()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const target = e.target;
    if (target && target.closest && target.closest("input, textarea, select, button, a")) return;
    if (target && target.isContentEditable) return;

    if (e.code === "Space") {
      e.preventDefault();
      togglePlay().catch(() => {});
      return;
    }
    if (e.code === "ArrowRight") {
      e.preventDefault();
      mediaSeekBy(5);
      return;
    }
    if (e.code === "ArrowLeft") {
      e.preventDefault();
      mediaSeekBy(-5);
      return;
    }
  });

  els.playPauseBtn.addEventListener("click", () => { togglePlay().catch(() => {}); });
  els.audio.addEventListener("play", () => { userWantsPlaying = true; clearMetaError(); updatePlayButton(); });
  els.audio.addEventListener("pause", () => { userWantsPlaying = false; updatePlayButton(); saveProgressThrottled(true); });
  els.audio.addEventListener("ended", () => { updatePlayButton(); saveProgressThrottled(true); });

  // Flush progress when the page is backgrounded/closed.
  // localStorage writes are throttled (see CONFIG.PROGRESS_SAVE_INTERVAL_MS),
  // and we force a final save here to avoid losing the last few seconds.
  window.addEventListener("pagehide", () => { try { saveProgressThrottled(true); } catch {} }, { capture: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      try { saveProgressThrottled(true); } catch {}
    }
  });

  els.audio.addEventListener("canplay", () => { clearMetaError(); updateMediaSessionPositionState(true); });
  els.audio.addEventListener("error", () => {
    if (isSourceSwitching) return;
    try { flashMetaError(t("audioLoadError")); } catch {}
    try { showToast(t("audioLoadError"), "warning"); } catch {}
    try { attemptCodecFallback(getSafeCurrentTime(0), "audio-error"); } catch {}
  });

  els.audio.addEventListener("timeupdate", () => {
    const t = (isFinite(els.audio.currentTime) && els.audio.currentTime >= 0) ? els.audio.currentTime : 0;
    lastKnownTime = t;
    scheduleProgressUiUpdate();
    saveProgressThrottled(false);
  });
  els.audio.addEventListener("loadedmetadata", () => { updateTimes(); const t = (isFinite(els.audio.currentTime) && els.audio.currentTime >= 0) ? els.audio.currentTime : 0; lastKnownTime = t; markActiveChapterByTime(t); });
  els.audio.addEventListener("seeked", () => {
    if (isSourceSwitching) return;
    const t = (isFinite(els.audio.currentTime) && els.audio.currentTime >= 0) ? els.audio.currentTime : 0;
    lastKnownTime = t;
    pendingSeekTime = null;
    updateTimes();
    markActiveChapterByTime(t);
    saveProgressAt(t);
  });

  // Seeking (Chrome/Firefox-friendly): update UI during drag; commit seek on release.
const computeSeekTarget = () => {
  const dur = getKnownDuration();
  const v = parseInt(els.seek.value, 10) || 0;
  return dur > 0 ? (v / 1000) * dur : 0;
};

els.seek.addEventListener("input", () => {
  isSeeking = true;
  const t = computeSeekTarget();

  // Do not touch media playback during drag (avoids Chrome UI stalls).
  pendingSeekTime = t;
  lastKnownTime = t;

  els.timeCur.textContent = formatTime(t);
  markActiveChapterThrottled(t);
});

const commitSeek = () => {
  if (!isSeeking) return;
  const t = computeSeekTarget();
  seekTo(t, { resumeIfPlaying: false, persist: true });
  isSeeking = false;
};

els.seek.addEventListener("change", commitSeek);
els.seek.addEventListener("pointerup", commitSeek);
els.seek.addEventListener("mouseup", commitSeek);
els.seek.addEventListener("touchend", commitSeek, { passive: true });

els.langSelect.addEventListener("change", async () => {
  try {
    if (!config || !episodeId) return;

    const wasPlaying = !els.audio.paused && !els.audio.ended;
    const shouldPlay = wasPlaying || userWantsPlaying;
    const cur = getSafeCurrentTime(0);

    // Persist progress + selection
    saveProgressAt(cur);
    applySelections(episodeId, els.langSelect.value, els.qualitySelect.value);

    const langCode = els.langSelect.value;
    const qualityId = els.qualitySelect.value;

    populateLanguageSelect(config, langCode);

    const langCfg = config.languages[langCode];

    await ensureFullScanForLanguage(langCode);
    const allQualityOptions = (config._qualityByLang && config._qualityByLang[langCode])
      ? config._qualityByLang[langCode]
      : buildQualityOptionsForLanguage(langCfg);

    const debugShowAllQualities = !!(config.debug && config.debug.showAllQualities);
    const displayQualityOptions = filterQualityOptionsForDisplay(allQualityOptions, debugShowAllQualities);

    let selected = null;
    if (qualityId) {
      const candidate = displayQualityOptions.find(o => o.id === qualityId && o.supported);
      if (candidate) selected = candidate;
    }
    if (!selected) selected = chooseDefaultQuality(displayQualityOptions);
    if (!selected) throw new Error("No playable audio formats found for this browser.");

    populateQualitySelect(displayQualityOptions, selected.id, debugShowAllQualities);
    setMeta(metaWithQuality(langCfg.label || langCode, episodeId, qualityDisplayLabel(selected)));
    const audioUrl = buildUrlFor(langCfg, selected.url);
    const mime = mimeFor(selected.codec, selected.ext);


    // Lazy load: if not currently playing, don't fetch metadata/audio yet.
    if (!shouldPlay) {
      primeAudioSource(audioUrl, mime, cur);

      // Reset chapter state for the newly selected language (chapters remain lazy-loaded).
      try { closeChapters(); } catch {}
      const chaptersUrl = buildUrlFor(langCfg, langCfg.chapters);
      chaptersUrlPending = chaptersUrl || "";
      chaptersLoaded = false;
      chaptersLoadError = false;
      chaptersLoadInFlight = null;
      cues = [];
      activeCueIndex = -1;
      try { updateChapterNavButtons(); } catch {}
      try { if (els.chaptersList) els.chaptersList.innerHTML = ""; } catch {}
      return;
    }


    if (IS_IOS) {
      iosImmediateSwitchSource(audioUrl, mime, cur, shouldPlay);
      // Chapters can load after; doesn't need to block playback
      const chaptersUrl = buildUrlFor(langCfg, langCfg.chapters);
	      loadChapters(chaptersUrl).catch(() => {});
	      return;
    }

	    // Desktop path: switch source in-place (do NOT reload episode.json)
	    try {
	      const chaptersUrl = buildUrlFor(langCfg, langCfg.chapters);
	      loadChapters(chaptersUrl).catch(() => {});
	    } catch {}
	    setAudioSource(audioUrl, mime, cur, null, () => {
	      if (shouldPlay) safePlay().catch(() => {});
	    });
  } catch (err) {
    console.error(err);
  }
});

els.qualitySelect.addEventListener("change", async () => {
  try {
    if (!config || !episodeId) return;

    const wasPlaying = !els.audio.paused && !els.audio.ended;
    const shouldPlay = wasPlaying || userWantsPlaying;
    const cur = getSafeCurrentTime(0);

    // Persist progress + selection
    saveProgressAt(cur);
    applySelections(episodeId, els.langSelect.value, els.qualitySelect.value);

    const langCode = els.langSelect.value;
    const qualityId = els.qualitySelect.value;
    const langCfg = config.languages[langCode];

    const allQualityOptions = (config._qualityByLang && config._qualityByLang[langCode])
      ? config._qualityByLang[langCode]
      : buildQualityOptionsForLanguage(langCfg);

    const debugShowAllQualities = !!(config.debug && config.debug.showAllQualities);
    const displayQualityOptions = filterQualityOptionsForDisplay(allQualityOptions, debugShowAllQualities);

    const selected = displayQualityOptions.find(o => o.id === qualityId && o.supported) || chooseDefaultQuality(displayQualityOptions);
    if (!selected) throw new Error("No playable audio formats found for this browser.");

    populateQualitySelect(displayQualityOptions, selected.id, debugShowAllQualities);
    setMeta(metaWithQuality(langCfg.label || langCode, episodeId, qualityDisplayLabel(selected)));
    const audioUrl = buildUrlFor(langCfg, selected.url);
    const mime = mimeFor(selected.codec, selected.ext);


    // Lazy load: if not currently playing, don't fetch metadata/audio yet.
    if (!shouldPlay) {
      primeAudioSource(audioUrl, mime, cur);
      return;
    }


    if (IS_IOS) {
      iosImmediateSwitchSource(audioUrl, mime, cur, shouldPlay);
      return;
    }

	    // Desktop path: switch source in-place (do NOT reload episode.json)
	    setAudioSource(audioUrl, mime, cur, null, () => {
	      if (shouldPlay) safePlay().catch(() => {});
	    });
  } catch (err) {
    console.error(err);
  }
});




  /** Boot **/
  (async function init() {
    applyUiStrings();
    try { initMediaSession(); } catch {}

if (els.onboardingOk) els.onboardingOk.addEventListener("click", () => { confirmOnboarding(); closeOnboarding(); });
if (els.onboardingCloseX) els.onboardingCloseX.addEventListener("click", closeOnboarding);
if (els.onboardingModal) {
  els.onboardingModal.addEventListener("click", (e) => {
    // click outside the modal closes it
    if (e.target === els.onboardingModal) closeOnboarding();
  });
}

if (els.resetBtn) els.resetBtn.addEventListener("click", openResetModal);
if (els.resetCloseX) els.resetCloseX.addEventListener("click", closeResetModal);
if (els.resetCancel) els.resetCancel.addEventListener("click", closeResetModal);
if (els.resetOk) els.resetOk.addEventListener("click", () => {
  closeResetModal();
  resetPlayerAndStorage();
});
if (els.resetModal) {
  els.resetModal.addEventListener("click", (e) => {
    // click outside the modal closes it
    if (e.target === els.resetModal) closeResetModal();
  });
}


    try {
      initTheme();
      // initContrast removed
      initFontSize();
      if (!IS_IOS) initVolume();
      initPlaybackRate();
      initSkipSeconds();
      try { libraryIndex = await loadLibraryIndex(); } catch { libraryIndex = null; }

      // Hide Audiobook selector when 0 or 1 entry is available
      try { updateEpisodeRowVisibility(); } catch {}


      episodeId = resolveInitialEpisodeId();
      try { populateEpisodeSelect(episodeId); } catch {}
      // Remember the last selected audiobook so returning users land where they left off
      try { writeLastEpisodeId(episodeId); } catch {}

      await loadEpisode(episodeId);
      // First-visit help (can be disabled via episode.json: ui.onboardingEnabled=false)
      const onboardingEnabled = (config && config.ui && typeof config.ui.onboardingEnabled === "boolean")
        ? config.ui.onboardingEnabled
        : true;
      if (onboardingEnabled && !hasSeenOnboarding()) {
        openOnboarding();
      }

      updatePlayButton();
      updateTimes();
      closeChapters();
      closeOptions();
    } catch (err) {
      console.error(err);
      showFatalError(err);
    }
  })();
})();