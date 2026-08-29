# AGENTS.md

## Project

Compact Audio Player is a dependency-free audiobook and podcast player for static websites. Production is plain HTML, CSS, and browser JavaScript. There is no build step and no runtime package dependency.

Keep the existing configuration schema and static deployment model compatible. Prefer small, explicit changes over broad rewrites.

## Source layout

- `index.html`: semantic markup, controls, dialogs, and the `<audio>` element.
- `player.css`: design tokens, responsive layout, control states, tooltips, and reduced-motion rules.
- `player.js`: application coordinator, DOM rendering, event wiring, localization, and feature orchestration.
- `i18n.js`: interface strings for English, Danish, Norwegian Bokmål, and Swedish.
- `js/config.js`: configuration parsing, validation, URL resolution, and localization helpers.
- `js/media-controller.js`: the only owner of audio source changes, loading, seeking, play/pause state, and fallback transitions.
- `js/source-selection.js`: codec evidence, quality ordering, and deterministic fallback queues.
- `js/availability.js`: abortable HTTP HEAD and Range availability probes.
- `js/storage.js`: guarded localStorage access, migrations, progress, preferences, and availability cache.
- `js/vtt.js`: safe WebVTT chapter parsing.
- `js/dialogs.js`: panel and dialog focus behavior, Escape handling, and focus restoration.
- `js/utils.js`: shared formatting, URL checks, abort errors, and fetch retries.
- `media/`: example library, episode JSON, cover image, and chapter files.
- `tests/`: dependency-free Node test files.

## Development commands

Run the player through HTTP because ES modules and runtime `fetch()` are not reliable from `file://`:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080/`. Example audio binaries are not committed; add the files named by the episode configuration under the matching `media/` directories.

Run checks before handing off a change:

```bash
node --check player.js
for file in i18n.js js/*.js tests/*.mjs; do node --check "$file"; done
node --test tests/*.test.mjs
git diff --check
```

Do not claim physical iPhone, iPad, or Android testing unless it was actually performed.

## Audio architecture

All media operations must go through `MediaController`.

- Do not assign `audio.src`, call `audio.load()`, call `audio.play()`, call `audio.pause()`, or set `audio.currentTime` from unrelated coordinator code.
- Treat `play()` as asynchronous and handle its Promise. `NotAllowedError` means the user must press Play again; it must not start another fallback attempt.
- Use generation checks and abort controllers so old episode, language, quality, chapter, probe, and play operations cannot update newer state.
- Base codec choice on `canPlayType()` evidence and runtime results. The preference order is Opus, AAC/M4A, then MP3. Do not add browser-version or user-agent rules without a documented, verified reason.
- Keep fallback queues finite and deterministic. Preserve playback position, playback rate, selected language, and playback intent where appropriate.
- Initial buffering before the first `playing` event is `loading`. A network warning is reserved for a sustained stall after playback has started.
- Lazy loading is required: the page starts with `preload="none"` and no audio source.

## Configuration compatibility

Episode files live at `media/<folder>/episode.json`. Preserve these fields and aliases:

- `id`, `defaultLanguage`, `title`, `cover`, `duration`, `cacheVersion`, `debug.showAllQualities`, and `ui.onboardingEnabled`.
- `languages.<code>.label`, `basePath`, `chapters`, and `sources`.
- Library collections named `audiofiles`, `episodes`, or `items`, plus existing `default`, `defaultId`, `folder`, `path`, and `label` aliases.

Supported codec keys are `opus`, `aac`, and `mp3`. Keep the existing MIME mappings and relative URL behavior. Reject unsafe schemes and traversal without changing valid relative media paths.

## UI and accessibility

- Use native buttons, labels, fieldsets, outputs, sections, dialogs, and tracks. Do not use clickable `div`s or ARIA menu roles for ordinary panels.
- Keep visible text and accessible names aligned. Use `textContent`, `createElement`, and safe attribute assignment for configuration-derived text.
- Decorative SVG icons must have `aria-hidden="true"` and `focusable="false"`. Keep the button's accessible name on the button.
- Control tooltips use the localized `data-tooltip` attribute through `setTooltip()`. Tooltips must appear on mouse hover and keyboard focus without replacing the accessible name.
- Preserve visible `:focus-visible` styles, Escape behavior, focus restoration, and modal focus containment.
- Primary controls should remain comfortable touch targets. At phone widths up to 430px, the transport controls use one seven-column row so Options stays beside the other controls.
- Keep reduced-motion and forced-colors support. Test long translated labels and at least 320px-wide layouts.

## Storage and network

All storage access goes through `PlayerStorage`. Corrupt JSON, unavailable storage, quota errors, obsolete values, and private-browsing restrictions must degrade safely. Migrate old keys instead of discarding valid preferences.

Availability probes are advisory. They must be abortable, must not download full media, and must never override a source that the media pipeline successfully plays. Do not probe every language or quality unnecessarily.

Chapter loading must never block basic playback. Parse VTT defensively, discard malformed cues, and render chapter titles as text rather than HTML.

## Error handling

Do not use empty broad catches. Catch browser API failures where needed, log core failures with context, and show a localized message only when the user can act on it. Optional Media Session failures must never break playback.

Avoid repeated toasts and screen-reader announcements. Network feedback should distinguish offline state, initial loading, temporary buffering, source fallback, and exhausted sources.

## CSS and visual consistency

Use the existing custom properties for spacing, sizing, color, borders, radius, focus, and shadows. Keep state selectors explicit and avoid `!important` unless the reason is documented.

Use inline SVG or CSS for platform-independent icons. Avoid Unicode symbols for important controls because iOS and desktop fonts can render them differently.

## Verification checklist

For media changes, check first Play, Pause, resume, seek before metadata, quality/language/episode switching while paused and playing, codec fallback, rejected `play()`, offline recovery, and stale async results.

For UI changes, check keyboard focus, Escape and focus restoration, hover and focus tooltips, light/dark themes, reduced motion, forced colors, 200% zoom, and 320/360/390/430px widths. Use real Safari on iPhone/iPad and Android browsers for final media verification.

Update `README.md` when a change affects configuration, browser limitations, testing, storage, codec selection, or deployment instructions.
