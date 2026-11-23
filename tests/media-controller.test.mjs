import test from "node:test";
import assert from "node:assert/strict";
import { MediaController } from "../js/media-controller.js?v=20";

class FakeAudio extends EventTarget {
  src = "";
  preload = "none";
  paused = true;
  ended = false;
  currentTime = 0;
  duration = Number.NaN;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  volume = 1;
  error = null;
  playImpl = async () => {};
  load() { this.dispatchEvent(new Event("loadstart")); }
  pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
  async play() { this.paused = false; this.dispatchEvent(new Event("play")); return this.playImpl(this.src); }
  removeAttribute(name) { if (name === "src") this.src = ""; }
  emit(type) { this.dispatchEvent(new Event(type)); }
}

const sources = [
  { id: "opus-128", codec: "opus", bitrate: 128, url: "opus.webm", availability: "unknown" },
  { id: "opus-96", codec: "opus", bitrate: 96, url: "opus-low.webm", availability: "unknown" },
  { id: "aac-128", codec: "aac", bitrate: 128, url: "audio.m4a", availability: "unknown" },
  { id: "mp3-128", codec: "mp3", bitrate: 128, url: "audio.mp3", availability: "unknown" },
];

test("a last-source failure after Pause waits for Play before reporting exhaustion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const start of ["only", "last"]) {
    const audio = new FakeAudio();
    const notices = [];
    const candidates = start === "only" ? [sources[0]] : sources.slice(0, 2);
    const media = new MediaController(audio, { onExhausted: () => notices.push("exhausted") }, { sourceTimeoutMs: 100 });
    await media.setSelection(candidates, candidates[0].id, 23, true);
    if (start === "last") {
      audio.error = { code: 2 };
      audio.emit("error");
    }
    const lastSource = media.currentSource().id;
    media.requestPause();
    audio.error = { code: 2 };
    audio.emit("error");
    assert.equal(media.state, "paused", start);
    assert.equal(media.playbackIntent, false);
    assert.deepEqual(notices, []);
    t.mock.timers.tick(1000);
    assert.deepEqual(notices, []);
    await media.requestPlay();
    assert.equal(media.currentSource().id, candidates[0].id);
    assert.notEqual(audio.src, "");
    assert.ok(lastSource);
    media.destroy();
  }
  const audio = new FakeAudio();
  const notices = [];
  const media = new MediaController(audio, { onExhausted: () => notices.push("exhausted") });
  await media.setSelection([sources[0]], sources[0].id, 0, true);
  audio.error = { code: 2 };
  audio.emit("error");
  assert.equal(media.state, "error");
  assert.deepEqual(notices, ["exhausted"]);
  media.destroy();
});

test("offline first Play loads only the validated saved source and preserves lazy loading and seeking", async (t) => {
  const audio = new FakeAudio();
  const attempts = [];
  audio.playImpl = async (url) => { attempts.push(url); };
  const media = new MediaController(audio, { savedSourceUrl: () => "saved-audio" }, { isOnline: () => false });
  t.after(() => media.destroy());
  await media.setSelection([sources[0]], "opus-128", 23, false);
  assert.equal(audio.src, "");
  assert.deepEqual(attempts, []);
  await media.requestPlay();
  assert.deepEqual(attempts, ["saved-audio"]);
  audio.emit("loadedmetadata");
  media.seek(30);
  assert.equal(media.position(), 30);
  assert.equal(media.currentSource().url, "opus.webm");
});

test("the next transport Play starts a saved source that became available after a source-less stall", async (t) => {
  const audio = new FakeAudio();
  const attempts = [];
  let savedUrl = "";
  let online = false;
  audio.playImpl = async (url) => { attempts.push(url); };
  const media = new MediaController(audio, {
    savedSourceUrl: () => savedUrl,
    allowNetworkSource: () => online,
  }, { isOnline: () => online });
  t.after(() => media.destroy());
  const source = sources[0];

  await media.setSelection([source], source.id, 31);
  await media.togglePlayback();
  assert.equal(media.state, "stalled");
  assert.equal(media.awaitingPlayback, true);
  assert.equal(audio.src, "");
  assert.deepEqual(attempts, []);
  savedUrl = "saved-audio";
  const play = media.togglePlayback();
  assert.deepEqual(attempts, [savedUrl], "Play still reaches the audio element within the user gesture");
  await play;
  assert.equal(media.position(), 31);
  await media.togglePlayback();
  assert.equal(media.state, "paused");
  assert.deepEqual(attempts, [savedUrl]);

  for (const paused of [false, true]) {
    online = false;
    savedUrl = "";
    await media.setSelection([source], source.id, 31);
    await media.togglePlayback();
    if (paused) media.requestPause();
    online = true;
    await media.handleReconnect();
    assert.equal(audio.src, paused ? "" : source.url);
  }
});

