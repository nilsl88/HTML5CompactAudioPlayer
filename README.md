# Compact Audio Player

A dependency-free audiobook and podcast player for static websites. It supports multiple audio languages, WebVTT chapters, selectable quality, codec fallback, saved progress, and accessible custom controls.

Production uses plain HTML, CSS, and JavaScript. There is no build step and no runtime package dependency.

## Features

<p align="center">
  <a href="preview.webp">
    <img src="preview.webp" width="50%" alt="Compact Audio Player preview; click to open full size">
  </a>
</p>

- Play and pause with lazy audio loading
- Seek bar, current time, duration, and configurable skip buttons
- Previous/next chapter, chapter selection, and current chapter display from WebVTT or embedded M4A/M4B metadata
- Audio-language and quality selection
- Opus, AAC/M4A, and MP3 sources
- Deterministic runtime source fallback
- Playback speed and supported programmatic volume control
- Timed sleep and sleep at the end of a chapter
- External or embedded M4A/M4B cover artwork and a full-size cover dialog
- System, light, and dark themes with three text sizes
- English, Danish, Norwegian Bokmål, and Swedish interface text
- Optional audiobook selector through `media/library.json`
- Optional Media Session lock-screen controls
- Saved progress per book and audio language
- Safe preference, chapter, and availability caching
- User-initiated offline download for one selected audiobook, language, and quality
- Keyboard controls, focus management, offline feedback, and reduced-motion support

Outside focused controls, Space toggles playback once per press. Left/Right Arrow seeks five seconds and Up/Down Arrow uses the configured skip interval. Hold an arrow key to keep seeking. Escape closes open panels.

The first-visit **How this player works** dialog explains playback, chapters, shortcuts, Options, sleep timer, saved progress, chapter caching, and offline downloads. It also lets the user choose the interface language and audio language before starting. Set `ui.onboardingEnabled` to `false` in `library.json` to disable it for the whole player.

The player does not provide adaptive streaming, a playback queue, or transcript rendering.

## Run locally

