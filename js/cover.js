import { resolveCover } from "./config.js?v=20";
import { loadEmbeddedMp4Cover } from "./mp4-chapters.js?v=20";
import "./offline-manifest.js?v=20";

export function createCoverView(image, button, { fetchImpl, isOnline = () => true, getBookId, getFileCoverUrl, canUseCachedCover, canUseNativeCover, onShown, onFailure }) {
  let coverGeneration = 0;
  let coverController = null;
  let coverObjectUrl = "";
  let currentBook = null;
  let currentLanguage = "";
  let sourceUrl = "";
  let usingEmbedded = false;
  let coverNeedsRetry = false;
  let pendingOfflineCover = false;
  let reconnectSourceUrl = null;

  function clearImage() {
    coverGeneration += 1;
    coverNeedsRetry = false;
    pendingOfflineCover = false;
    reconnectSourceUrl = null;
    coverController?.abort();
    coverController = null;
    if (coverObjectUrl) URL.revokeObjectURL(coverObjectUrl);
    coverObjectUrl = "";
    button.hidden = true;
    image.onload = null;
    image.onerror = null;
    image.removeAttribute("src");
    image.alt = "";
  }

  function showCoverImage(src, generation, onFailure) {
    image.onload = () => {
      if (generation !== coverGeneration) return;
      pendingOfflineCover = false;
      reconnectSourceUrl = null;
      button.hidden = false;
      onShown();
    };
    image.onerror = () => {
      if (generation === coverGeneration) onFailure();
    };
    image.src = src;
  }

  function coverFailed(generation, error) {
    if (generation !== coverGeneration) return;
    if (reconnectSourceUrl !== null && currentBook && isOnline()) {
      sourceUrl = reconnectSourceUrl;
      loadCover(currentBook);
      return;
    }
    clearImage();
    coverNeedsRetry = true;
    onFailure(error);
  }

  function fileCoverUrl(source, book) {
    if (getFileCoverUrl) return getFileCoverUrl(source, book);
    const browser = image.ownerDocument?.defaultView;
    if (!browser?.location?.href) return source;
    return new URL(source).origin === browser.location.origin ? null : source;
  }

  async function loadFileCoverFallback(source, book, generation, onError) {
    const controller = new AbortController();
    coverController = controller;
    try {
      const response = await fetchImpl(source, { mode: "no-cors", cache: "no-cache", credentials: "same-origin", signal: controller.signal });
      if (response.type === "opaque") {
        if (!await canUseNativeCover?.(book)) throw new Error("The cover image could not be checked against the downloaded book.");
        if (!controller.signal.aborted && generation === coverGeneration) showCoverImage(source, generation, onError);
        return;
      }
      if (!response.ok) throw new Error("The cover image could not be loaded.");
      const { checkResponseVersion, versionHeader } = globalThis.CompactPlayerOfflineManifest;
      checkResponseVersion(response, book.cacheVersion);
      if (response.headers.get(versionHeader) != null && !await canUseCachedCover?.(book)) {
        throw new Error("The downloaded cover belongs to a different book.");
      }
      const blob = await response.blob();
      if (controller.signal.aborted || generation !== coverGeneration) return;
      coverObjectUrl = URL.createObjectURL(blob);
      showCoverImage(coverObjectUrl, generation, onError);
    } catch (error) {
      if (!controller.signal.aborted && generation === coverGeneration) onError(error);
    } finally {
      if (coverController === controller) coverController = null;
    }
  }

  async function applyEmbeddedCover(generation) {
    usingEmbedded = true;
    if (!sourceUrl) {
      coverFailed(generation);
      return;
    }
    pendingOfflineCover ||= !isOnline();
    const controller = new AbortController();
    coverController = controller;
    try {
      const bookIdentity = { episodeId: getBookId?.() || currentBook.id, configBookId: currentBook.id };
      const cover = await loadEmbeddedMp4Cover(sourceUrl, {
        fetchImpl, signal: controller.signal, cacheVersion: currentBook.cacheVersion, bookIdentity,
      });
      if (controller.signal.aborted || generation !== coverGeneration) return;
      if (!cover) throw new Error("The M4A/M4B file does not contain supported cover artwork.");
      coverObjectUrl = URL.createObjectURL(new Blob([cover.data], { type: cover.mime }));
      showCoverImage(coverObjectUrl, generation, () => coverFailed(generation, new Error("The embedded cover image could not be decoded.")));
    } catch (error) {
      if (!controller.signal.aborted) coverFailed(generation, error);
    } finally {
      if (coverController === controller) coverController = null;
    }
  }

  function applyCover(book, language, source) {
    const previousUrl = sourceUrl;
    sourceUrl = source?.url || "";
    if (currentBook === book && currentLanguage === language) {
      if (usingEmbedded && previousUrl !== sourceUrl) {
        clearImage();
        void applyEmbeddedCover(coverGeneration);
      } else if (reconnectSourceUrl !== null) {
        reconnectSourceUrl = sourceUrl;
      }
      return;
    }
    currentBook = book;
    currentLanguage = language;
    loadCover(book);
  }

  function loadCover(book) {
    usingEmbedded = false;
    clearImage();
    const generation = coverGeneration;
    const mode = book.coverSource;
    if (mode === "none") return;
    const configuredCover = resolveCover(book);
    if ((mode === "file" || mode === "auto") && configuredCover) {
      pendingOfflineCover = !isOnline();
      const url = fileCoverUrl(configuredCover, book);
      const fail = (error) => {
        if (mode === "auto") void applyEmbeddedCover(generation);
        else coverFailed(generation, error);
      };
      if (!url) {
        void loadFileCoverFallback(configuredCover, book, generation, fail);
        return;
      }
      showCoverImage(url, generation, url === configuredCover ? fail : () => {
        void loadFileCoverFallback(configuredCover, book, generation, fail);
      });
      return;
    }
    if (mode === "embedded" || mode === "auto") void applyEmbeddedCover(generation);
  }

  function retryCover(source) {
    if (!currentBook || !isOnline()) return;
    const nextSourceUrl = source?.url || "";
    if (coverNeedsRetry) {
      sourceUrl = nextSourceUrl;
      loadCover(currentBook);
    } else if (pendingOfflineCover) {
      reconnectSourceUrl = nextSourceUrl;
    }
  }

  function clearCover() {
    currentBook = null;
    clearImage();
  }

  return { applyCover, retryCover, clearCover };
}