test("reconnection starts a fresh saved-source attempt after an offline failure", async (t) => {
  let online = false;
  let savedReady = false;
  const audio = new FakeAudio();
  const attempts = [];
  audio.playImpl = async (url) => {
    attempts.push(url);
    if (url === "opus.webm" || !savedReady) throw new DOMException("Unavailable", "NetworkError");
  };
  const media = new MediaController(audio, { savedSourceUrl: () => "saved-audio" }, { isOnline: () => online });
  t.after(() => media.destroy());
  await media.setSelection([sources[0]], "opus-128", 15, true);
  assert.equal(media.state, "stalled");
  assert.deepEqual(attempts, ["saved-audio"]);
  online = true;
  savedReady = true;
  await media.handleReconnect();
  assert.deepEqual(attempts, ["saved-audio", "opus.webm", "saved-audio"]);
  assert.equal(media.usingSavedSource, true);
  assert.equal(media.position(), 15);
});

test("losing the network uses a matching saved source on media error and timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const reason of ["error", "timeout"]) {
    const audio = new FakeAudio();
    let online = true;
    const saved = "https://example.test/saved";
    const media = new MediaController(audio, { savedSourceUrl: () => saved },
      { isOnline: () => online, sourceTimeoutMs: 100 });
    await media.setSelection(sources, "opus-128", 12, true);
    audio.emit("loadedmetadata");
    audio.emit("playing");
    audio.currentTime = 22;
    audio.emit("timeupdate");
    online = false;
    if (reason === "error") {
      audio.error = { code: 2 };
      audio.emit("error");
    } else {
      audio.emit("waiting");
      t.mock.timers.tick(100);
    }
    assert.equal(audio.src, saved, reason);
    assert.equal(media.currentSource().id, "opus-128");
    assert.equal(media.position(), 22);
    assert.equal(media.playbackIntent, true);
    media.destroy();
  }
  const audio = new FakeAudio();
  const media = new MediaController(audio, {}, { isOnline: () => false });
  await media.setSelection(sources, "opus-128", 12, true);
  audio.error = { code: 2 };
  audio.emit("error");
  assert.equal(media.state, "stalled");
  assert.equal(audio.src, "opus.webm");
  media.destroy();

  const retryAudio = new FakeAudio();
  let online = false;
  const attempts = [];
  retryAudio.playImpl = async (url) => {
    attempts.push(url);
    if (url === "saved-audio") throw new DOMException("Unavailable", "NetworkError");
  };
  const retry = new MediaController(retryAudio, { savedSourceUrl: () => "saved-audio" }, { isOnline: () => online });
  await retry.setSelection(sources, "opus-128", 12, true);
  await retry.failCurrent(new DOMException("Offline", "NetworkError"));
  assert.equal(retry.state, "stalled");
  assert.deepEqual(attempts, ["saved-audio"]);
  online = true;
  await retry.handleReconnect();
  assert.deepEqual(attempts, ["saved-audio", "opus.webm"]);
  retry.destroy();
});

test("a new Play retries the saved copy after the fallback queue is exhausted", async (t) => {
  const audio = new FakeAudio();
  const attempts = [];
  let savedAvailable = false;
  const media = new MediaController(audio, { savedSourceUrl: () => "saved-audio" });
  t.after(() => media.destroy());
  audio.playImpl = async (url) => {
    attempts.push(url);
    if (url !== "saved-audio" || !savedAvailable) throw new DOMException("unavailable", "NetworkError");
  };
  await media.setSelection([sources[0]], "opus-128", 23, true);
  assert.deepEqual(attempts, ["opus.webm", "saved-audio"]);
  assert.equal(media.state, "error");
  savedAvailable = true;
  await media.requestPlay();
  assert.deepEqual(attempts, ["opus.webm", "saved-audio", "opus.webm", "saved-audio"]);
  assert.equal(media.usingSavedSource, true);
  assert.equal(media.position(), 23);
});

