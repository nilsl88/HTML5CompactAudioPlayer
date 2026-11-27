import { parseBookConfig } from "./config.js?v=25";
import { buildSources } from "./source-selection.js?v=25";
import { normalizeLanguageTag } from "./utils.js?v=25";
import "./offline-manifest.js?v=25";

const { validManifest } = globalThis.CompactPlayerOfflineManifest;

function matchesDownloadLanguage(manifest, code) {
  if (manifest.languageTag) return manifest.languageTag === code;
  return manifest.languageCode === code || manifest.languageCode === normalizeLanguageTag(code);
}

export function matchesDownloadedSource(manifest, code, source) {
  return matchesDownloadLanguage(manifest, code) && manifest.sourceId === source.id && manifest.sourceUrl === source.url;
}

export function sameOfflineBook(manifest, book) {
  return Boolean(manifest && book) && manifest.episodeId === book.episodeId
    && (!manifest.configBookId || !book.configBookId || manifest.configBookId === book.configBookId)
    && String(manifest.cacheVersion) === String(book.cacheVersion);
}

export function sameOfflineSelection(manifest, selection) {
  return sameOfflineBook(manifest, selection) && matchesDownloadedSource(manifest, selection.languageCode,
    { id: selection.sourceId, url: selection.sourceUrl });
}

export function manifestMatchesSelection(manifest, selection) {
  return validManifest(manifest) && sameOfflineSelection(manifest, selection);
}

export function validateOfflineBookConfig(text, configUrl, documentBaseUrl, selection) {
  const book = parseBookConfig(text, configUrl, documentBaseUrl);
  // Legacy downloads may only have a catalog alias, without the ID from the configuration.
  if ((selection.configBookId && book.id !== selection.configBookId)
    || String(book.cacheVersion) !== String(selection.cacheVersion)
    || !Object.values(book.languages).some((language) =>
      buildSources(language).some((source) => matchesDownloadedSource(selection, language.code, source)))) {
    throw new Error("The cached book configuration no longer matches the selected audio.");
  }
  return book.id;
}
