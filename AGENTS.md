# AGENTS.md

## Project

Compact Audio Player is a dependency-free audiobook and podcast player for static websites. Production is plain HTML, CSS, and browser JavaScript. There is no build step and no runtime package dependency.

Keep the existing configuration schema and static deployment model compatible. Prefer small, explicit changes over broad rewrites.

## Source layout

- `index.html`: semantic markup, controls, dialogs, and the `<audio>` element.
- `player.css`: design tokens, responsive layout, control states, tooltips, and reduced-motion rules.
- `player.js`: application coordinator, DOM rendering, event wiring, localization, and feature orchestration.
- `sw.js`: network-first application shell and byte-range responses from downloaded audio chunks.
- `i18n.js`: interface strings for English, Danish, Norwegian Bokmål, and Swedish.
- `js/config.js`: configuration parsing, validation, URL resolution, and localization helpers.
- `js/book-config.js`: cached book configuration loading, legacy filename fallback, query selection, and bounded title lookups.
- `js/media-controller.js`: the only owner of audio source changes, loading, seeking, play/pause state, and fallback transitions.
- `js/offline.js`: service-worker registration, storage preflight, chunk downloads, resume state, and offline manifests.
- `js/source-selection.js`: codec evidence, quality ordering, and deterministic fallback queues.
- `js/availability.js`: abortable HTTP HEAD and Range availability probes.
- `js/chapters.js`: cached chapter requests and WebVTT loading.
- `js/mp4-chapters.js`: bounded Range-based MP4 chapter and cover-art parsing.
- `js/storage.js`: guarded localStorage access, migrations, progress, preferences, chapter text, and availability cache.
- `js/vtt.js`: safe WebVTT chapter parsing.
- `js/dialogs.js`: panel and dialog focus behavior, Escape handling, and focus restoration.
- `js/utils.js`: shared formatting, URL checks, abort errors, and fetch retries.
- `media/`: example library, book JSON, cover image, and chapter files.
- `skills/create-audiobook/SKILL.md`: workflow for encoding new books and generating compatible configuration.
- `tests/`: dependency-free Node test files.

## Development commands