test("a failed online source tries the matching saved copy once before codec fallback", async (t) => {
  const audio = new FakeAudio();
  const savedUrl = "https://example.test/__compact_player_offline__/audio.json?download=one";
  const media = new MediaController(audio, { savedSourceUrl: () => savedUrl });
  t.after(() => media.destroy());
  const attempts = [];
  audio.playImpl = async (url) => {
    attempts.push(url);
    if (url === "opus.webm" || url === savedUrl) throw new DOMException("unavailable", "NetworkError");
  };
  await media.setSelection(sources, "opus-128", 12, true);
  assert.deepEqual(attempts.slice(0, 3), ["opus.webm", savedUrl, "opus-low.webm"]);
  assert.equal(media.currentSource().id, "opus-96");
  assert.equal(media.desiredTime, 12);
});

test("an offline copy that fails after reconnect retries the same recording online", async (t) => {
  let online = false;
  let rejectSaved;
  const savedPlay = new Promise((_, reject) => { rejectSaved = reject; });
  const audio = new FakeAudio();
  const attempts = [];
  audio.playImpl = (url) => {
    attempts.push(url);
    return url === "saved-audio" ? savedPlay : Promise.resolve();
  };
  const media = new MediaController(audio, { savedSourceUrl: () => "saved-audio" }, { isOnline: () => online });
  t.after(() => media.destroy());
  const play = media.setSelection([sources[0]], sources[0].id, 45, true);
  assert.deepEqual(attempts, ["saved-audio"]);
  online = true;
  const reconnect = media.handleReconnect();
  rejectSaved(new DOMException("The saved download was removed", "NotSupportedError"));
  await Promise.all([play, reconnect]);
  assert.equal(attempts.at(-1), sources[0].url);
  audio.emit("loadedmetadata");
  audio.emit("playing");
  assert.equal(media.state, "playing");
  assert.equal(media.position(), 45);
});

test("a saved copy's decode error does not reject an otherwise untested codec", async (t) => {
  const audio = new FakeAudio();
  const attempts = [];
  audio.playImpl = async (url) => {
    attempts.push(url);
    if (url === sources[0].url) throw new DOMException("Unavailable", "NetworkError");
    if (url === "saved-audio") throw new DOMException("Corrupt copy", "NotSupportedError");
  };
  const media = new MediaController(audio, { savedSourceUrl: (source) => source === sources[0] ? "saved-audio" : null });
  t.after(() => media.destroy());
  await media.setSelection(sources, sources[0].id, 0, true);
  assert.deepEqual(attempts, [sources[0].url, "saved-audio", sources[1].url]);
});

test("a saved copy that fails after a connection loss gets one fresh online attempt", async (t) => {
  const source = sources[0];
  for (const restoredSourceWorks of [true, false]) {
    const audio = new FakeAudio();
    const attempts = [];
    let online = true;
    const media = new MediaController(audio, { savedSourceUrl: () => "saved-audio" }, { isOnline: () => online });
    t.after(() => media.destroy());
    audio.playImpl = async (url) => {
      attempts.push(url);
      if (attempts.length === 3 && !restoredSourceWorks) throw new DOMException("Unavailable", "NetworkError");
      audio.currentTime = 0;
      audio.emit("loadedmetadata");
      audio.emit("playing");
    };
    await media.setSelection([source], source.id, 30, true);
    online = false;
    audio.error = { code: 2 };
    audio.emit("error");
    assert.deepEqual(attempts, [source.url, "saved-audio"]);
    assert.equal(media.state, "playing");
    audio.currentTime = 35;
    audio.emit("timeupdate");

    online = true;
    await media.handleReconnect();
    audio.error = { code: 3 };
    audio.emit("error");
    await new Promise(setImmediate);

    assert.deepEqual(attempts, [source.url, "saved-audio", source.url]);
    assert.equal(media.position(), 35);
    assert.equal(media.state, restoredSourceWorks ? "playing" : "error");
  }
});

