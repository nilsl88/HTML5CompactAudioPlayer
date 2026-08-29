import test from "node:test";
import assert from "node:assert/strict";
import { MediaController } from "../js/media-controller.js";

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

test("initial buffering stays in loading state", async () => {
  const audio = new FakeAudio();
  const media = new MediaController(audio, {}, { sourceTimeoutMs: 1000 });
  await media.setSelection(sources, "opus-128", 0, false);
  await media.requestPlay();
  audio.emit("waiting");
  assert.equal(media.state, "loading");
  media.destroy();
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
