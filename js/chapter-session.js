import { loadChapters, parseChapterText } from "./chapters.js";
import { resolveLanguageAsset } from "./config.js";

export class ChapterSession {
  constructor({ fetchImpl, readCache, writeCache, onStart, onLoaded, onFailure }) {
    this.fetchImpl = fetchImpl;
    this.readCache = readCache;
    this.writeCache = writeCache;
    this.onStart = onStart;
    this.onLoaded = onLoaded;
    this.onFailure = onFailure;
    this.generation = 0;
    this.reset();
  }

  reset(book = null, languageCode = "", source = null) {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.pending = null;
    this.notifyFailure = false;
    this.status = "idle";
    this.cues = [];
    this.activeIndex = -1;
    const language = book?.languages[languageCode];
    this.mode = language?.chapterSource || "none";
    this.url = resolveLanguageAsset(language, language?.chapters);
    this.source = source;
    this.cacheKey = [book?.id, languageCode, book?.cacheVersion, this.sourceKey(source)];
  }

  sourceKey(source) {
    if (this.mode === "embedded") return `embedded:${source?.url || ""}`;
    if (this.mode === "auto") return `auto:${this.url}|${source?.url || ""}`;
    return this.url;
  }

  needsSource(source) {
    return ["embedded", "auto"].includes(this.mode) &&
      (this.sourceKey(source) !== this.sourceKey(this.source) || this.status === "failed");
  }

  get unavailable() {
    return this.mode === "none" || (this.mode === "vtt" && !this.url);
  }

  accept(result) {
    this.status = "loaded";
    this.cues = result.cues;
    this.onLoaded(result);
  }

  load({ force = false, notifyFailure = true } = {}) {
    if (this.pending) {
      this.notifyFailure ||= notifyFailure;
      return this.pending;
    }
    if (this.status === "loaded" || (this.status === "failed" && !force)) return Promise.resolve();
    if (this.unavailable) {
      this.accept({ kind: "none", cues: [], text: "" });
      return Promise.resolve();
    }
    const vttUrl = this.mode === "embedded" ? "" : this.url;
    const cached = !force && this.readCache(...this.cacheKey, vttUrl);
    if (cached) {
      const parsed = cached.kind === "vtt" ? parseChapterText(cached.text) : cached;
      if (parsed) {
        this.accept({ ...parsed, kind: cached.kind });
        return Promise.resolve();
      }
    }
    const controller = new AbortController();
    this.controller = controller;
    this.generation += 1;
    this.status = "loading";
    this.notifyFailure = notifyFailure;
    this.onStart();
    this.pending = this.fetch(controller, force || Boolean(cached));
    return this.pending;
  }

  async fetch(controller, revalidate) {
    try {
      const result = await loadChapters({ mode: this.mode, vttUrl: this.url, sourceUrl: this.source?.url,
        sourceMime: this.source?.mime, signal: controller.signal, fetchImpl: this.fetchImpl, revalidate });
      if (controller.signal.aborted) return;
      this.writeCache(...this.cacheKey, result, this.url);
      this.accept(result);
    } catch (error) {
      if (controller.signal.aborted) return;
      this.status = "failed";
      this.onFailure(error, this.notifyFailure);
    } finally {
      if (this.controller === controller) {
        this.controller = null;
        this.pending = null;
      }
    }
  }

  get activeTitle() {
    return this.cues[this.activeIndex]?.title || "";
  }

  updatePosition(position, duration) {
    const index = this.indexAt(position, duration);
    if (index === this.activeIndex) return false;
    this.activeIndex = index;
    return true;
  }

  seekTarget(direction, position, duration) {
    if (direction === "next") return this.cues.find((cue) => cue.start > position + .05)?.start;
    const index = this.lastStarted(position);
    const restart = index >= 0 && (position >= this.end(index, duration) || position - this.cues[index].start > 3);
    return this.cues[restart ? index : Math.max(0, index - 1)]?.start;
  }

  lastStarted(position) {
    let index = -1;
    while (index + 1 < this.cues.length && this.cues[index + 1].start <= position) index++;
    return index;
  }

  end(index, duration) {
    return this.cues[index].end ?? this.cues[index + 1]?.start ?? (duration || Infinity);
  }

  indexAt(position, duration) {
    for (let index = this.lastStarted(position); index >= 0; index--) {
      if (position < this.end(index, duration)) return index;
    }
    return -1;
  }
}