test("Play after a saved-source failure uses the latest download without reconnecting", async (t) => {
  const audio = new FakeAudio();
  let savedUrl = "removed-copy";
  const attempts = [];
  audio.playImpl = async (url) => {
    attempts.push(url);
    if (url === "removed-copy") throw new DOMException("This download is no longer active", "NotSupportedError");
  };
  const media = new MediaController(audio, { savedSourceUrl: () => savedUrl }, { isOnline: () => false });
  t.after(() => media.destroy());
  await media.setSelection([sources[0]], sources[0].id, 31, true);
  assert.equal(media.state, "stalled");
  media.requestPause();
  savedUrl = "replacement-copy";
  await media.requestPlay();
  assert.deepEqual(attempts, ["removed-copy", "replacement-copy"]);
  assert.equal(media.position(), 31);
});

test("a decode error retries the saved edition once before skipping the codec", async (t) => {
  const audio = new FakeAudio();
  const attempts = [];
  const media = new MediaController(audio, { savedSourceUrl: () => "saved-audio" });
  t.after(() => media.destroy());
  audio.playImpl = async (url) => {
    attempts.push(url);
    if (url === "opus.webm" || url === "saved-audio") throw new DOMException("Unsupported", "NotSupportedError");
  };
  await media.setSelection(sources, "opus-128", 0, true);
  assert.deepEqual(attempts.slice(0, 3), ["opus.webm", "saved-audio", "audio.m4a"]);
  assert.equal(media.currentSource().id, "aac-128");
});

test("a late network failure cannot load a saved copy for a newer selection", async (t) => {
  const audio = new FakeAudio();
  let rejectPrevious;
  const previous = new Promise((_, reject) => { rejectPrevious = reject; });
  let savedChecks = 0;
  const media = new MediaController(audio, { savedSourceUrl: () => { savedChecks++; return "saved-audio"; } });
  t.after(() => media.destroy());
  audio.playImpl = (url) => url === "opus.webm" ? previous : Promise.resolve();
  const pending = media.setSelection(sources, "opus-128", 3, true);
  await media.setSelection(sources, "aac-128", 7, true);
  rejectPrevious(new DOMException("Offline", "NetworkError"));
  await pending;
  assert.equal(audio.src, "audio.m4a");
  assert.equal(media.desiredTime, 7);
  assert.equal(savedChecks, 0);
});

test("does not report playing until the media element emits playing", async () => {
  const audio = new FakeAudio();
  const states = [];
  const media = new MediaController(audio, { onState: (state) => states.push(state) }, { sourceTimeoutMs: 1000 });
  await media.setSelection(sources, "opus-128", 18, false);
  await media.requestPlay();
  assert.notEqual(media.state, "playing");
  audio.emit("playing");
  assert.equal(media.state, "playing");
  media.destroy();
});

test("an external audio pause clears playback intent while a source switch preserves it", async (t) => {
  const audio = new FakeAudio();
  const media = new MediaController(audio);
  t.after(() => media.destroy());
  await media.setSelection(sources, "opus-128", 0, true);
  audio.emit("playing");
  await media.setSelection(sources, "aac-128", 0, true);
  audio.emit("pause"); // A queued event from pausing the previous source.
  assert.equal(audio.paused, false);
  assert.equal(media.playbackIntent, true);
  audio.emit("playing");
  audio.pause();
  assert.equal(media.state, "paused");
  assert.equal(media.playbackIntent, false);
  await media.requestPlay();
  audio.emit("playing");
  assert.equal(media.state, "playing");
  assert.equal(media.currentSource().id, "aac-128");
});

test("initial buffering stays in loading state", async () => {
  const audio = new FakeAudio();
  const media = new MediaController(audio, {}, { sourceTimeoutMs: 1000 });
  await media.setSelection(sources, "opus-128", 0, false);
  await media.requestPlay();
  audio.emit("waiting");
  assert.equal(media.state, "loading");
  media.destroy();
});

