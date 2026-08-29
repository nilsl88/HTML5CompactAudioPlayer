# Compact Audio Player

A dependency-free audiobook and podcast player for static websites. It supports multiple audio languages, WebVTT chapters, selectable quality, codec fallback, saved progress, and accessible custom controls.

Production uses plain HTML, CSS, and JavaScript. There is no build step and no runtime package dependency.

## Features

<p align="center">
  <img src="preview.webp" alt="Compact Audio Player preview">
</p>

- Play and pause with lazy audio loading
- Seek bar, current time, duration, and configurable skip buttons
- Previous/next chapter and chapter selection from WebVTT
- Audio-language and quality selection
- Opus, AAC/M4A, and MP3 sources
- Deterministic runtime source fallback
- Playback speed and supported programmatic volume control
- Timed sleep and sleep at the end of a chapter
- Cover image and full-size cover dialog
- System, light, and dark themes with three text sizes
- English, Danish, Norwegian Bokmål, and Swedish interface text
- Optional audiobook selector through `media/library.json`
- Optional Media Session lock-screen controls
- Saved progress per episode and audio language
- Safe preference and availability caching
- Keyboard controls, focus management, offline feedback, and reduced-motion support

The player does not provide adaptive streaming, a playback queue, or transcript rendering.

## Run locally

ES modules require an HTTP server. Direct `file://` use is not supported.

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080/`.

The example configuration references audio files that are not committed to this repository. Add the configured files under `media/episode-001/<language>/` to test playback.

## Project structure

```text
index.html              Semantic player markup and dialogs
player.css              Responsive layout and design tokens
player.js               Application coordinator and DOM event wiring
i18n.js                 Interface strings
js/
  availability.js       HEAD and Range availability probes
  config.js             Configuration validation and normalization
  dialogs.js            Dialog, panel, and focus behavior
  media-controller.js   Sole owner of audio source, seek, and play transitions
  source-selection.js   MIME evidence, quality display, and fallback ordering
  storage.js            Safe persistence and legacy migration
  utils.js              Shared utilities and abortable fetch retries
  vtt.js                WebVTT chapter parser
tests/                  Node built-in tests; no test packages required
media/                  Library, episode, cover, and chapter data
```

`player.js` coordinates the modules but does not assign `audio.src`, call `audio.load()`, seek the element, or call `audio.play()` directly. Those operations belong to `media-controller.js` so source changes follow one path.

## Episode configuration

Store each episode at `media/<folder>/episode.json`.

Required fields:

- `id`: stable episode identifier
- `defaultLanguage`: language code used when no saved or browser match exists
- `languages`: map of language code to language configuration

Common optional fields:

- `title`: localized title map
- `cover`: path or HTTP(S) URL; image data URLs are also accepted
- `duration`: duration hint in seconds
- `cacheVersion`: change this when audio files are added or removed
- `debug.showAllQualities`: show all codec families and technical details
- `ui.onboardingEnabled`: disable the first-visit help dialog when `false`

Example:

```json
{
  "id": "episode-001",
  "defaultLanguage": "en",
  "title": {
    "en": "Episode 001",
    "da": "Episode 001"
  },
  "cover": "./episode-001.webp",
  "duration": 3600,
  "cacheVersion": 1,
  "debug": {
    "showAllQualities": false
  },
  "ui": {
    "onboardingEnabled": true
  },
  "languages": {
    "en": {
      "label": "English",
      "basePath": "media/episode-001/en/",
      "chapters": "chapters.vtt",
      "sources": {
        "opus": {
          "96": "audio-96k.webm",
          "128": "audio-128k.webm"
        },
        "aac": {
          "96": "audio-96k.m4a",
          "128": "audio-128k.m4a"
        },
        "mp3": {
          "96": "audio-96k.mp3",
          "128": "audio-128k.mp3"
        }
      }
    }
  }
}
```

### Language fields

- `label`: visible language name
- `basePath`: optional base for source and chapter paths; resolved from the site root
- `chapters`: WebVTT file name or URL
- `sources`: map of codec, bitrate, and file path

Without `basePath`, source and chapter paths are resolved from the episode folder.

Supported codec keys are `opus`, `aac`, and `mp3`. MIME types are derived as follows:

- WebM Opus: `audio/webm; codecs="opus"`
- Ogg Opus: `audio/ogg; codecs="opus"`
- AAC/M4A: `audio/mp4; codecs="mp4a.40.2"`
- MP3: `audio/mpeg`

Unknown fields are ignored. Invalid languages, bitrate entries, unsafe URL schemes, and empty source maps are rejected during normalization without changing the documented schema.

## Optional library

Add `media/library.json` to show an audiobook selector when more than one valid entry exists:

```json
{
  "default": "episode-001",
  "audiofiles": [
    {
      "id": "episode-001",
      "folder": "episode-001",
      "title": {
        "en": "Audiobook 1",
        "da": "Lydbog 1"
      }
    }
  ]
}
```

The current `audiofiles` field remains the documented format. Older `episodes` and `items` collection names, plus `defaultId`, `path`, `label`, and related aliases, are still accepted.

Use `?episode=<id>` to select an episode. Query values not present in the library are restricted to safe single-folder identifiers.

## WebVTT chapters

Chapters load when the user opens the chapter panel, uses chapter navigation, or selects sleep at chapter end. Chapter loading never blocks audio playback.

```vtt
WEBVTT

00:00:00.000 --> 00:05:12.000
Introduction

