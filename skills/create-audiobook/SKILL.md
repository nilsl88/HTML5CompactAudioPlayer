---
name: create-audiobook
description: Create a new static-site audiobook entry from one or more audio files, including Opus, AAC/M4A, MP3 bitrate variants and a compatible episode.json.
---

# Create an audiobook

Use this skill when the user provides an audiobook file (or a set of language files) and asks to add it to this player. The result is a self-contained `media/<episode-id>/` directory and a minimal entry in `media/library.json`.

## Before encoding

Read the project `AGENTS.md`, then inspect the available tools:

```bash
ffmpeg -version
ffprobe -version
```

Confirm or infer these values from the user’s prompt and file metadata:

- a safe episode ID (lowercase letters, numbers, and hyphens)
- display title and audio language code/label
- each input file when more than one language is supplied
- output directory (normally `media/<episode-id>/<language>/`)
- whether chapters should use embedded metadata, a supplied WebVTT file, or none
- whether the cover should use embedded artwork, an external image, or none

Ask only for values that cannot be safely inferred. Never overwrite an existing episode directory or source file without explicit confirmation.

Use `ffprobe` before encoding to check the audio stream, duration, chapters, attached artwork, and language tags. Treat metadata and titles as untrusted display text.

## Generate the variants

Keep the input untouched. For every language input, create these four bitrates unless the user explicitly requests a smaller set:

- Opus WebM: `audio-64k.webm`, `audio-96k.webm`, `audio-128k.webm`, `audio-256k.webm`
- AAC in M4A: `audio-64k.m4a`, `audio-96k.m4a`, `audio-128k.m4a`, `audio-256k.m4a`
- MP3: `audio-64k.mp3`, `audio-96k.mp3`, `audio-128k.mp3`, `audio-256k.mp3`

Use explicit stream mapping and preserve metadata/chapters. Example commands (replace paths and bitrate in a loop):

```bash
ffmpeg -i "$INPUT" -map 0:a:0 -map_metadata 0 -map_chapters 0 \
  -c:a libopus -b:a "${BITRATE}k" -vbr on -application audio \
  "${OUT}/audio-${BITRATE}k.webm"

ffmpeg -i "$INPUT" -map 0:a:0 -map 0:v? -map_metadata 0 -map_chapters 0 \
  -c:a aac -b:a "${BITRATE}k" -c:v copy -disposition:v attached_pic \
  -movflags +faststart "${OUT}/audio-${BITRATE}k.m4a"

ffmpeg -i "$INPUT" -map 0:a:0 -map_metadata 0 -map_chapters 0 \
  -c:a libmp3lame -b:a "${BITRATE}k" \
  "${OUT}/audio-${BITRATE}k.mp3"
```

If the input has no attached picture, omit `-map 0:v?`, `-c:v`, and `-disposition:v`. Do not invent chapter text. If the source has chapters but the target browser needs a WebVTT fallback, export or use the user-supplied `.vtt` and set `chapterSource` to `vtt`.

## Write episode.json

Create `media/<episode-id>/episode.json` using the existing schema. Keep source paths relative to the language directory:

```json
{
  "id": "episode-id",
  "defaultLanguage": "en",
  "title": { "en": "Book title" },
  "coverSource": "embedded",
  "languages": {
    "en": {
      "label": "English",
      "basePath": "media/episode-id/en/",
      "chapterSource": "embedded",
      "sources": {
        "opus": { "64": "audio-64k.webm", "96": "audio-96k.webm", "128": "audio-128k.webm", "256": "audio-256k.webm" },
        "aac": { "64": "audio-64k.m4a", "96": "audio-96k.m4a", "128": "audio-128k.m4a", "256": "audio-256k.m4a" },
        "mp3": { "64": "audio-64k.mp3", "96": "audio-96k.mp3", "128": "audio-128k.mp3", "256": "audio-256k.mp3" }
      }
    }
  },
  "cacheVersion": 1
}
```

Use `chapterSource: "vtt"` with a `chapters` filename when WebVTT is selected. Use `chapterSource: "none"` when no chapters exist. Use `coverSource: "file"` plus a safe relative `cover` path for an external image; use `"embedded"` only when artwork is present in the MP4/M4A/M4B source. `auto` is acceptable when both paths should be tried.

For multiple languages, add one language object per input and keep the same episode ID. Do not duplicate title data in `library.json`; add only this entry if it is not already present:

```json
{ "id": "episode-id" }
```

## Validate the result

Check every generated file and configuration before reporting success:

```bash
ffprobe -v error -show_streams -show_chapters "media/<episode-id>/<language>/audio-128k.m4a"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log("valid JSON")' media/<episode-id>/episode.json
```

Verify that each configured URL exists, AAC outputs are served as `audio/mp4`, and the episode remains compatible with the player’s embedded chapter/cover parser. Run the project test commands from `AGENTS.md` when code or shared configuration changes. Do not commit or push unless the user explicitly asks.