test("each Play after pause gets a deadline until playback advances again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const audio = new FakeAudio();
  const media = new MediaController(audio, {}, { sourceTimeoutMs: 100 });
  t.after(() => media.destroy());
  await media.setSelection(sources, "opus-128", 12, true);
  audio.emit("loadedmetadata");
  audio.emit("playing");
  media.requestPause();
  audio.playImpl = () => new Promise(() => {});
  void media.requestPlay();
  audio.currentTime = 13;
  audio.emit("timeupdate");
  t.mock.timers.tick(100);
  assert.equal(media.state, "playing");
  assert.equal(media.currentSource().id, "opus-128");
  media.requestPause();
  void media.requestPlay();
  t.mock.timers.tick(100);
  assert.equal(media.currentSource().id, "opus-96");
  assert.equal(media.position(), 13);
});

test("buffering after playback starts is a stall", async () => {
  const audio = new FakeAudio();
  const media = new MediaController(audio, {}, { sourceTimeoutMs: 1000 });
  await media.setSelection(sources, "opus-128", 0, false);
  await media.requestPlay();
  audio.emit("playing");
  audio.emit("waiting");
  assert.equal(media.state, "stalled");
  media.destroy();
});

test("time updates at a stalled position preserve the fallback deadline until playback advances", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const audio = new FakeAudio();
  const media = new MediaController(audio, {}, { sourceTimeoutMs: 100 });
  t.after(() => media.destroy());
  await media.setSelection(sources, "opus-128", 0, true);
  audio.emit("playing");
  audio.currentTime = 12;
  audio.emit("waiting");
  audio.emit("timeupdate");
  assert.equal(media.state, "stalled");
  audio.currentTime = 13;
  audio.emit("timeupdate");
  assert.equal(media.state, "playing");
  t.mock.timers.tick(100);
  assert.equal(media.currentSource().id, "opus-128");
  audio.emit("waiting");
  t.mock.timers.tick(75);
  audio.emit("stalled");
  audio.emit("timeupdate");
  t.mock.timers.tick(25);
  assert.equal(media.currentSource().id, "opus-96");
});

test("NotAllowedError stops without walking the fallback queue", async () => {
  const audio = new FakeAudio();
  const blocked = [];
  audio.playImpl = async () => { const error = new Error("blocked"); error.name = "NotAllowedError"; throw error; };
  const media = new MediaController(audio, { onBlocked: (error) => blocked.push(error) }, { sourceTimeoutMs: 1000 });
  await media.setSelection(sources, "opus-128", 0, false);
  await media.requestPlay();
  assert.equal(blocked.length, 1);
  assert.equal(media.currentSource().id, "opus-128");
  assert.equal(media.playbackIntent, false);
  media.destroy();
});

test("a blocked Play stays paused past the source timeout and can retry the same source", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const audio = new FakeAudio();
  const failures = [];
  const media = new MediaController(audio, { onSourceFailure: (source) => failures.push(source.id) }, { sourceTimeoutMs: 100 });
  t.after(() => media.destroy());
  audio.playImpl = async () => { throw new DOMException("Press Play", "NotAllowedError"); };
  await media.setSelection(sources, "opus-128");
  await media.requestPlay();
  t.mock.timers.tick(1000);
  assert.deepEqual(failures, []);
  assert.equal(media.state, "paused");
  assert.equal(media.playbackIntent, false);
  audio.playImpl = async () => {};
  await media.requestPlay();
  audio.emit("playing");
  assert.equal(media.currentSource().id, "opus-128");
  assert.equal(media.state, "playing");
});

test("fallback defers missing URLs across codecs and skips every variant of a rejected codec", async (t) => {
  for (const lateProbe of [false, true]) {
    for (const code of [2, 3]) {
      const audio = new FakeAudio();
      const attempts = [];
      const files = sources.map((source) => ({ ...source, availability: "available" }));
      const media = new MediaController(audio, { onSourceChange: (source) => attempts.push(source.id) });
      t.after(() => media.destroy());
      if (!lateProbe) files[1].availability = "missing";
      await media.setSelection(files, "opus-128", 20, true);
      files[1].availability = "missing";
      audio.error = { code };
      audio.emit("error");
      assert.equal(media.currentSource().id, "aac-128");
      audio.error = { code: 2 };
      for (let i = 0; i < files.length && media.state !== "error"; i++) audio.emit("error");
      assert.deepEqual(attempts, ["opus-128", "aac-128", "mp3-128", ...(code === 2 ? ["opus-96"] : [])]);
      assert.equal(media.state, "error");
      await media.requestPlay();
      assert.equal(media.currentSource().id, "opus-128");
      media.destroy();
    }
  }
});

