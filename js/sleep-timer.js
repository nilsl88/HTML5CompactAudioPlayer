export class SleepTimer {
  constructor({ media, getVolume, canFade, onChange, onTick, onNotice }) {
    this.media = media;
    this.getVolume = getVolume;
    this.canFade = canFade;
    this.onChange = onChange;
    this.onTick = onTick;
    this.onNotice = onNotice;
    this.generation = 0;
    this.mode = "off";
    this.endAt = 0;
    this.minutes = 0;
    this.chapterEnd = null;
    this.timeout = null;
    this.ticker = null;
    this.completing = false;
  }

  clear() {
    this.generation++;
    clearTimeout(this.timeout);
    clearInterval(this.ticker);
    this.timeout = null;
    this.ticker = null;
    if (this.completing) this.media.setVolume(this.getVolume());
    this.completing = false;
    this.mode = "off";
    this.endAt = 0;
    this.minutes = 0;
    this.chapterEnd = null;
  }

  cancel(silent = false) {
    const wasActive = this.mode !== "off";
    this.clear();
    this.onChange();
    if (wasActive && !silent) this.onNotice("sleepTimerCanceled");
  }

  startMinutes(minutes) {
    this.clear();
    this.mode = "minutes";
    this.minutes = minutes;
    this.endAt = Date.now() + minutes * 60000;
    this.timeout = setTimeout(() => void this.complete("sleepTimerEnded"), minutes * 60000);
    this.ticker = setInterval(this.onTick, 30000);
    this.onChange();
    this.onNotice("sleepTimerSet", "success", { m: minutes });
  }

  startChapter(end) {
    if (!Number.isFinite(end) || end <= this.media.position()) {
      this.onNotice("sleepEndChapterUnavailable", "warning");
      return;
    }
    this.clear();
    this.mode = "chapter";
    this.chapterEnd = end;
    this.onChange();
    this.onNotice("sleepEndChapterSet", "success");
  }

  onTime(position) {
    if (this.mode === "chapter" && position >= this.chapterEnd - .05) void this.complete("sleepEndChapterReached");
  }

  onEnded() {
    if (this.mode === "chapter") void this.complete("sleepEndChapterReached", false);
  }

  async complete(messageKey, fade = true) {
    if (this.completing) return;
    this.completing = true;
    const generation = this.generation;
    clearTimeout(this.timeout);
    clearInterval(this.ticker);
    if (fade && this.canFade()) {
      const volume = this.getVolume();
      for (let step = 7; step >= 0; step--) {
        this.media.setVolume(volume * step / 8);
        await new Promise((resolve) => setTimeout(resolve, 120));
        if (generation !== this.generation) return;
      }
    }
    this.media.requestPause();
    this.clear();
    this.onChange();
    this.onNotice(messageKey);
  }
}
