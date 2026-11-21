import { chooseDefaultSource } from "./source-selection.js";
import { normalizeLanguageTag } from "./utils.js";

function preferredSource(sources, id) {
  return sources.find((source) => source.url && source.id === id && source.availability !== "missing") || chooseDefaultSource(sources);
}

export class BookSelection {
  constructor({ bookId, book, sources, preferences, downloaded, browserLanguages, saveSelection }) {
    this.bookId = bookId;
    this.byLanguage = sources;
    this.saveSelection = saveSelection;
    const offline = downloaded?.episodeId === bookId && String(downloaded.cacheVersion) === String(book.cacheVersion) ? downloaded : null;
    const languages = [offline?.languageCode, preferences.language, ...browserLanguages.map(normalizeLanguageTag), book.defaultLanguage];
    this.languageCode = languages.find((code) => sources.has(code));
    const savedAudio = offline && this.sources.find((source) => source.id === offline.sourceId && source.url === offline.sourceUrl);
    this.source = savedAudio || preferredSource(this.sources, preferences.quality);
    if (!this.source) throw new Error("No configured audio source can be selected for this browser.");
    this.preferredId = this.source.id;
  }

  get sources() { return this.byLanguage.get(this.languageCode) || []; }

  selectLanguage(code) {
    const source = preferredSource(this.byLanguage.get(code) || [], this.source.id);
    if (!source) return null;
    this.languageCode = code;
    this.remember(source);
    return source;
  }

  selectQuality(id) {
    const source = this.sources.find((candidate) => candidate.id === id);
    if (!source || source === this.source) return null;
    this.remember(source);
    return source;
  }

  remember(source) {
    this.source = source;
    this.preferredId = source.id;
    this.saveSelection(this.bookId, this.languageCode, source.id);
  }

  confirmPlayed(source) {
    if (source === this.source && source.id !== this.preferredId) this.remember(source);
  }
}
