import { buildFallbackQueue } from "./source-selection.js";
import { clamp } from "./utils.js";

export class MediaController {
  constructor(audio, callbacks = {}, { sourceTimeoutMs = 15000, isOnline = () => globalThis.navigator?.onLine !== false } = {}) {
    this.audio = audio;
    this.callbacks = callbacks;
    this.sourceTimeoutMs = sourceTimeoutMs;
    this.isOnline = isOnline;
    this.generation = 0;
    this.playAttempt = 0;
    this.queue = [];
    this.queueIndex = -1;
    this.attempted = new Set();
    this.failedSources = new Set();
    this.playbackIntent = false;
    this.desiredTime = 0;
    this.playbackRate = 1;
    this.volume = 1;
    this.loaded = false;
    this.hasStarted = false;
    this.state = "idle";
    this.timeout = null;
    this.internalPause = false;
    this.events = new AbortController();
    this.bindEvents();
  }

  bindEvents() {
    const listen = (type, listener) => this.audio.addEventListener(type, listener, { signal: this.events.signal });
    listen("loadstart", () => {
      if (this.audio.src && (this.playbackIntent || this.state !== "paused")) this.setState("loading");
    });
    listen("loadedmetadata", () => {
      this.loaded = true;
      this.applyMediaSettings();
      this.applyDesiredTime();
      if (!this.playbackIntent) { this.clearTimeout(); this.setState("paused"); }
      else this.armTimeout(this.generation, this.currentSource()?.url);
    });
    listen("playing", () => {
      if (!this.audio.src || this.audio.paused) return;
      this.playbackIntent = true;
      this.loaded = true;
      this.hasStarted = true;
      this.clearTimeout();
      this.setState("playing");
      this.callbacks.onSourceSuccess?.(this.currentSource());
    });
    listen("pause", () => {
      // A pause queued by the previous source can arrive after the new source starts.
      if (!this.internalPause && this.playbackIntent && this.audio.paused && !this.audio.ended) this.markPaused();
    });
    const handleBuffering = () => {
      if (!this.playbackIntent) return;
      const interrupted = this.hasStarted;
      if (interrupted && this.state === "stalled" && this.timeout !== null) return;
      this.setState(interrupted ? "stalled" : "loading");
      this.armTimeout(this.generation, this.currentSource()?.url, interrupted);
    };
    listen("waiting", handleBuffering);
    listen("stalled", handleBuffering);
    listen("ended", () => { this.playbackIntent = false; this.setState("ended"); this.callbacks.onEnded?.(); });
    listen("timeupdate", () => {
      // Reloading a source can emit timeupdate at zero before metadata arrives.
      if (!this.loaded || this.audio.seeking) return;
      if (Number.isFinite(this.audio.currentTime)) {
        if (this.state === "stalled" && this.hasStarted && !this.audio.paused && this.audio.currentTime > this.stallPosition) {
          this.clearTimeout();
          this.setState("playing");
        }
        const moved = this.desiredTime !== this.audio.currentTime;
        this.desiredTime = this.audio.currentTime;
        if (moved && this.hasStarted) this.callbacks.onProgress?.(this.desiredTime);
        this.callbacks.onTime?.(this.audio.currentTime, this.duration());
      }
    });
    listen("durationchange", () => this.callbacks.onTime?.(this.position(), this.duration()));
    listen("error", () => this.handleMediaError());
  }

  setSelection(sources, selectedId, position = 0, shouldPlay = false) {
    if (this.events.signal.aborted) return Promise.resolve(false);
    this.generation += 1;
    this.queue = buildFallbackQueue(sources, selectedId);
    this.queueIndex = this.queue.length ? 0 : -1;
    this.attempted.clear();
    this.failedSources.clear();
    this.desiredTime = Math.max(0, Number(position) || 0);
    this.playbackIntent = Boolean(shouldPlay);
    this.clearTimeout();
    if (shouldPlay) return this.activateCurrent(true);
    this.clearSource();
    if (this.currentSource()) this.callbacks.onSourceChange?.(this.currentSource());
    this.callbacks.onTime?.(this.desiredTime, 0);
    return Promise.resolve(false);
  }

  togglePlayback() {
    if (this.playbackIntent) return this.requestPause();
    return this.requestPlay();
  }

  requestPlay() {
    if (this.events.signal.aborted) return Promise.resolve(false);
    this.playbackIntent = true;
    if (this.state === "error" && this.queue.length) {
      this.generation += 1;
      this.queueIndex = 0;
      this.attempted.clear();
      this.failedSources.clear();
      return this.activateCurrent(true);
    }
    if (!this.audio.src && this.currentSource()) return this.activateCurrent(true);
    if (this.audio.src && (this.state === "paused" || this.state === "ended" || !this.hasStarted)) {
      this.setState("loading");
      this.armTimeout(this.generation, this.currentSource()?.url);
    }
    return this.playCurrent(this.generation, this.currentSource()?.url);
  }

  markPaused() {
    this.playAttempt += 1;
    this.playbackIntent = false;
    this.clearTimeout();
    this.setState("paused");
  }

  requestPause() {
    if (this.events.signal.aborted) return;
    this.markPaused();
    this.audio.pause();
  }

  handleReconnect() {
    if (this.playbackIntent && (this.state === "loading" || this.state === "stalled")) return this.requestPlay();
  }

  clearSource() {
    this.loaded = false;
    this.hasStarted = false;
    this.internalPause = true;
    try { this.audio.pause(); } catch {}
    this.audio.removeAttribute("src");
    this.audio.preload = "none";
    try { this.audio.load(); } catch {}
    this.internalPause = false;
    this.setState("idle");
  }

