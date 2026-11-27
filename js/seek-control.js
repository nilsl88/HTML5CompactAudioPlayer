import { clamp, formatTime, setText, UNKNOWN_TIME } from "./utils.js?v=25";

export function createSeekControl({ slider, currentTime, durationTime, t, readPosition, readDuration, onSeek }) {
  let enabled = false;
  let previewing = false;

  function renderTime(position, duration) {
    const positionText = formatTime(position);
    const durationText = duration ? formatTime(duration) : UNKNOWN_TIME;
    const accessibleTime = duration ? t("seekPosition", { position: positionText, duration: durationText }) : positionText;
    slider.setAttribute("aria-valuetext", accessibleTime);
    setText(currentTime, positionText);
    setText(durationTime, durationText);
  }

  function previewPosition(duration) {
    return duration * Number(slider.value) / 1000;
  }

  function render(position = readPosition(), knownDuration = readDuration()) {
    const duration = enabled ? knownDuration : 0;
    slider.disabled = !duration;
    if (!duration) previewing = false;
    if (previewing) position = previewPosition(duration);
    else slider.value = duration ? String(Math.round(clamp(position / duration, 0, 1) * 1000)) : "0";
    renderTime(position, duration);
  }

  slider.addEventListener("input", () => {
    previewing = true;
    const duration = readDuration();
    renderTime(previewPosition(duration), duration);
  });
  slider.addEventListener("change", () => {
    previewing = false;
    onSeek(previewPosition(readDuration()));
  });
  slider.addEventListener("pointercancel", () => {
    if (!previewing) return;
    previewing = false;
    render();
  });

  return {
    render,
    lock() { enabled = false; previewing = false; },
    unlock() { enabled = true; },
  };
}
