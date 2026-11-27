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

Add `media/library.json` to show an audiobook selector when more than one valid entry exists:

```json
{
  "default": "episode-001",
  "ui": {
    "onboardingEnabled": true
  },
  "books": [
    { "id": "episode-001" },
    { "id": "episode-002" }
  ]
}
```

Each entry needs only a stable `id`. Its folder defaults to that ID; add `folder` only when the directory name differs. Titles belong in each book's `book.json` and are the source for both the player heading and library selector.

`ui.onboardingEnabled` is a library-wide setting. It defaults to `true`; set it to `false` when the first-visit help dialog should never open automatically. Book-level onboarding settings are no longer used because the browser stores onboarding state once for the whole player.

The selected book configuration loads during startup. Other titles load when Options is first opened, with at most two small configuration requests running at once. The player keeps up to 24 full configurations in memory, including the selected book. It keeps resolved catalog titles for the page session. Options lists the catalog IDs as soon as the catalog arrives, even while the startup book is loading or retrying. You can select another book immediately. Each title replaces its ID when its lookup finishes. A failed optional title request does not prevent the current book from playing.

If the service worker supplies a downloaded configuration, the player checks the server again when the connection returns or when you select that book online. A failed check leaves the downloaded configuration available. A valid update changes the title in Options. Playback continues with the current configuration until the next Play from pause while online. The player then uses the new configuration and keeps the position and quality choice for the selected language when they are still available.

Library-level `title` and `label` values remain accepted for backward compatibility and as initial fallback labels. Legacy `audiofiles`, `episodes`, and `items` collections are accepted in that order when `books` is absent. If `books` is present, it takes precedence, even when empty; an invalid non-array `books` value produces an empty catalog rather than revealing a legacy list. Existing `defaultId`, `path`, `episode`, `key`, and `label` aliases remain supported.

Use `?book=<id>` to select a book. Old `?episode=<id>` links still work. A non-empty `book` parameter wins when both are supplied; an invalid value does not fall back to `episode`. Query values not present in the library are restricted to safe single-folder identifiers. After a successful selection, the player updates the URL to `?book=<id>`.

Startup still prefers a downloaded book while offline, then a valid query, a saved library selection, the library default, and finally the legacy `episode-001` ID.

## Updating the player shell

For a public deployment, prepare the static files from a single checkout:

```sh
node tools/prepare-release.mjs /tmp/compact-player-release
```

Use an empty output directory. Copy the generated `releases/` tree into the installation without replacing previous release directories. Then upload `release-<id>.html` and `sw-<id>.js`, followed by `sw.js` and finally `index.html`. Leave `media/` and site configuration in place. Keep earlier release paths available so open tabs can still load their own files. The generated worker checks the decoded byte count and SHA-256 digest of each shell asset before caching it. It stops reading a response as soon as it exceeds the manifest's size and marks the cache ready after the last asset is stored. An interrupted installation cannot replace the last complete release in the cache. If the current release has lost a cached file while offline, the homepage can open the most recent verified release whose files are still present. The deployed files run on a static server without Node.js.

