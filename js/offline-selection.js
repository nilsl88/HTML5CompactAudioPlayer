import { parseBookConfig } from "./config.js";
import { buildSources } from "./source-selection.js";
import { normalizeLanguageTag } from "./utils.js";
import "./offline-manifest.js";

const { validManifest } = globalThis.CompactPlayerOfflineManifest;

function matchesDownloadLanguage(manifest, code) {
  if (manifest.languageTag) return manifest.languageTag === code;
  return manifest.languageCode === code || manifest.languageCode === normalizeLanguageTag(code);
}

export function matchesDownloadedSource(manifest, code, source) {
  return matchesDownloadLanguage(manifest, code) && manifest.sourceId === source.id && manifest.sourceUrl === source.url;
}

export function sameOfflineSelection(manifest, selection) {
  return Boolean(manifest && selection) && manifest.episodeId === selection.episodeId
    && (!manifest.configBookId || !selection.configBookId || manifest.configBookId === selection.configBookId)
    && matchesDownloadLanguage(manifest, selection.languageCode)
    && manifest.sourceId === selection.sourceId
    && manifest.sourceUrl === selection.sourceUrl
    && String(manifest.cacheVersion) === String(selection.cacheVersion);
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
