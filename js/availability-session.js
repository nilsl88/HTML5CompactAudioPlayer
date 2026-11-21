import { scanSources } from "./availability.js";
import { buildSources } from "./source-selection.js";

export class AvailabilitySession {
  constructor({ window, fetchImpl, isOnline, openCache, onChange, onError }) {
    this.window = window;
    this.isOnline = isOnline;
    this.fetchImpl = fetchImpl;
    this.openCache = openCache;
    this.onChange = onChange;
    this.onError = onError;
    this.scanned = new Set();
    this.played = new Set();
    this.selectLanguage("");
  }

  prepareBook(book, audio) {
    const cache = this.openCache(book.id, book.cacheVersion);
    const played = new Set();
    const sources = new Map();
    for (const language of Object.values(book.languages)) {
      const variants = buildSources(language, audio);
      for (const source of variants) {
        if (cache.hasPlayed(source.url)) played.add(source.url);
        source.availability = played.has(source.url) ? "available" : cache.readProbe(language.code, source.id, source.url);
      }
      sources.set(language.code, variants);
    }
    return { cache, sources, played };
  }

  setBook({ cache, sources, played }) {
    this.selectLanguage("");
    this.scanned.clear();
    this.cache = cache;
    this.sources = sources;
    this.played = played;
  }

  markPlayed(source) {
    if (!this.language || !source) return;
    this.cache.recordPlayback(source.url, this.language, source.id);
    if (this.played.has(source.url)) return;
    this.confirmAvailable(source.url);
  }

  confirmAvailable(url) {
    this.played.add(url);
    for (const variants of this.sources.values()) {
      for (const candidate of variants) if (candidate.url === url) candidate.availability = "available";
    }
  }

  cancel() {
    this.cancelIdle?.();
    this.cancelIdle = null;
    this.controller?.abort();
    this.controller = null;
  }

  selectLanguage(language) {
    if (language !== this.language) this.urgent = false;
    this.language = language;
    this.waitForChapters();
  }

  waitForChapters() {
    this.waiting = true;
    this.cancel();
  }

  chaptersSettled() {
    this.waiting = false;
    this.request();
  }

  request({ immediate = false, refresh = false } = {}) {
    if (refresh) this.scanned.delete(this.language);
    if (!this.language || !this.isOnline() || this.scanned.has(this.language) || this.controller) return;
    this.urgent ||= immediate;
    if (this.waiting) return;
    if (this.urgent) {
      this.cancelIdle?.();
      void this.scan();
    } else if (!this.cancelIdle) {
      const run = () => { void this.scan(); };
      if (this.window.requestIdleCallback && this.window.cancelIdleCallback) {
        const id = this.window.requestIdleCallback(run, { timeout: 3000 });
        this.cancelIdle = () => this.window.cancelIdleCallback(id);
      } else {
        const id = setTimeout(run, 1500);
        this.cancelIdle = () => clearTimeout(id);
      }
    }
  }

  async scan() {
    this.cancelIdle = null;
    this.urgent = false;
    if (!this.isOnline()) return;
    const controller = new AbortController();
    this.controller = controller;
    const language = this.language;
    const sources = this.sources.get(language).filter((source) => !this.played.has(source.url));
    try {
      await scanSources(sources, {
        signal: controller.signal, fetchImpl: this.fetchImpl,
        onResult: (result, index) => {
          this.cache.recordProbe(language, result.id, result.availability, result.url);
          if (this.played.has(result.url)) return;
          if (this.cache.hasPlayed(result.url)) this.confirmAvailable(result.url);
          else sources[index].availability = result.availability;
          this.onChange();
        },
      });
      if (!controller.signal.aborted) this.scanned.add(this.language);
    } catch (error) {
      if (!controller.signal.aborted) this.onError(error);
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}
