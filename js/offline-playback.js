import { manifestMatchesSelection, sameOfflineBook } from "./offline-selection.js?v=25";

export function createOfflinePlayback({ routes, getActive, isSupported, hasController, waitForPublished }) {
  const coversBook = (saved, episodeId, book) => sameOfflineBook(saved,
    { episodeId, configBookId: book.id, cacheVersion: book.cacheVersion });
  return {
    savedSource(selection) {
      const saved = getActive();
      return manifestMatchesSelection(saved, selection) ? routes.savedAudio(saved) : null;
    },
    allowNetworkSource: () => routes.allowNetworkSource(),
    coverUrl: (source, episodeId, book) => routes.coverUrl(source, episodeId, book),
    async canUseCachedCover(episodeId, book) {
      await waitForPublished();
      return coversBook(getActive(), episodeId, book);
    },
    async canUseNativeCover(episodeId, book) {
      if (!hasController()) return true;
      await waitForPublished();
      const saved = getActive();
      return isSupported() && (!saved || coversBook(saved, episodeId, book));
    },
    connectionChanged: () => routes.prepare(getActive()),
  };
}