Run the player through HTTP because ES modules and runtime `fetch()` are not reliable from `file://`:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080/`. Example audio binaries are not committed; add the files named by the book configuration under the matching `media/` directories.

Run checks before handing off a change:

```bash
node --check player.js
node --check sw.js
for file in i18n.js js/*.js tests/*.mjs; do node --check "$file"; done
node --test tests/*.test.mjs
git diff --check
```

Do not claim physical iPhone, iPad, or Android testing unless it was actually performed.

## Creating new audiobooks

Use `skills/create-audiobook/SKILL.md` when a user asks to add a book from source audio. It normally creates 64, 96, 128, and 256 kbps Opus WebM, AAC/M4A, and MP3 variants, then writes a compatible `book.json` and minimal `books` entry in `library.json`. Configuration-only or original-audio requests must not trigger encoding or extra media files. It supports embedded or WebVTT chapters and embedded or external cover art. Require `ffmpeg` and `ffprobe`, keep source files unchanged, validate every output, and never overwrite an existing book directory without confirmation. Do not commit or push unless the user explicitly asks.

## Audio architecture

All media operations must go through `MediaController`.

- Do not assign `audio.src`, call `audio.load()`, call `audio.play()`, call `audio.pause()`, or set `audio.currentTime` from unrelated coordinator code.
- Treat `play()` as asynchronous and handle its Promise. `NotAllowedError` means the user must press Play again; it must not start another fallback attempt.
- Use generation checks and abort controllers so old book, language, quality, chapter, probe, and play operations cannot update newer state.
- Base codec choice on `canPlayType()` evidence and runtime results. The preference order is Opus, AAC/M4A, then MP3. Do not add browser-version or user-agent rules without a documented, verified reason.
- Keep fallback queues finite and deterministic. Preserve playback position, playback rate, selected language, and playback intent where appropriate.
- Initial buffering before the first `playing` event is `loading`. A network warning is reserved for a sustained stall after playback has started.
- Lazy loading is required: the page starts with `preload="none"` and no audio source.

## Configuration compatibility

Each book has one configuration at `media/<folder>/book.json`; `media/library.json` is the catalog. Use `book`, `normalizeBook`, and `library.books` in application code. Preserve these fields and aliases:

- `id`, `defaultLanguage`, `title`, `cover`, `coverSource`, `duration`, `cacheVersion`, and `debug.showAllQualities`.
- `languages.<code>.label`, `basePath`, `chapterSource`, `chapters`, and `sources`.
- The preferred library collection is `books`. When absent, accept `audiofiles`, `episodes`, and `items` in that order. A present empty or invalid `books` collection must not reveal a legacy collection.
- Preserve library entry aliases `episode`, `key`, `folder`, `path`, and `label`, plus `default` and `defaultId`.

Keep new `library.json` entries minimal: `id` is required and `folder` is needed only when it differs from the ID. Book titles belong in `book.json`. The player may still read legacy library titles as fallback labels.

`library.ui.onboardingEnabled` controls the first-visit help dialog for the whole player and defaults to `true`. Do not read onboarding policy from individual books; the saved onboarding state is library-wide.

Prefer `book.json`; try `episode.json` only after HTTP 404/410 or a network failure, including a timeout or interrupted response body. Do not fall back after invalid JSON, invalid configuration, or other HTTP errors. Cache the normalized configuration and the URL actually loaded. Share in-flight selection/title work, keep consumer cancellation independent, and prevent stale selections from restoring an older book.

Prefer `?book=<id>` while accepting `?episode=<id>`. A non-empty `book` parameter takes precedence, even when invalid; keep safe-ID validation. Preserve startup priority: downloaded book while offline, valid query, saved library selection, library default, then `episode-001`.

Load the active book configuration at startup. Load remaining library titles only after Options opens, limit title lookups to two concurrent requests, and reuse the normalized configurations from the in-memory cache. A failed background lookup must leave the ID fallback visible and must not affect playback.

Supported codec keys are `opus`, `aac`, and `mp3`. AAC sources support AAC-LC (`mp4a.40.2`), HE-AAC v1 (`mp4a.40.5`), and HE-AAC v2 (`mp4a.40.29`) MIME evidence, followed by generic `audio/mp4`; runtime decoding remains authoritative. Keep relative URL behavior and reject unsafe schemes and traversal without changing valid relative media paths.

`chapterSource` is `vtt`, `embedded`, `auto`, or `none`. A legacy language with a non-empty `chapters` value and no mode normalizes to `vtt`. Embedded mode reads the active AAC/M4A/M4B source; auto mode tries WebVTT first and then embedded metadata.

`coverSource` is `file`, `embedded`, `auto`, or `none`. A legacy book with a non-empty `cover` value and no mode normalizes to `file`. Auto mode tries the configured cover before inspecting MP4 metadata. Embedded cover loading must remain asynchronous, abortable, limited to JPEG/PNG metadata no larger than 10 MB, and independent of audio-element loading. Revoke replaced Blob URLs.

Chapter and cover parsing for the same MP4 source must share an in-flight `moov` request. Keep consumer cancellation independent, abort the network request when every consumer leaves, and retain successful metadata only briefly so large buffers do not accumulate across book changes.

## UI and accessibility

- Use native buttons, labels, fieldsets, outputs, sections, dialogs, and tracks. Do not use clickable `div`s or ARIA menu roles for ordinary panels.
- Keep visible text and accessible names aligned. Use `textContent`, `createElement`, and safe attribute assignment for configuration-derived text.
- Decorative SVG icons must have `aria-hidden="true"` and `focusable="false"`. Keep the button's accessible name on the button.
- Control tooltips use the localized `data-tooltip` attribute through `setTooltip()`. Tooltips must appear on mouse hover and keyboard focus without replacing the accessible name.
- Preserve visible `:focus-visible` styles, Escape behavior, focus restoration, and modal focus containment.
- Primary controls should remain comfortable touch targets. At phone widths up to 430px, the transport controls use one seven-column row so Options stays beside the other controls.
- Keep reduced-motion and forced-colors support. Test long translated labels and at least 320px-wide layouts.
- The player summary is language, quality, then active chapter title. Omit the chapter field when there is no parsed active cue.
- Global shortcuts apply only outside interactive controls: Space toggles playback, Left/Right Arrow seeks five seconds, Up/Down Arrow uses the configured forward/back skip interval, and Escape closes overlays.
- Keep visual notifications centered as a non-interactive overlay inside `player-card`. The toast host stays `aria-hidden` because the separate polite live region owns screen-reader announcements.
- Keep the first-visit onboarding dialog current when user-facing features change. Its translated list must cover playback, chapters, keyboard shortcuts, Options, sleep timer, persistence, chapter caching, and offline downloads. Build its content with safe DOM APIs and keep the language selectors functional.

## Storage and network

Keep stable book IDs and media paths when renaming configuration files. Preserve serialized storage keys, including `compactPlayer:lastEpisode`, and offline manifest fields such as `episodeId` and `episodeTitle`. These legacy names are intentional compatibility boundaries, not terminology to replace.

All `localStorage` access goes through `PlayerStorage`. `OfflineManager` owns Cache Storage media and manifests. Corrupt JSON, unavailable storage, quota errors, obsolete values, and private-browsing restrictions must degrade safely. Migrate old keys instead of discarding valid preferences.

Reset must block progress writes before clearing storage. Cancel pending progress timers and stop media before deleting saved state so `pagehide`, visibility, or pause events cannot recreate progress during reload.

Cached chapter text is keyed by book, audio language, chapter URL, and `cacheVersion`. Each entry is limited to 512 KB. A new version replaces the obsolete entry for the same book and language. Reset must remove chapter entries. Render parsed titles as text and document that chapter changes require a `cacheVersion` update.

Embedded chapter cues use the same cache namespace with the active source URL included in the key. Validate cue timestamps and titles before using cached data. Embedded metadata parsing must use bounded Range requests, support QuickTime chapter tracks and Nero `chpl`, and never block audio playback. Traverse top-level atom headers and skip `mdat` by its declared size; a tail buffer can begin inside media data and must not be parsed as an atom boundary.

Availability probes are advisory. They must be abortable, must not download full media, and must never override a source that the media pipeline successfully plays. Do not probe every language or quality unnecessarily.

Chapter loading must never block basic playback or assign an audio source. Start the selected language's VTT request after book configuration and ahead of cover and availability probes. Reuse one in-flight request, use the persistent cache before the network, allow normal HTTP caching, and keep the request timeout at 20 seconds unless evidence supports another value.

Availability scans wait until chapter loading completes and the browser is idle. Opening Options may request a scan sooner, but it must still wait for an active chapter request. A chapter failure must remain retryable from the panel and after the browser reports that connectivity has returned.

Offline download is optional and must not change online playback behavior.

- Keep online requests network-first. A completed download is a fallback, not a saved offline-mode preference.
- Download only the selected book, audio language, and source. Keep one completed audiobook and one resumable staging download.
- Require same-origin audio with a valid total size and HTTP byte-range support. Do not accept a full `200` response for a requested chunk.
- Store media as sequential 8 MiB Cache Storage chunks. Only a `ready` manifest may serve audio.
- Serve correct `200`, `206`, `416`, `Content-Length`, and `Content-Range` responses without assembling the full audiobook in memory.
- Keep the actual loaded configuration URL (`book.json` or `episode.json`) in the offline cache. Existing legacy-only downloads must still reload offline. Cover, chapter, and library files are optional supporting assets.
- Check estimated quota, handle `QuotaExceededError`, request persistence where available, and explain that browser storage can still be evicted.
- Let interrupted transfers resume, but explicit cancellation and Reset Player must remove partial chunks.
- Increment the service-worker shell version when its cached file list or versioned entry points change.
- Offline service workers require HTTPS or localhost and never support `file://`.

## Error handling

Do not use empty broad catches. Catch browser API failures where needed, log core failures with context, and show a localized message only when the user can act on it. Optional Media Session failures must never break playback.

Avoid repeated toasts and screen-reader announcements. Network feedback should distinguish offline state, initial loading, temporary buffering, source fallback, and exhausted sources.

## CSS and visual consistency

Use the existing custom properties for spacing, sizing, color, borders, radius, focus, and shadows. Keep state selectors explicit and avoid `!important` unless the reason is documented.

Use inline SVG or CSS for platform-independent icons. Avoid Unicode symbols for important controls because iOS and desktop fonts can render them differently.

## Verification checklist

For configuration changes, check new-only, legacy-only, and mixed libraries; filename and collection precedence; missing and invalid files; network failure; cancellation; request reuse; two-worker title loading; old query links; unchanged progress; and legacy offline reloads.

For media changes, check first Play, Pause, resume, seek before metadata, quality/language/book switching while paused and playing, codec fallback, rejected `play()`, offline recovery, and stale async results.

For chapter changes, check cache miss, cache hit, corrupt storage, URL and `cacheVersion` invalidation, Retry, online recovery, stale language/book requests, current-title updates, and the no-chapter case.

For embedded chapters, check QuickTime and Nero metadata, a `moov` atom after a large `mdat`, unsupported ranges, malformed atoms, declared title lengths with trailing format data, UTF-8/UTF-16 titles, quality/source fallback changes, and playback continuing while parsing fails.

For embedded covers, check JPEG and PNG metadata, missing or malformed `covr` atoms, external-file fallback, stale book and language work, Blob URL cleanup, unsupported ranges, offline downloaded M4A/M4B files, shared `moov` requests with independent cancellation, and playback continuing while parsing fails.

For offline changes, check unsupported browsers, invalid range servers, insufficient quota, complete download, cancellation, interrupted resume, offline reload, seeking near both ends, online reconnect, source replacement, cache-version mismatch, eviction, and reset cleanup.

For UI changes, check keyboard focus, Escape and focus restoration, Space and all four Arrow shortcuts, hover and focus tooltips, light/dark themes, reduced motion, forced colors, 200% zoom, and 320/360/390/430px widths. Use real Safari on iPhone/iPad and Android browsers for final media verification.

Update `README.md` when a change affects configuration, browser limitations, testing, storage, codec selection, or deployment instructions.