The generated page includes an import map with the SHA-256 digest of every JavaScript module. Browsers with [import map integrity support](https://html.spec.whatwg.org/multipage/webappapis.html#resolve-a-module-integrity-metadata) check the actual module responses on first load, before a service worker is present. If a module fails to load, **Reload page** retries the same URL and keeps the selected book in the link. Older browsers still use the version-specific paths and the worker's installation checks. If the site sets a Content Security Policy, allow the inline import map with its own hash or nonce so the browser can use this check.

A cache can delay delivery of the unversioned homepage or worker. If the old worker still serves its cached homepage during the first upgrade, open the new `release-<id>.html` in the same installation to start the upgrade. Existing books, preferences, and downloads use the same installation URL and storage. The source checkout can still run directly over HTTP for development. Its unpackaged shell uses the `?v=` values checked by the static tests.

The loader tries `episode.json` only after `book.json` returns HTTP 404/410 or a network failure, including a timeout or interrupted response body. If the worker supplies a downloaded `book.json` after one of those failures, the loader can still use a valid server `episode.json`. It keeps the downloaded configuration if that lookup fails. Invalid primary configurations and other HTTP errors are reported directly when there is no saved copy. The timeout covers both headers and body for book configurations, the library, WebVTT files, and MP4 metadata ranges. Failed loads remain retryable. Concurrent selection and title requests share one load. The player cancels the fetch when its last reader leaves, and a canceled selection cannot update a newer one.

Each `book.json` or `episode.json` can contain up to 1 MiB of decoded UTF-8 bytes. The player stops reading larger responses, including cached configurations.

The library catalog can contain up to 2 MiB of decoded UTF-8 bytes. The same limit applies when saving the catalog for offline use. The player skips offline copies of optional covers and chapter files that exceed 16 MiB.

Existing preferences and progress are read from the original storage keys until the installation saves its own values or is reset. Offline manifests retain their existing fields, including `episodeId` and `episodeTitle`. On offline startup the player uses the configuration URL recorded with the download. This also works for a custom book folder or a legacy `episode.json` when the catalog is unavailable. Startup gives the published download up to three seconds to become available and resumes immediately if the connection returns. Cache inventory and repair run in the background.

If the catalog server is unavailable, the player can use the catalog from a downloaded book immediately. After a failed request or a response from that download, it checks the catalog again when connectivity returns or Options opens online. If startup also failed to open a book, the player opens the selection from the recovered catalog. A book already open keeps playing. If a lookup is still pending when the catalog supplies a different folder, the player requests the configuration from that folder. Title lookups and playback share the new request. Updating the service-worker shell preserves downloaded media. If registration fails while this installation's worker still controls the page, the player can read its published download. After a setup timeout, the download controls return when this installation's worker takes control.

## WebVTT chapters

The selected language's chapters start loading after the book configuration. This request is independent of audio loading and never blocks playback. Opening the chapter panel, using chapter navigation, or selecting sleep at chapter end reuses the loaded data or the same in-flight request.

```vtt
WEBVTT

00:00:00.000 --> 00:05:12.000
Introduction

00:05:12.000 --> 00:18:30.000
Chapter 1
```

Use `mm:ss.mmm` or `hh:mm:ss.mmm` for both timestamps. Hours can exceed 99. The parser accepts a comma or period before the three millisecond digits. It skips a cue if either timestamp is malformed or the end is at or before the start.

WebVTT files can use LF, CRLF or CR line endings. The parser accepts cue identifiers, cue settings, multiline titles, and NOTE, STYLE, and REGION blocks. The player displays each title as plain text. The active chapter title appears after language and quality in the player summary. It is omitted before the first cue, in gaps between cues, and after the last explicit end time. When cues overlap, Previous chapter uses the chapter shown in the summary. In a gap, it returns to the preceding cue and the chapter sleep timer is unavailable. When a quality change or automatic fallback supplies different chapters, the timer follows the current chapter in the new source. It turns off if that chapter has no usable end time. Minute timers keep their original deadline.

## Source selection and fallback

The language selector lists languages with at least one usable audio URL. When a preferred language has no usable source, the player can open the book in its default language.

`canPlayType()` provides initial evidence, not a guarantee. AAC sources are tested against AAC-LC, HE-AAC v1, HE-AAC v2, and generic MP4 audio MIME hints. Runtime decoding remains the final authority, and there are no iOS-version codec rules.

The initial codec preference is:

1. Opus
2. AAC
3. MP3

The normal quality selector shows the selected codec family. After a fallback to another codec, it shows the available qualities for that codec. Set `debug.showAllQualities` to `true` to include other codec families.

For each source transition, the player creates a finite queue:

1. The selected source
2. Other bitrates from that codec, ordered by distance from the selected bitrate
3. Remaining codec families in preference order

A confirmed decode or unsupported-source failure skips the rest of that codec family. A network/source failure may try another bitrate before moving to the next codec. The fallback queue tries each URL once. A book opened offline keeps its other configured sources available for fallback when the connection returns.

Choosing a quality in Options saves it immediately. An automatic fallback becomes the saved quality once the browser starts playing it. If a new book fails to open, the current book keeps its playback position and sleep timer.

`NotAllowedError` stops automatic attempts and asks the user to press Play again. Old Promise rejections, media events, probes, chapter loads, and book responses are ignored after a newer generation takes ownership.

## Lazy loading

The audio element starts with `preload="none"` and no `src`. Pressing Pause or Space during the first load cancels the pending start, including a retry when the connection returns.

- Page load does not assign an audio source.
- Language or quality changes before playback only update the pending selection.
- Seeking or choosing a chapter before metadata updates the pending start time.
- The first Play action assigns the source and calls `play()` within the same user gesture.
- Source changes while playing preserve position, playback rate, and playback intent.

The pending position survives zero-time events during source reloads. A chapter seek made before metadata arrives, or followed by a source fallback, is applied when the new source is ready.

Browsers control actual buffering and may treat `preload` as a hint after a source is assigned.

After a pause, pressing Play starts a new timeout. If the source neither emits `playing` nor advances the position, the player tries the next source. If a connection loss interrupts playback, the player resumes when the connection returns. If the browser has already rejected the source, the player reloads that URL once and seeks to the saved position. If playback is still stalled after the source timeout, it tries the next source from the saved position. A pause from the audio element also updates the controls. After a pause, the book stays paused through reconnection until you press Play.

## Offline downloads

Options includes **Download for offline use**. It downloads the current audiobook, audio language, and quality using a service worker, Cache Storage, and IndexedDB. Cancel is available from the first size check, which times out after 20 seconds. While a replacement downloads, Cancel retires the partial copy and keeps the saved book. File cleanup runs after the write lock is released. If storage is too full to save the cancellation, the partial copy remains available for Resume or another attempt to cancel. Once the player starts activating the completed replacement, the Cancel button disappears. If space is too low for both books, the player keeps the saved copy. You can free space or use **Remove download** before trying again.

The download also stores the player shell, book configuration, cover, and chapter file needed for an offline reload. Each optional file gets up to three seconds to fetch and save. Audio can still download when an optional file is missing or its write is pending, and Cancel can stop the download during that write. The player uses the network first whenever it is online and keeps the completed copy as a fallback. Returning online does not delete the download.

The player stores audio in 8 MiB chunks. With a strong version validator, the player requests sequential byte ranges using If-Range. Without one, it requests a single range covering the file and splits that response as it arrives. Each response must match the MIME type, total size, and final URL established by the initial probe. A redirect to a different file stops the transfer before the player saves any bytes from that file.

The browser may ask for permission to keep downloads in persistent storage. The download continues while that request is pending. If the browser denies it, the saved book remains usable, but the browser may evict it when storage runs low.

After 20 seconds without response headers or audio bytes, the download pauses and releases the write lock. Time spent waiting for playback or writing a chunk to storage is excluded from the network timeout. If the headers fail range validation, the player reports the error immediately and cancels the body in the background. Responses that arrive after cancellation are discarded before reading any audio. **Resume download** reuses saved chunks when the final URL, size, and audio MIME type match and the server confirms the same file version with a strong ETag or a reliable Last-Modified date. Otherwise, the download starts from the first chunk. Older partial downloads without a final URL restart if they still need more bytes.

Opening the download cache during Start or Resume has a three-second deadline and can be canceled. If the cache times out during Resume, already saved chunks remain available for another attempt. The player prepares the replacement cache and saves its required book configuration and download record before deleting the existing partial download. If there is too little space for this metadata, the existing download stays available for Resume.

Each Cache Storage write of the required book configuration, an audio chunk, or the partial download manifest has its own 20-second deadline. The player tracks resumable progress in IndexedDB. Cancel and Reset can stop a pending download during any of these writes. A configuration write timeout keeps a draft that already contains audio. Each repair writes to a separate cache key, and the download record selects which copy the worker serves at the original URL. A late write can finish without replacing that copy. A timeout while writing a chunk or updating the draft manifest retires the draft. The player can still read older downloads and drafts.

One tab at a time can change an installation’s offline book. Other tabs can open the saved book and show when offline storage is in use. After the write lock is released, those tabs can resume or cancel the draft. A tab can also finish a complete draft offline once its required book configuration is available. Before changing a download, the player gives the initial record check under the write lock up to three seconds. Cancel interrupts that check while starting or resuming a download. A cache scan runs without the write lock and gets up to 20 seconds. When handling a damage report, the player waits up to three seconds for the write lock. After the first timeout it scans again. If the lock is still busy, automatic retries wait progressively longer, up to 30 seconds between attempts. Before applying repairs, the player rechecks the records under the lock and skips the repair if that check takes more than three seconds. The fallback read of the published download also has a three-second deadline. The player uses Web Locks for coordination, with IndexedDB as a fallback. If the browser denies the write lock, the saved book remains available for playback and the player hides the download controls.

If activation fails after the replacement has finished downloading, the previous book stays available. A completed download can usually be activated again with **Resume download** or by reopening the player, even offline. Activation gives each of its two Cache Storage writes up to 20 seconds. Once those writes finish, an IndexedDB transaction selects the active record. The player and its service worker read that record from IndexedDB first. Older records can still use the metadata cache. If a cache write stalls, the player abandons the replacement and releases the lock before cleanup finishes. Before activating a replacement, the player reads each saved audio chunk and checks its actual byte count, including the shorter final chunk. Each cache lookup and read in this check gets up to three seconds. If a read times out, the player keeps the partial download and can retry the check. A missing, truncated, or oversized chunk leaves the previous book available. Resume fetches the missing parts if the server can confirm the same audio version. The required book configuration must also pass validation.

Before downloading audio chunks, the player checks the book ID, cache version, language, quality, and audio URL in the saved configuration. Resume reuses a matching configuration after the audio server confirms the file version. If the configuration is missing or invalid, the player validates the replacement text before writing it to storage. A failed check keeps the previous offline book available. The player also checks the audio MIME type and the completed download manifest. If the server omits the content type or sends a generic binary type, the player uses the configured audio format.

After cancellation, the player closes unread responses from pending download manifest and book configuration lookups.

Startup and Resume both validate a replacement against its recorded configuration URL before activating it. If its local manifest has lost that URL, the player recovers it from the matching download record. The current book remains available while the replacement needs repair. If the configuration is missing or invalid and the audio is intact, **Restore book configuration** in Options checks the saved book's cache and fetches its configuration URL. The cache check has a three-second deadline and can be canceled. The same action can finish an interrupted replacement whose audio is complete. It checks the restored configuration against the saved audio before switching books, including on servers without a version validator. Restoring the current book keeps any separate paused download at its saved position. After a replacement becomes active, old files get up to three seconds of background cleanup without holding the write lock. The next visit can retry any unfinished cleanup.

Opening an unchanged download requires no cache writes. If its local manifest is missing, the player uses the published record to check the configuration and size of each saved audio chunk before rebuilding the manifest. For an interrupted download with a missing local manifest, the player checks the chunks listed in the staging record. When the server confirms the same audio version, Resume checks the saved bytes before estimating how much space is needed. Under the write lock, it checks that those chunks are still in cache before the final space check. It downloads only missing or damaged chunks. Automatic manifest repairs and damage acknowledgments have three seconds to write. A repair applies only to the manifest revision it checked. Rewriting a chunk advances that revision. A quota error during recovery keeps the offline controls available.

If part of the published audiobook is missing, the player verifies the remaining audio chunks and offers **Resume download** in Options. With the same audio version it requests just the missing ranges. If chunks disappear during a download, the player checks available space again and makes one additional pass for the missing ranges when a strong validator identifies the audio version. If another download is already paused, it keeps its place. Finishing that replacement installs the new book. Canceling it makes the damaged book available to resume.

If playback encounters a missing chunk or one with an invalid status, length, or recorded byte range, the service worker reports it in the background. The player checks the affected chunk and offers **Resume download**, including when the book contains only one chunk. A confirmation applies only to the report it checked. An unprocessed report is checked on the next visit. Cache lookups for saved audio get up to 1.5 seconds. A timed-out read can fail playback for that request, while the download remains available for a later attempt.

If Cache Storage reports a read error during startup, the player keeps the saved book and checks it again on the next visit. When the browser blocks access to Cache Storage, the player hides the download controls and can still play online.

Offline download requires:

- HTTPS in production or `http://localhost` during development
- service worker, Cache Storage, and IndexedDB access
- audio hosted on the same origin as the player
- valid HTTP `206 Partial Content` responses with `Content-Range` and a known total size
- enough browser-managed storage for the selected source

If online playback fails because the audio server cannot be reached, the player can retry the currently selected recording from the completed download. The saved book, language, source, and cache version must match the current selection. The player also rejects audio responses redirected to another origin during both the initial check and the download.

The player checks `navigator.storage.estimate()` before confirmation and again under the write lock. Each estimate gets up to 750 ms. When an estimate is available, optional files use only the space left after setting aside the remaining audio and its reserve. If the browser does not supply an estimate, the player continues and handles any quota error when writing. If a changed audio file needs a fresh download, the player checks how much space it can free from the partial copy. It credits only chunks whose stored size matches the manifest. A stalled or invalid chunk cannot contribute to the estimate. The completed book stays in storage until its replacement is ready. The player requests persistent storage where supported. Browsers may evict site data later. Keep the page open while downloading because iOS and other mobile browsers can suspend page work in the background.

Audio requests use the browser's media loader. This avoids a [Firefox service-worker streaming issue](https://bugzilla.mozilla.org/show_bug.cgi?id=1637325) that can interrupt online chapter seeking. At first Play while offline, the player uses a downloaded copy only when its book, language, source, and `cacheVersion` match. If an active source fails or times out, the player tries that matching copy once. During an update, the older worker can still serve existing downloads. The player enables changes to downloads once a worker that supports the IndexedDB records takes control. With an older worker, the player retries a failed saved-audio route check in the background. Other requests, including chapter and cover metadata, remain network-first with version-checked cached fallback.

For navigation to the installation root or `index.html`, the service worker gives the server three seconds before looking for an installed page. If that lookup finds no usable response, the original request can still finish within the 15-second deadline. The deadline covers headers and validation of the body, including for each packaged release file. The ordinary player page can contain up to 256 KiB of decoded HTML. Cache lookups for the shell and ordinary book files get up to 750 ms. For ordinary book files, the worker starts the lookup after three seconds without a network response. The same three-second window covers headers and body for cover responses read by the worker. Covers read into memory by the worker or by the page's fallback are limited to 16 MiB. If a fallback lookup fails or times out, the worker returns the original server response or network error.

When a current release file cannot be read from cache, the worker fetches and verifies it. A verified response can restore a missing file in a cache marked ready. If the current release is missing a file during offline navigation, the worker uses the previous verified release when it is available. If the marker is missing, a verified response from the installed release starts one background rebuild for the cache. The rebuild has a 60-second deadline and records readiness only after all files are verified and stored. A later verified request can retry an incomplete rebuild. Cleanup of earlier caches runs separately from claiming open pages and has its own deadline. The `release-<id>.html` entry also works offline, including links with a book parameter.

When serving downloaded audio, the worker honors `If-Range` for a matching strong ETag or reliable Last-Modified date. If the saved version differs or cannot be verified, it streams the full saved file with status 200. An ordinary range request can still seek within an older download that has no version validator.

The player and service worker use the same rules to validate a completed download. The download record lists the chunks that require a SHA-256 checksum. Playback verifies the checksum before serving the bytes, and recovery verifies it before keeping a suspect chunk. If a required checksum is missing, Resume can fetch that chunk again. Older chunks without checksums still use length and range checks, including when a resumed download contains a mix of old and new chunks. The worker reads one cached chunk at a time, stops reading on an oversized body, and cancels further reads if a seek cancels the request. If a cached copy fails after reconnecting, the player can try the online source again at the current position. Change `cacheVersion` when replacing an audio file. An older completed copy remains usable offline until the user replaces or removes it.

## Availability probing

Availability is advisory. Each source is `available`, `missing`, or `unknown`.

1. The player tries an abortable HEAD request.
2. If HEAD is inconclusive, it sends `Range: bytes=0-0` and cancels the response body after the headers arrive.

HTTP 200/206 and authenticated 401/403 responses remain playable candidates. HTML success pages and responses served from a download leave network availability unknown. HTTP 404/410 from both probe paths marks a source missing. CORS, proxy, timeout, and offline failures stay unknown.

Once a source plays, the player records its URL in the book's versioned availability cache for seven days. A later probe from any tab can report a missing file, but the player still offers the source while its playback record is valid. After the selected source fails, the player checks the latest probe results. It tries available and unchecked files across all codecs before retrying a file marked missing. A decode failure excludes that codec for the rest of the attempt.

Only the active audio language is scanned. Changing language cancels stale probe work and starts a scan for the new selection. Opening Options again retries sources whose earlier probes were inconclusive.

Each probe result expires seven days after that source was checked. Scanning another language or quality in a second tab preserves the first result and its expiry. Change `cacheVersion` or use `?clearAvailCache=1` to discard the current book cache. The old `?resetProbe=1` parameter is accepted as a harmless no-op because session-wide probe disabling no longer exists.

## Chapter loading

When a book opens or the audio language changes, the selected language's WebVTT file starts loading before cover or availability checks, even if the audio is still buffering. It does not assign or preload an audio source. The player checks localStorage for the book, audio language, chapter URL, and `cacheVersion` first. On a miss it asks the server to revalidate the HTTP-cached file, even if the file still has time left in its cache lifetime. Repeat visits to the same edition reuse validated WebVTT files.

The service worker identifies downloaded chapter and MP4 metadata by catalog ID, configuration ID, and `cacheVersion`. Legacy manifests without a configuration ID use the saved catalog ID. The chapter cache is also keyed by catalog ID, so separate catalog entries do not share cached chapters when their configurations have the same ID. Existing entries keyed only by a different configuration ID are not reused for an alias. During a worker upgrade, a cached response from an older worker that supplies only a version is rejected until the new worker takes control.

Audio availability probes wait until chapter loading finishes and the browser is idle. Opening Options starts the scan sooner, but an active chapter request keeps priority. WebVTT requests allow 20 seconds per attempt and accept up to 1 MiB of decoded text. Each MP4 metadata operation allows up to 20 seconds and 128 HTTP requests, including retries and any QuickTime chapter samples. Traversing the metadata is limited to 65,536 boxes. Failed requests and HTML error pages show a Retry action in the chapter panel and are retried when connectivity returns. In WebVTT mode, a valid file with no cues displays an empty chapter list. In auto mode, a valid empty WebVTT file leads to embedded chapters for that edition. If the WebVTT request fails, the player keeps the embedded list available offline and checks WebVTT again on reconnection or the next online visit.

If the chapter server is unavailable, a downloaded WebVTT file can supply chapters for the same book version. With a different version, the chapter panel offers Retry. Cached WebVTT text and embedded cues are each limited to 512 KiB measured as UTF-8. Older cache entries exceeding that limit are loaded again from their source. Change `cacheVersion` whenever a chapter file changes. Reset Player removes the persistent chapter cache. Storage restrictions, corrupt values, or quota errors disable this extra cache without affecting network chapter loading.

## Embedded M4A/M4B chapters

Set a language's `chapterSource` to `embedded` to read QuickTime chapter tracks or Nero `chpl` metadata from the active M4A/M4B source. Use `auto` to try the configured WebVTT file first and fall back to embedded metadata. Embedded metadata is read with bounded HTTP Range requests, so the player does not fetch the complete audiobook just to find chapter markers.

```json
{
  "chapterSource": "embedded",
  "sources": {
    "aac": { "128": "book.m4b" }
  }
}
```

When Opus or MP3 is selected, embedded chapters are unavailable for that source. Selecting an M4A/M4B quality loads its chapters. Use WebVTT for chapters shared across formats.

The first MP4 request reads up to 256 KiB. QuickTime chapter titles inside that range use the bytes already in memory. For titles farther into the file, the player groups nearby samples in reads of up to 256 KiB and skips gaps larger than 4 KiB. A single larger sample keeps its own range.

All MP4 ranges must resolve to the same final URL, including the ranges used for QuickTime chapter titles. If the first response has a strong ETag or a reliable Last-Modified date, later ranges must also carry that validator. The player sends `If-Range` when both the configured URL and its final destination belong to the player's origin. For cross-origin files, it compares the exposed response validators without adding that header. Without a strong validator, an unchanged URL and size cannot confirm that all ranges came from the same edition. Change `cacheVersion` when replacing a file.

Embedded chapters reload when the language, quality, or fallback source changes. The parser follows top-level MP4 atom sizes, skips the media-data atom without downloading it, and reads a `moov` atom located at either end of a large audiobook. MP4 metadata is limited to 16 MB. The reader streams each range and cancels the response as soon as it exceeds the expected length. The player reads up to the first 10,000 samples of a QuickTime chapter track. Incomplete or invalid sample, timing, or chunk tables produce a retryable chapter error rather than saving a partial list. QuickTime titles use the declared text length and honor the UTF-16 byte-order mark. The player reloads cached titles that carry a reversed byte-order mark.

The parser runs independently of playback and requires a server that supports byte ranges and the necessary same-origin or CORS response headers. If loading fails, the Chapters panel offers Retry and the player tries again when the connection returns. This also works for books whose only chapter source is the audio file. Embedded cues are cached per book, language, cache version, and source URL.

## Storage

Playback and seeking update the saved position for each book and audio language. Closing a passive tab preserves the latest position saved by the tab you listened in, including a deliberate seek backward.

If the browser blocks access to `localStorage`, the player opens the book with the default settings. Playback works, but settings and progress cannot be saved for the next visit. Storage reads and writes also handle malformed JSON, obsolete values, and quota errors.

Each installation prefixes new storage keys with `compactPlayer@<encoded-folder>:`. The folder comes from the page's directory, so direct links and query parameters use the same saved position. The keys within each installation are:

- `book:<encoded-book>:<reset-id>:selection` stores the selected language and quality
- `book:<encoded-book>:<reset-id>:progress` is the older combined position record, still used as a fallback
- `book:<encoded-book>:<reset-id>:progress:<encoded-language>:<revision>` stores a listening position and its activity time. Concurrent saves have separate keys. The player resumes from the latest activity and removes older revisions on the next save. It also reads earlier per-language keys without a revision.
- `ui:<field>` stores each interface preference separately, so changing speed in one tab preserves a theme or volume change in another. Older preferences are read from `compactPlayer:ui`.
- `compactPlayer:lastEpisode`: last library selection
- `compactPlayer:chapters:<book>:<language>:<cacheVersion>`: cached WebVTT chapter text
- `compactPlayer:chapters:<book>:<language>:<cacheVersion>:<source>` stores embedded chapters for one audio source
- `compactAudioPlayer.onboardingShown.v1`: onboarding state
- `cap_avail_*`: legacy availability cache

Older `compactPlayer:<book>` records remain readable. Books named `ui` or `lastEpisode` now have separate storage from the global settings. If an older settings key contains recognizable book data, the player copies it before updating that key. The reset ID is empty until the first reset. Each reset changes the ID so queued progress from an older tab cannot restore cleared positions. Older, unprefixed values remain available to other installations.

Availability records use the prefix `availability:<book>:<cacheVersion>:<reset-id>:<clear-id>:`. Each `probe:<language>:<source-id>:<encoded-url>` record timestamps the result for one audio file. Each `played:<url>` record timestamps successful playback. An older probe applies to a file only if its record names the same URL. Older records without a URL leave the file eligible for playback and a fresh check. Clearing the availability cache changes its clear ID so a probe from an older tab cannot restore cleared results.

After a reset, new chapter keys begin with `chapter-reset:<reset-id>:`. An outstanding chapter request in another tab cannot restore cleared entries. Older chapter keys remain readable. Chapter entries record their source URL and timestamp. The player stores one WebVTT text per book, language, and current version. Different audio sources can retain their own embedded chapters in that version. After saving a version, the player removes obsolete entries it found before starting the chapter request. A late response in another tab preserves chapters saved since that request began.

Progress writes are throttled and flushed when the page is hidden or left.

Cache Storage holds one completed audiobook and one interrupted download per player installation. Open tabs update their download status when another tab saves or pauses a draft or replaces or removes the saved book. The worker checks the active download before serving its audio. **Remove download** updates the player and releases the write lock when the removal record is saved. If Cache Storage is full, both **Remove download** and **Reset Player** can save their removal records in IndexedDB alone. If IndexedDB also rejects the record, the saved audio is kept. File cleanup gets up to three seconds. A later cache scan also removes unused metadata left by interrupted activations. Players hosted in different folders on the same origin manage their downloads separately, even when they use the same audio URL. Older downloads still belong to the folder containing their manifest URL. Reset Player clears the current installation's settings and invalidates its downloads and pending download checks before spending up to three seconds removing their files. Any remaining files are eligible for cleanup on a later visit. If another tab is updating downloads, the reset dialog reports the conflict. If either store cannot be cleared, the dialog lists the unfinished part. **Try again** retries only that part. The service-worker app shell remains installed so a later online visit can refresh it.

## Accessibility and keyboard controls

Controls use native buttons, labels, fieldsets, outputs, sections, and dialogs. Chapter and sleep panels use ordinary button semantics instead of ARIA menu behavior.

- `Space`: play or pause when focus is outside a control
- `Arrow Left` / `Arrow Right`: seek five seconds
- `Arrow Up` / `Arrow Down`: skip forward or backward using the configured interval
- `Escape`: close an open panel or dialog
- `Tab` / `Shift+Tab`: normal document and modal focus movement

Panels place focus inside when opened and restore it to their trigger when closed by Escape or a close action. Dialogs use the native modal API with a focus-trap fallback. Status announcements are deduplicated to avoid repeated screen-reader output.

Visual notifications for network state, playback errors, chapter loading, and sleep-timer changes are centered over the player card. They do not move the layout or intercept pointer input. A separate polite live region announces the same message to assistive technology.

The layout supports 320 CSS px viewports, browser zoom, long labels, safe-area insets, reduced motion, and forced-colors mode. Primary controls use 44 CSS pixel targets.

## Browser behavior and limitations

- Playback always requires a user action. The player does not attempt autoplay.
- iOS and iPadOS expose `audio.volume` but do not apply programmatic changes. The volume control is hidden there.
- Media Session is optional. On a book switch, the lock screen shows the new position and duration if known. Otherwise the player clears the old position until the browser reads the new duration. Unsupported actions or metadata failures do not affect normal playback.
- Lock-screen controls, background playback, interruptions, route changes, and app switching remain controlled by the operating system and browser.
- Cross-origin configuration, chapter, image, and audio servers must permit the requests they receive. Authentication and CORS policies vary by deployment.
- Cross-origin audio remains available for normal playback but cannot use the offline-download control.
- Device codec support can differ from `canPlayType()` results. Runtime fallback is the final authority.
- Offline downloads are best-effort browser storage. Clearing website data, private-browsing restrictions, quota pressure, or browser eviction can remove them.
- Downloads stop when the browser suspends or closes the page. Missing chunks require a connection. A fully transferred book can finish activation offline.

## Tests

Run the dependency-free checks with:

```bash
node --check player.js
node --check sw.js
for file in i18n.js js/*.js tests/*.mjs; do node --check "$file"; done
node --test tests/*.test.mjs
git diff --check
```

Run `python3 tests/test_make_chapters.py` to check the chapter generator with short recordings. This test uses `ffmpeg` and `ffprobe`.

The tests cover:

- Book configuration, legacy filename fallback, collection aliases, query precedence, request reuse, cancellation, and lazy title concurrency
- URL and MIME handling
- Storage migration, corruption, chapter caching, reset behavior, and availability cache compatibility
- Offline manifest validation, size preflight, complete download promotion, interruption and resume
- Service-worker open-ended and suffix ranges, streamed `206` bodies, and network-first routing checks
- Cached chapter requests, HTTP failures, and WebVTT parsing
- Embedded QuickTime/Nero chapter parsing, large media-data atoms, title decoding, JPEG/PNG artwork, shared metadata requests, source changes, and chapter cache separation
- Source selection and fallback order
- blocked playback and codec rejection
- stale play Promise rejection after a newer source selection
- seeking before metadata
- duplicate HTML IDs and label associations
- active chapter metadata and configurable Up/Down Arrow shortcuts
- CSS custom-property references
- production dependency and lazy-preload checks

## Manual device matrix

Automated tests do not prove operating-system media behavior. Before a production release, test with real audio files on:

- iPhone Safari: first Play, source changes, offline download, airplane-mode reload and seeking, interrupted-download resume, lock screen, background/foreground, and volume-control visibility
- iPad Safari: the same flows in portrait, landscape, split view, and with a hardware keyboard
- Android Chrome, Firefox, and Samsung Internet: touch ranges, offline reload and seeking, app switching, screen lock, network loss, and Media Session controls
- macOS Safari, Chrome, Firefox, and Edge: keyboard controls, codec fallback, downloaded-copy replacement, storage reload, dialogs, zoom, and offline recovery

Also test 320, 360, 390, and 430 CSS pixel widths, tablet layouts, 200% zoom, long translated titles, reduced motion, and high-contrast/forced-colors modes.