test("a source error after Pause defers loading and timeout until the next Play", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const audio = new FakeAudio();
  const failures = [];
  const media = new MediaController(audio, { onSourceFailure: (source) => failures.push(source.id) }, { sourceTimeoutMs: 100 });
  await media.setSelection(sources, "opus-128", 33, true);
  media.requestPause();
  audio.error = { code: 2 };
  audio.emit("error");
  assert.equal(media.currentSource().id, "opus-96");
  assert.equal(audio.src, "");
  t.mock.timers.tick(1000);
  assert.equal(media.state, "paused");
  assert.deepEqual(failures, ["opus-128"]);
  assert.equal(media.position(), 33);
  await media.requestPlay();
  assert.equal(audio.src, "opus-low.webm");
  t.mock.timers.tick(100);
  assert.deepEqual(failures, ["opus-128", "opus-96"]);
  media.destroy();
});

test("decode rejection skips the failed codec family", async () => {
  const audio = new FakeAudio();
  const fallbacks = [];
  audio.playImpl = async (src) => { if (src.includes("opus")) { const error = new Error("unsupported"); error.name = "NotSupportedError"; throw error; } };
  const media = new MediaController(audio, { onFallback: (_old, next) => fallbacks.push(next.id) }, { sourceTimeoutMs: 1000 });
  await media.setSelection(sources, "opus-128", 33, false);
  await media.requestPlay();
  assert.equal(media.currentSource().id, "aac-128");
  assert.deepEqual(fallbacks, ["aac-128"]);
  media.destroy();
});

test("late rejection from an old selection cannot fail the new source", async () => {
  const audio = new FakeAudio();
  let rejectOld;
  audio.playImpl = (src) => src === "opus.webm" ? new Promise((_resolve, reject) => { rejectOld = reject; }) : Promise.resolve();
  const media = new MediaController(audio, {}, { sourceTimeoutMs: 1000 });
  await media.setSelection(sources, "opus-128", 0, false);
  const firstPlay = media.requestPlay();
  await media.setSelection(sources, "aac-128", 10, true);
  const error = new Error("late"); error.name = "NotSupportedError"; rejectOld(error);
  await firstPlay;
  assert.equal(media.currentSource().id, "aac-128");
  media.destroy();
});

test("seek before metadata is applied after metadata loads", async () => {
  const audio = new FakeAudio();
  const media = new MediaController(audio, {}, { sourceTimeoutMs: 1000 });
  await media.setSelection(sources, "mp3-128", 0, false);
  media.seek(52);
  await media.requestPlay();
  audio.duration = 120;
  audio.emit("loadedmetadata");
  assert.equal(audio.currentTime, 52);
  media.destroy();
});

test("an explicit retry rebuilds the queue after exhaustion", async () => {
  const audio = new FakeAudio();
  let shouldFail = true;
  audio.playImpl = async () => { if (shouldFail) { const error = new Error("network"); error.name = "NetworkError"; throw error; } };
  const media = new MediaController(audio, {}, { sourceTimeoutMs: 1000 });
  await media.setSelection([sources[0]], "opus-128", 0, false);
  await media.requestPlay();
  assert.equal(media.state, "error");
  shouldFail = false;
  await media.requestPlay();
  assert.equal(media.currentSource().id, "opus-128");
  assert.equal(media.playbackIntent, true);
  media.destroy();
});

test("offline media errors preserve the active source for recovery", async () => {
  const audio = new FakeAudio();
  let online = false;
  const media = new MediaController(audio, {}, { sourceTimeoutMs: 1000, isOnline: () => online });
  await media.setSelection(sources, "opus-128", 0, false);
  await media.requestPlay();
  audio.error = { code: 2 };
  audio.emit("error");
  assert.equal(media.currentSource().id, "opus-128");
  assert.equal(media.state, "stalled");
  assert.equal(media.playbackIntent, true);
  online = true;
  media.destroy();
});

