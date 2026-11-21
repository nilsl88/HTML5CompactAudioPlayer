import { resolveCover } from "./config.js";
import { loadEmbeddedMp4Cover } from "./mp4-chapters.js";

export function createCoverView(image, button, { fetchImpl, getEmbeddedSource, onShown, onFailure }) {
  let coverGeneration = 0;
  let coverController = null;
  let coverObjectUrl = "";

  function clearCover() {
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
    clearCover();
    onFailure(error);
  }

  async function applyEmbeddedCover(generation) {
    const source = getEmbeddedSource();
    if (!source?.url) {
      coverFailed(generation);
      return;
    }
    const controller = new AbortController();
    coverController = controller;
    try {
      const cover = await loadEmbeddedMp4Cover(source.url, { fetchImpl, signal: controller.signal });
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

  function applyCover(book) {
    clearCover();
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

  return { applyCover, clearCover };
}
