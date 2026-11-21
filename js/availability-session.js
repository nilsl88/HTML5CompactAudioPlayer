import { scanSources } from "./availability.js";

export class AvailabilitySession {
  constructor({ window, fetchImpl, isOnline, readCache, writeCache, onChange, onError }) {
    this.window = window;
    this.isOnline = isOnline;
    this.fetchImpl = fetchImpl;
    this.readCache = readCache;
    this.writeCache = writeCache;
    this.onChange = onChange;
    this.onError = onError;
    this.scanned = new Set();
    this.played = new Set();
    this.selectLanguage("");
  }

  setBook(book, sources) {
    this.selectLanguage("");
    this.book = book;
    this.sources = sources;
    this.scanned.clear();
    const cached = this.readCache(book.id, book.cacheVersion);
    this.played = new Set(cached.playedUrls);
    for (const [code, variants] of sources) {
      for (const source of variants) {
        const value = cached.byLanguage[code]?.[source.id];
        if (this.played.has(source.url) || value === true) source.availability = "available";
        else if (value === false) source.availability = "missing";
        else if (["available", "missing", "unknown"].includes(value)) source.availability = value;
      }
    }
  }

  save() {
    const byLanguage = {};
    for (const [code, sources] of this.sources) {
      byLanguage[code] = Object.fromEntries(sources.map((source) => [source.id, source.availability]));
    }
    this.writeCache(this.book.id, this.book.cacheVersion, byLanguage, [...this.played]);
  }

  markPlayed(source) {
    if (!this.language || !source || this.played.has(source.url)) return;
    this.played.add(source.url);
    for (const variants of this.sources.values()) {
      for (const candidate of variants) if (candidate.url === source.url) candidate.availability = "available";
    }
    this.save();
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
    const sources = this.sources.get(this.language).filter((source) => !this.played.has(source.url));
    try {
      await scanSources(sources, {
        signal: controller.signal, fetchImpl: this.fetchImpl,
        onResult: (result, index) => {
          if (this.played.has(result.url)) return;
          sources[index].availability = result.availability;
          this.save();
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
