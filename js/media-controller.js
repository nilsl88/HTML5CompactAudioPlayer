import { SourceFallback } from "./source-selection.js";
import { clamp } from "./utils.js";

export class MediaController {
  constructor(audio, callbacks = {}, { sourceTimeoutMs = 15000, isOnline = () => globalThis.navigator?.onLine !== false } = {}) {
    this.audio = audio;
    this.callbacks = callbacks;
    this.sourceTimeoutMs = sourceTimeoutMs;
    this.isOnline = isOnline;
    this.generation = 0;
    this.playAttempt = 0;
    this.fallback = new SourceFallback();
    this.playbackIntent = false;
    this.desiredTime = 0;
    this.playbackRate = 1;
    this.volume = 1;
    this.loaded = false;
    this.hasStarted = false;
    this.reloadOnReconnect = false;
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
      this.callbacks.onTime?.(this.position(), this.duration());
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
      const state = this.hasStarted ? "stalled" : "loading";
      if (this.state === state && this.timeout !== null) return;
      this.setState(state);
      this.armTimeout(this.generation, this.currentSource()?.url);
    };
    listen("waiting", handleBuffering);
    listen("stalled", handleBuffering);
    listen("ended", () => { this.playbackIntent = false; this.clearTimeout(); this.setState("ended"); this.callbacks.onEnded?.(); });
    listen("timeupdate", () => {
      // Reloading a source can emit timeupdate at zero before metadata arrives.
      if (!this.loaded || this.audio.seeking) return;
      if (Number.isFinite(this.audio.currentTime)) {
        if (this.awaitingPlayback && this.hasStarted && !this.audio.paused && this.audio.currentTime > this.waitPosition) {
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
    this.fallback = new SourceFallback(sources, selectedId);
    this.desiredTime = Math.max(0, Number(position) || 0);
    this.playbackIntent = Boolean(shouldPlay && this.currentSource());
    this.clearTimeout();
    if (this.playbackIntent) return this.loadSource(this.currentSource(), true);
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
    const source = this.currentSource();
    if (this.events.signal.aborted || !source) return Promise.resolve(false);
    this.playbackIntent = true;
    if (this.fallback.exhausted) {
      this.generation += 1;
      return this.loadSource(this.fallback.restart(), true);
    }
    if (this.reloadOnReconnect && this.isOnline()) {
      this.generation += 1;
      return this.loadSource(source, true);
    }
    if (!this.audio.src) return this.loadSource(source, true);
    if (this.state === "paused" || this.state === "ended" || !this.hasStarted) {
      this.setState("loading");
      this.armTimeout(this.generation, source.url);
    } else if (this.state === "stalled" && this.timeout === null) {
      this.armTimeout(this.generation, source.url);
    }
    return this.playCurrent(this.generation, source.url);
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
    if (this.awaitingPlayback) return this.requestPlay();
  }

  clearSource() {
    this.reloadOnReconnect = false;
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

  currentSource() { return this.fallback.current; }

  async loadSource(source, shouldPlay) {
    const generation = this.generation;
    this.reloadOnReconnect = false;
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
    if (!this.audio.src || !this.currentSource()) return;
    const code = this.audio.error?.code || 0;
    this.failCurrent(this.audio.error || new Error("Media source failed"), code === 3 || code === 4, this.currentSource()?.url);
  }

  async failCurrent(error, skipCodec = false, expectedUrl = this.currentSource()?.url) {
    const failed = this.currentSource();
    if (!failed || failed.url !== expectedUrl || this.fallback.exhausted) return false;
    if (!this.isOnline()) {
      if (this.audio.error || skipCodec) this.reloadOnReconnect = true;
      if (!this.playbackIntent) return false;
      this.setState("stalled");
      this.callbacks.onOffline?.();
      return false;
    }
    const next = this.fallback.afterFailure(skipCodec);
    this.callbacks.onSourceFailure?.(failed, error);
    if (!next) {
      this.clearTimeout();
      this.playbackIntent = false;
      this.setState("error");
      this.callbacks.onExhausted?.(error);
      return false;
    }
    this.callbacks.onFallback?.(failed, next);
    return this.loadSource(next, this.playbackIntent);
  }

  seek(seconds) {
    if (this.events.signal.aborted) return this.position();
    const duration = this.duration();
    this.desiredTime = duration ? clamp(Number(seconds) || 0, 0, Math.max(0, duration - .01)) : Math.max(0, Number(seconds) || 0);
    if (this.awaitingPlayback) this.waitPosition = this.desiredTime;
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
  get awaitingPlayback() { return this.playbackIntent && (this.state === "loading" || this.state === "stalled"); }
  setState(state) {
    if (state === this.state) return;
    this.state = state;
    if (this.awaitingPlayback) this.waitPosition = this.position();
    this.callbacks.onState?.(state);
  }
  armTimeout(generation, url) {
    this.clearTimeout();
    this.timeout = setTimeout(() => {
      this.timeout = null;
      if (generation !== this.generation || this.currentSource()?.url !== url) return;
      if (!this.isOnline()) { this.setState("stalled"); this.callbacks.onOffline?.(); return; }
      if (!this.loaded || this.awaitingPlayback) this.failCurrent(new Error("Audio source timed out"), false, url);
    }, this.sourceTimeoutMs);
  }
  clearTimeout() { if (this.timeout) clearTimeout(this.timeout); this.timeout = null; }
  destroy() {
    if (this.events.signal.aborted) return;
    this.events.abort();
    this.generation += 1;
    this.clearTimeout();
    this.playbackIntent = false;
    this.fallback = new SourceFallback();
    this.clearSource();
  }
}