  currentSource() { return this.queue[this.queueIndex] || null; }

  async activateCurrent(shouldPlay) {
    const source = this.currentSource();
    if (!source || this.attempted.has(source.url)) return false;
    const generation = this.generation;
    this.attempted.add(source.url);
    this.loaded = false;
    this.hasStarted = false;
    this.internalPause = true;
    try { this.audio.pause(); } catch {}
    this.internalPause = false;
    this.audio.preload = shouldPlay ? "auto" : "metadata";
    this.audio.src = source.url;
    this.applyMediaSettings();
    this.setState("loading");
    this.callbacks.onSourceChange?.(source);
    try { this.audio.load(); } catch {}
    this.armTimeout(generation, source.url);
    return shouldPlay ? this.playCurrent(generation, source.url) : true;
  }

  async playCurrent(generation, expectedUrl) {
    const attempt = ++this.playAttempt;
    try {
      const promise = this.audio.play();
      if (promise && typeof promise.then === "function") await promise;
      return generation === this.generation && attempt === this.playAttempt;
    } catch (error) {
      if (generation !== this.generation || attempt !== this.playAttempt || this.currentSource()?.url !== expectedUrl) return false;
      if (error?.name === "AbortError") return false;
      if (error?.name === "NotAllowedError") {
        this.requestPause();
        this.callbacks.onBlocked?.(error);
        return false;
      }
      return this.failCurrent(error, error?.name === "NotSupportedError", expectedUrl);
    }
  }

  handleMediaError() {
    if (!this.audio.src || this.queueIndex < 0) return;
    const code = this.audio.error?.code || 0;
    this.failCurrent(this.audio.error || new Error("Media source failed"), code === 3 || code === 4, this.currentSource()?.url);
  }

  async failCurrent(error, skipCodec = false, expectedUrl = this.currentSource()?.url) {
    const failed = this.currentSource();
    if (!failed || failed.url !== expectedUrl || this.failedSources.has(expectedUrl)) return false;
    if (!this.isOnline()) {
      if (!this.playbackIntent) return false;
      this.setState("stalled");
      this.callbacks.onOffline?.();
      return false;
    }
    this.failedSources.add(expectedUrl);
    this.callbacks.onSourceFailure?.(failed, error);
    let next = this.queueIndex + 1;
    if (skipCodec && failed) while (next < this.queue.length && this.queue[next].codec === failed.codec) next += 1;
    while (next < this.queue.length && this.attempted.has(this.queue[next].url)) next += 1;
    if (next >= this.queue.length) {
      this.clearTimeout();
      this.playbackIntent = false;
      this.setState("error");
      this.callbacks.onExhausted?.(error);
      return false;
    }
    this.queueIndex = next;
    this.callbacks.onFallback?.(failed, this.currentSource());
    return this.activateCurrent(this.playbackIntent);
  }

  seek(seconds) {
    if (this.events.signal.aborted) return this.position();
    const duration = this.duration();
    this.desiredTime = duration ? clamp(Number(seconds) || 0, 0, Math.max(0, duration - .01)) : Math.max(0, Number(seconds) || 0);
    if (this.state === "stalled") this.stallPosition = this.desiredTime;
    if (this.loaded) this.applyDesiredTime();
    this.callbacks.onProgress?.(this.desiredTime, true);
    this.callbacks.onTime?.(this.desiredTime, duration);
    return this.desiredTime;
  }

  applyDesiredTime() {
    try {
      const duration = this.duration();
      const target = duration ? clamp(this.desiredTime, 0, Math.max(0, duration - .01)) : this.desiredTime;
      if (Math.abs((this.audio.currentTime || 0) - target) > .05) this.audio.currentTime = target;
    } catch {}
  }

  setPlaybackRate(value) { this.playbackRate = clamp(Number(value) || 1, .5, 2); this.applyMediaSettings(); }
  setVolume(value) { this.volume = clamp(Number(value) || 0, 0, 1); this.applyMediaSettings(); }
  applyMediaSettings() {
    try { this.audio.defaultPlaybackRate = this.playbackRate; this.audio.playbackRate = this.playbackRate; } catch {}
    try { this.audio.volume = this.volume; } catch {}
  }
  position() { return this.loaded && !this.audio.seeking && Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : this.desiredTime; }
  duration() { return Number.isFinite(this.audio.duration) && this.audio.duration > 0 ? this.audio.duration : 0; }
  setState(state) {
    if (state === this.state) return;
    if (state === "stalled") this.stallPosition = this.position();
    this.state = state;
    this.callbacks.onState?.(state);
  }
  armTimeout(generation, url, includeStall = false) {
    this.clearTimeout();
    this.timeout = setTimeout(() => {
      this.timeout = null;
      const didNotStart = this.playbackIntent && !this.hasStarted;
      const remainsStalled = includeStall && this.playbackIntent && this.state === "stalled";
      if (generation !== this.generation || this.currentSource()?.url !== url) return;
      if (!this.isOnline()) { this.setState("stalled"); this.callbacks.onOffline?.(); return; }
      if (!this.loaded || didNotStart || remainsStalled) this.failCurrent(new Error("Audio source timed out"), false, url);
    }, this.sourceTimeoutMs);
  }
  clearTimeout() { if (this.timeout) clearTimeout(this.timeout); this.timeout = null; }
  destroy() {
    if (this.events.signal.aborted) return;
    this.events.abort();
    this.generation += 1;
    this.clearTimeout();
    this.playbackIntent = false;
    this.queue = [];
    this.queueIndex = -1;
    this.clearSource();
  }
}