test("reconnect reloads a terminally failed source once and restores its position", async (t) => {
  for (const pause of [false, true]) {
    const audio = new FakeAudio();
    let online = true;
    const loads = [];
    audio.load = () => {
      loads.push(audio.src);
      audio.error = null;
      audio.currentTime = 0;
    };
    audio.playImpl = async () => {
      if (audio.error) throw new DOMException("Failed resource", "NotSupportedError");
    };
    const media = new MediaController(audio, {}, { isOnline: () => online });
    t.after(() => media.destroy());
    await media.setSelection(sources, "aac-128", 30, true);
    media.setPlaybackRate(1.5);
    audio.emit("loadedmetadata");
    audio.emit("playing");
    audio.currentTime = 42;
    audio.emit("timeupdate");
    online = false;
    audio.error = { code: 4 };
    audio.emit("error");
    if (pause) media.requestPause();
    online = true;
    await media.handleReconnect();
    if (pause) {
      assert.deepEqual(loads, ["audio.m4a"]);
      await media.requestPlay();
    }
    await media.handleReconnect();
    assert.deepEqual(loads, ["audio.m4a", "audio.m4a"]);
    audio.emit("loadedmetadata");
    audio.emit("playing");
    assert.equal(media.state, "playing");
    assert.equal(audio.currentTime, 42);
    assert.equal(audio.playbackRate, 1.5);
    audio.error = { code: 4 };
    audio.emit("error");
    assert.equal(loads.at(-1), "opus.webm");
  }
});

test("a stall that timed out offline gets a new fallback deadline on reconnect", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const outcome of ["pause", "progress", "still stalled"]) {
    let online = true;
    const audio = new FakeAudio();
    const media = new MediaController(audio, {}, { sourceTimeoutMs: 100, isOnline: () => online });
    t.after(() => media.destroy());
    await media.setSelection(sources, "opus-128", 0, true);
    audio.emit("playing");
    audio.currentTime = 12;
    audio.emit("timeupdate");
    online = false;
    audio.emit("waiting");
    t.mock.timers.tick(100);
    assert.equal(media.currentSource().id, "opus-128");
    if (outcome === "pause") media.requestPause();
    online = true;
    await media.handleReconnect();
    if (outcome === "progress") {
      audio.currentTime = 13;
      audio.emit("timeupdate");
    }
    t.mock.timers.tick(100);
    assert.equal(media.currentSource().id, outcome === "still stalled" ? "opus-96" : "opus-128");
    assert.equal(media.playbackIntent, outcome !== "pause");
    assert.equal(media.position(), outcome === "progress" ? 13 : 12);
    media.destroy();
  }
});

test("source reload time updates cannot erase a pending chapter seek", async () => {
  const audio = new FakeAudio();
  const media = new MediaController(audio, {}, { sourceTimeoutMs: 1000 });
  try {
    await media.setSelection(sources, "opus-128", 0, true);
    audio.duration = 7200;
    audio.emit("loadedmetadata");
    audio.emit("playing");
    media.seek(1873.685);
    audio.load = () => {
      audio.currentTime = 0;
      audio.duration = Number.NaN;
      audio.emit("timeupdate");
      audio.emit("loadstart");
    };
    await media.failCurrent(new Error("Range request failed"));
    assert.equal(media.position(), 1873.685);
    assert.equal(media.loaded, false);
    audio.duration = 7200;
    audio.emit("loadedmetadata");
    assert.equal(audio.currentTime, 1873.685);
    assert.equal(media.playbackIntent, true);
  } finally { media.destroy(); }
});

test("paused chapter seeks survive zero-time events before the first Play", async () => {
  const audio = new FakeAudio();
  const media = new MediaController(audio, {}, { sourceTimeoutMs: 1000 });
  try {
    await media.setSelection(sources, "aac-128", 0, false);
    media.seek(2193.255);
    audio.emit("timeupdate");
    assert.equal(media.position(), 2193.255);
    await media.requestPlay();
    audio.duration = 7200;
    audio.emit("loadedmetadata");
    assert.equal(audio.currentTime, 2193.255);
  } finally { media.destroy(); }
});