ES modules require an HTTP server. Direct `file://` use is not supported.

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080/`.

The example configuration references audio files that are not committed to this repository. Add the configured files under `media/episode-001/<language>/` to test playback.

## Create a new audiobook

The project includes the `create-audiobook` skill at `skills/create-audiobook/SKILL.md`. Use it when adding a new book from an M4A, M4B, or other audio source. A prompt such as `Use create-audiobook. Here is my audiobook: /path/book.m4b` guides the encoder through:

- four Opus WebM, AAC/M4A, and MP3 variants at 64, 96, 128, and 256 kbps
- embedded, WebVTT, or generated time-based chapters
- embedded or external cover-art selection
- a compatible `book.json` and minimal `books` entry in `library.json`
- output and configuration validation with `ffprobe` and Node.js

You can also ask for configuration only or to reuse the original audio. In those cases the skill inspects the existing files and does not encode extra variants.

The skill requires `ffmpeg` and `ffprobe`. It keeps the input file unchanged and does not commit or push generated files unless requested.

### Generate chapters for a book without them

`tools/make-chapters.py` writes a WebVTT chapter file for audio that has no chapter metadata. It splits the book into chapters of equal length, none longer than 20 minutes, then moves each boundary to the longest pause in the narration nearby. A chapter starts between sentences instead of in the middle of one.

```bash
python3 tools/make-chapters.py "media/my-book/My Book.mp3"
```

The file is written as `chapters.vtt` next to the audio. Use `-o` for another path, `--max-minutes` for a different limit, and `--title "Section {n}"` to replace the default `Part {n}` titles. An existing chapter file is kept unless you pass `--force`. The script rejects any output path that points to the input audio, including symbolic and hard links.

On mounts without hard-link support, a failed copy removes its partial output so you can retry the command.

The titles are numbered parts because the script cannot tell where the book's own chapters begin. If the audio already has embedded chapters, use those.

The script needs Python 3, `ffmpeg`, and `ffprobe`. It decodes the whole file once to find the pauses, about a minute for a twelve-hour book, and never changes the audio. For a variable-bitrate MP3 without a length header it prints a warning: browsers estimate positions in such a file and may land a few seconds from a chapter start.

Afterwards, edit the language in `book.json`: set `chapterSource` to `vtt`, point `chapters` at the new file, and raise `cacheVersion`. One chapter file covers the Opus, AAC, and MP3 encodings of the same recording.

## Project structure

```text
index.html              Semantic player markup and dialogs
player.css              Responsive layout and design tokens
player.js               Starts the player with the current browser window and storage
sw.js                   Network-first requests, app shell installation, and offline routing
i18n.js                 Interface strings, language selection, and native language names
js/
  player-app.js         Player startup, DOM event wiring, and feature coordination
  availability.js       HEAD and Range availability probes
  availability-cache.js  Saved probe results and confirmed playback by audio URL
  availability-session.js  Schedules scans after chapters load and records source availability
  chapters.js           WebVTT and embedded chapter loading
  chapter-session.js    Active source, navigation, and chapter request cancellation
  chapter-cache.js      Chapter records, edition cleanup, and legacy cache migration
  chapter-panel.js      Chapter list, retry focus, and native WebVTT track
  codecs.js             Codec families, MIME hints, and quality labels
  preferences.js        Supported skip intervals and default
  config.js             Configuration validation and normalization
  book-config.js        Book loading, legacy filename fallback, and shared title requests
  book-selection.js     Language and quality choices for the active book
  book-session.js       Catalog, book selection, and configuration refresh
  cover.js              Cover loading, image fallback, and object URL lifetime
  custom-select.js      Select popups, keyboard navigation, and focus restoration
  dialogs.js            Dialog, panel, and focus behavior
  reset-dialog.js       Reset confirmation and retry for each storage backend
  seek-control.js       Seek preview, keyboard input, and accessible time text
  media-session.js      Browser media keys, metadata, and lock-screen position
  media-controller.js   Sole owner of audio source, seek, and play transitions
  http-range.js         Parsing of HTTP Content-Range response headers
  mp4-atoms.js          MP4 box traversal
  mp4-metadata.js       Bounded reads and shared requests for MP4 metadata
  mp4-chapters.js       QuickTime and Nero chapters and embedded cover art
  offline.js            Download lifecycle, cancellation, and recovery
  offline-book-store.js  Stored manifests, audio chunks, validation, and cleanup
  offline-download-space.js  Quota estimates and storage persistence
  offline-journal.js    Published and staged download records in IndexedDB
  offline-inventory.js  Inspect saved downloads, plan repairs, and recheck changes under the write lock
  offline-playback.js   Select saved audio and covers for the active book edition
  offline-tab-sync.js   Share download status and recheck the write lock across tabs
  offline-worker-routes.js  Select and verify routes for saved audio and covers
  offline-selection.js  Match a saved download to the selected book edition and audio
  offline-panel.js      Download, resume, repair, and remove controls
  offline-media-response.js  Serve full or partial audio from saved chunks
  offline-lock.js       Coordinate offline writes across tabs
  offline-manifest.js   Offline storage addresses and manifest validation shared with the worker
  offline-transfer.js   Version checks, range validation, and streamed audio chunks
  offline-damage-recovery.js  Schedule and retry checks for damaged saved audio
  shell-release.js      Player shell installation, validation, and cache recovery
  bounded-response.js   Read decoded responses within a byte limit
  progress-writer.js    Batches listening positions and cancels pending writes on reset
  source-selection.js   MIME evidence, quality display, and fallback ordering
  sleep-timer.js         Timed and end-of-chapter pauses, countdown, and volume fade
  storage.js            Safe preferences, progress, chapter, and availability persistence
  utils.js              Shared utilities and abortable fetch retries
  vtt.js                WebVTT chapter parser
