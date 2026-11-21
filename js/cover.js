import { resolveCover } from "./config.js";
import { loadEmbeddedMp4Cover } from "./mp4-chapters.js";

export function createCoverView(image, button, { fetchImpl, onShown, onFailure }) {
  let coverGeneration = 0;
  let coverController = null;
  let coverObjectUrl = "";
  let currentBook = null;
  let currentLanguage = "";
  let sourceUrl = "";
  let usingEmbedded = false;

  function clearImage() {
    coverGeneration += 1;
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
    clearImage();
    onFailure(error);
  }

  async function applyEmbeddedCover(generation) {
    usingEmbedded = true;
    if (!sourceUrl) {
      coverFailed(generation);
      return;
    }
    const controller = new AbortController();
    coverController = controller;
    try {
      const cover = await loadEmbeddedMp4Cover(sourceUrl, { fetchImpl, signal: controller.signal, cacheVersion: currentBook.cacheVersion });
      if (controller.signal.aborted || generation !== coverGeneration) return;
      if (!cover) throw new Error("The M4A/M4B file does not contain supported cover artwork.");
      coverObjectUrl = URL.createObjectURL(new Blob([cover.data], { type: cover.mime }));
      showCoverImage(coverObjectUrl, generation, () => coverFailed(generation, new Error("The embedded cover image could not be decoded.")));
    } catch (error) {
      if (error?.name !== "AbortError") coverFailed(generation, error);
    } finally {
      if (coverController === controller) coverController = null;
    }
  }

  function applyCover(book, language, source) {
    const previousUrl = sourceUrl;
    sourceUrl = source?.url || "";
    if (currentBook === book && currentLanguage === language) {
      if (usingEmbedded && button.hidden && previousUrl !== sourceUrl) {
        clearImage();
        void applyEmbeddedCover(coverGeneration);
      }
      return;
    }
    currentBook = book;
    currentLanguage = language;
    usingEmbedded = false;
    clearImage();
    const generation = coverGeneration;
    const mode = book.coverSource;
    if (mode === "none") return;
    const configuredCover = resolveCover(book);
    if ((mode === "file" || mode === "auto") && configuredCover) {
      showCoverImage(configuredCover, generation, () => {
        if (mode === "auto") void applyEmbeddedCover(generation);
        else coverFailed(generation);
      });
      return;
    }
    if (mode === "embedded" || mode === "auto") void applyEmbeddedCover(generation);
  }

  function clearCover() {
    currentBook = null;
    clearImage();
  }

  return { applyCover, clearCover };
}