00:05:12.000 --> 00:18:30.000
Chapter 1
```

The parser accepts cue identifiers, cue settings, multiline titles, comma or period millisecond separators, and NOTE, STYLE, and REGION blocks. Malformed cues are skipped. Chapter text is rendered as text, not HTML.

## Source selection and fallback

`canPlayType()` provides initial evidence, not a guarantee. There are no iOS-version codec rules.

The initial codec preference is:

1. Opus
2. AAC
3. MP3

The normal quality selector shows one codec family. Set `debug.showAllQualities` to `true` when inspecting every configured source.

For each source transition, the player creates a finite queue:

1. The selected source
2. Other bitrates from that codec, ordered by distance from the selected bitrate
3. Remaining codec families in preference order

A confirmed decode or unsupported-source failure skips the rest of that codec family. A network/source failure may try another bitrate before moving to the next codec. Each URL is attempted once per transition.

`NotAllowedError` stops automatic attempts and asks the user to press Play again. Old Promise rejections, media events, probes, chapter loads, and episode responses are ignored after a newer generation takes ownership.

## Lazy loading

The audio element starts with `preload="none"` and no `src`.

- Page load does not assign an audio source.
- Language or quality changes before playback only update the pending selection.
- Seeking or choosing a chapter before metadata updates the pending start time.
- The first Play action assigns the source and calls `play()` within the same user gesture.
- Source changes while playing preserve position, playback rate, and playback intent.

Browsers control actual buffering and may treat `preload` as a hint after a source is assigned.

## Availability probing

Availability is advisory. Each source is `available`, `missing`, or `unknown`.

1. The player tries an abortable HEAD request.
2. If HEAD is inconclusive, it sends `Range: bytes=0-0` and cancels the response body after the headers arrive.

HTTP 200/206 and authenticated 401/403 responses remain playable candidates. HTTP 404/410 from both probe paths marks a source missing. CORS, proxy, timeout, and offline failures stay unknown.

The player never creates temporary audio elements to probe files. A successful media load overrides a probe result, and even cached missing sources remain at the end of the runtime fallback queue.

Only the active audio language is scanned. Changing language cancels stale probe work and starts a scan for the new selection.

Results are cached for seven days. Change `cacheVersion` or use `?clearAvailCache=1` to discard the current episode cache. The old `?resetProbe=1` parameter is accepted as a harmless no-op because session-wide probe disabling no longer exists.

## Storage

All storage access is guarded. Unavailable storage, malformed JSON, obsolete values, and quota errors cannot stop startup.

The player reads and migrates these existing keys:

- `compactPlayer:<episode>`: language, quality, and progress by audio language
- `compactPlayer:ui`: theme, text size, player language, speed, volume, and skip interval
- `compactPlayer:lastEpisode`: last library selection
- `compactAudioPlayer.onboardingShown.v1`: onboarding state
- `cap_avail_*`: legacy availability cache

New objects include `schemaVersion: 2`. Availability writes use `compactPlayer:availability:<episode>:<cacheVersion>`. Reset removes current and legacy player keys.

Progress writes are throttled and flushed when the page is hidden or left.

## Accessibility and keyboard controls

Controls use native buttons, labels, fieldsets, outputs, sections, and dialogs. Chapter and sleep panels use ordinary button semantics instead of ARIA menu behavior.

- `Space`: play or pause when focus is outside a control
- `Arrow Left` / `Arrow Right`: seek five seconds
- `Escape`: close an open panel or dialog
- `Tab` / `Shift+Tab`: normal document and modal focus movement

Panels place focus inside when opened and restore it to their trigger when closed by Escape or a close action. Dialogs use the native modal API with a focus-trap fallback. Status announcements are deduplicated to avoid repeated screen-reader output.

The layout supports 320 CSS px viewports, browser zoom, long labels, safe-area insets, reduced motion, and forced-colors mode. Primary controls use 44 CSS pixel targets.

## Browser behavior and limitations

- Playback always requires a user action. The player does not attempt autoplay.
- iOS and iPadOS expose `audio.volume` but do not apply programmatic changes. The volume control is hidden there.
- Media Session is optional. Unsupported actions or metadata failures do not affect normal playback.
- Lock-screen controls, background playback, interruptions, route changes, and app switching remain controlled by the operating system and browser.
- Cross-origin configuration, chapter, image, and audio servers must permit the requests they receive. Authentication and CORS policies vary by deployment.
- Device codec support can differ from `canPlayType()` results. Runtime fallback is the final authority.

## Tests

Run the dependency-free checks with:

```bash
node --check player.js
for file in i18n.js js/*.js tests/*.mjs; do node --check "$file"; done
node --test
```

The tests cover:

- Configuration and legacy library normalization
- URL and MIME handling
- Storage migration, corruption, and availability cache compatibility
- WebVTT parsing
- Source selection and fallback order
- blocked playback and codec rejection
- stale play Promise rejection after a newer source selection
- seeking before metadata
- duplicate HTML IDs and label associations
- CSS custom-property references
- production dependency and lazy-preload checks

## Manual device matrix

Automated tests do not prove operating-system media behavior. Before a production release, test with real audio files on:

- iPhone Safari: first Play, source changes, lock screen, background/foreground, interruptions, and volume-control visibility
- iPad Safari: the same flows in portrait, landscape, split view, and with a hardware keyboard
- Android Chrome, Firefox, and Samsung Internet: touch ranges, app switching, screen lock, network loss, and Media Session controls
- macOS Safari, Chrome, Firefox, and Edge: keyboard controls, codec fallback, storage reload, dialogs, zoom, and offline recovery

Also test 320, 360, 390, and 430 CSS pixel widths, tablet layouts, 200% zoom, long translated titles, reduced motion, and high-contrast/forced-colors modes.