tests/                  Node built-in tests; no test packages required
media/                  Library, book, cover, and chapter data
skills/create-audiobook/ Prompt workflow for encoding a book and generating book.json
tools/make-chapters.py  Time-based WebVTT chapters for audio without chapter metadata
```

`startPlayer()` connects the controls to the player modules. `MediaController` owns the audio element’s source, playback, and seeking.

## Book configuration

Each book has its own `media/<folder>/book.json`. The separate `media/library.json` is a catalog of book IDs and folders, not a second copy of their configuration. This keeps each book's audio, chapters, artwork, and configuration together.

The player prefers `book.json` and accepts the old `episode.json` filename. The bundled example keeps its stable `episode-001` ID and media folder.

Required fields:

- `id`: stable book identifier
- `defaultLanguage`: language code used when no saved or browser match exists
- `languages`: map of language code to language configuration

Use separate keys such as `en-GB` and `en-US` for regional recordings. The player remembers the full tag. If an older preference or a browser language matches only the base language, the player uses the base track when available, then the book's default recording in that language, then the first matching recording. Older downloads also identify the recording by its audio URL and quality.

Common optional fields:

- `title`: localized title map
- `cover`: path or HTTP(S) URL; image data URLs are also accepted
- `coverSource`: `file`, `embedded`, `auto`, or `none`; existing configurations with `cover` default to `file`
- `duration`: duration hint in seconds
- `cacheVersion`: change this when audio or chapter files are updated, added, or removed
- `debug.showAllQualities`: show all codec families and technical details

Example:

```json
{
  "id": "episode-001",
  "defaultLanguage": "en",
  "title": {
    "en": "Book 001",
    "da": "Book 001"
  },
  "coverSource": "auto",
  "cover": "./episode-001.webp",
  "duration": 3600,
  "cacheVersion": 1,
  "debug": {
    "showAllQualities": false
  },
  "languages": {
    "en": {
      "label": "English",
      "basePath": "media/episode-001/en/",
      "chapterSource": "vtt",
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
- `chapterSource`: `vtt`, `embedded`, `auto`, or `none`; defaults to `vtt` when `chapters` is present
- `chapters`: WebVTT file name or URL; used by `vtt` and tried first by `auto`
- `sources`: map of codec, bitrate, and file path

Without `basePath`, source and chapter paths are resolved from the book folder. Paths with parent-directory traversal segments such as `../` are rejected, including percent-encoded forms. Relative paths within the folder and absolute HTTP(S) URLs remain supported.

When replacing an audio file, give the new file a different URL and update the corresponding source path and `cacheVersion`. Browsers can reuse cached audio at the old URL even after the book configuration changes. A new versioned file name works with static hosting. For signed URLs, obtain a new signed URL for the new file and put it in the configuration unchanged. Keep the previous file available while older configurations are still in use. `Cache-Control: no-cache` can request revalidation, but browser media caches do not all behave alike, so it does not guarantee that a changed file at the same URL will be loaded.

Supported codec keys are `opus`, `aac`, and `mp3`. MIME types are derived as follows:

- WebM Opus: `audio/webm; codecs="opus"`
- Ogg Opus (`.ogg` and `.opus`): `audio/ogg; codecs="opus"`
- AAC/M4A/M4B: AAC-LC (`audio/mp4; codecs="mp4a.40.2"`), HE-AAC v1 (`mp4a.40.5`), and HE-AAC v2 (`mp4a.40.29`), with a generic `audio/mp4` fallback
- MP3: `audio/mpeg`

Unknown fields are ignored. Invalid languages, bitrate entries, unsafe URL schemes, and empty source maps are rejected during normalization without changing the documented schema.

### Cover artwork

`coverSource` controls where the player gets the book cover:

- `file` uses the configured `cover` value.
- `embedded` reads artwork from an M4A, M4B, or MP4 audio source.
- `auto` tries the configured cover first and uses embedded artwork only if that image is missing or cannot be decoded.
- `none` hides the cover.

If `coverSource` is omitted, a configuration with `cover` keeps the earlier `file` behavior. A configuration without `cover` defaults to `none`.

Same-origin file covers revalidate the HTTP-cached image. The installed service worker uses a saved image only when its book and `cacheVersion` match the current selection. Without a controlling service worker, the page fetches the same-origin image itself, so its content security policy must allow that origin in `connect-src`. External and data image URLs keep their normal image-loading behavior.

Embedded artwork is read from the MP4 `covr` metadata with bounded HTTP Range requests. JPEG and PNG images up to 10 MB are accepted. Reading artwork runs independently of playback and does not assign or preload the audio element. Chapters and artwork share one `moov` request per audio URL and book `cacheVersion`. The result stays in memory for 30 seconds. When you replace an MP4 at the same URL, change `cacheVersion` so both readers request the new metadata. If the network fails, only a download of the matching version supplies metadata.

When the player switches MP4 sources, it loads the embedded cover from the new file. A loaded file cover stays visible through quality changes. If cover loading fails while offline, the player tries again when the connection returns.

The server must support byte ranges and, for cross-origin audio, expose the required CORS headers. A downloaded M4A/M4B can supply its artwork while offline because the service worker supports byte ranges over the saved audio chunks.

## Optional library

Add `media/library.json` to offer a book selector in Options.

```json
{
  "default": "episode-001",
  "books": [
    { "id": "episode-001" },
    { "id": "episode-002", "folder": "another-book" }
  ]
}
```

Each entry needs a stable `id`. Use `folder` only if the directory name differs. Set titles in each book's `book.json`. To disable the first-visit help across the site, set `ui.onboardingEnabled` to `false`.

Link directly to a book with `?book=episode-002`. On startup, the player checks for a downloaded book when offline, then tries the link, the last selected book, the catalog default, and finally `episode-001`. Existing `?episode=` links and legacy catalogs still work. When both query parameters are supplied, a non-empty `book` takes precedence.

## Updating the player shell

Generate a versioned release in an empty directory.

```sh
node tools/prepare-release.mjs /tmp/compact-player-release
```

Upload the generated files to the player directory in this order.

1. Copy `releases/` alongside the existing release directories.
2. Upload the new `release-<id>.html` and `sw-<id>.js`.
3. Upload `sw.js`, then `index.html`.

Keep `media/`, site configuration, and earlier release paths in place. Open tabs may still need their original files. The worker verifies the new release before using it offline and can fall back to a previous complete release.

If the homepage still opens an older release, open the new `release-<id>.html` directly. If the site uses a Content Security Policy, allow the generated inline import map with a hash or nonce.

## WebVTT chapters

Set the language's `chapterSource` to `vtt` and point `chapters` at the file. One WebVTT file can cover all formats of the same recording.

```vtt
WEBVTT

00:00:00.000 --> 00:05:12.000
Introduction

00:05:12.000 --> 00:18:30.000
Chapter 1
```

Chapters load independently of playback. Update `cacheVersion` after changing the chapter file so the player reads the new cues.

## Embedded M4A/M4B chapters

Set `chapterSource` to `embedded` for QuickTime or Nero chapters in the selected AAC file. Use `auto` to try WebVTT before embedded chapters. The audio server must support byte ranges. For cross-origin audio, expose `Content-Range` via CORS. Use WebVTT if the same chapters should appear for Opus and MP3 too.

## Source selection and fallback

Audio loads when you press Play. The player prefers Opus, then AAC, then MP3, based on browser support. If a source fails, it tries another configured source and keeps the listening position when possible. Availability checks help order those attempts. The quality menu shows the current codec's bitrates by default. Set `debug.showAllQualities` to see the others.

## Offline downloads

In **Options**, choose **Download for offline use** to save the current book, language, and quality. Offline downloads need HTTPS (or localhost), browser storage and service-worker support, and same-origin audio served with byte ranges. The server must return `206 Partial Content` with a valid `Content-Range` and total size.

The player keeps one completed download and one unfinished download. It uses the network first while online and falls back to a saved copy that matches the selection. The completed book remains available while a replacement downloads. **Resume download** reuses intact audio when the server confirms the same version. **Cancel** discards the unfinished copy, and **Remove download** deletes the saved book.

Keep the page open during the transfer. A browser can evict downloaded files or limit storage in private browsing. If a book needs only its configuration again, use **Restore book configuration** in Options.

## Storage

Each installation saves its own preferences and listening positions. Positions are saved per book and audio language. Playback still works when the browser blocks storage. **Reset Player** clears the current installation's settings, progress, and downloads.

## Accessibility and keyboard controls

The player supports keyboard focus, screen-reader announcements, reduced motion, and forced colors. These shortcuts work when focus is outside a control.

| Key | Action |
| --- | --- |
| Space | Play or pause |
| Left / Right Arrow | Seek backward or forward five seconds |
| Up / Down Arrow | Skip forward or backward by the configured interval |

Press Escape to close an open panel or dialog.

## Browser behavior and limitations

- On iPhone and iPad, adjust volume with the device controls.
- The browser and operating system control lock-screen actions and background playback.
- Cross-origin media and metadata need suitable CORS headers.

## Tests

Run the dependency-free Node suite.

```sh
node --test tests/*.test.mjs
```

Run `python3 tests/test_make_chapters.py` for the chapter generator. It needs `ffmpeg` and `ffprobe`. See [the verification checklist](AGENTS.md#verification-checklist) for checks related to specific changes.

Before release, check playback, seeking, and offline reload with real audio on desktop browsers, iPhone and iPad Safari, and Android. Check the controls with a keyboard and on a narrow screen.
