#!/usr/bin/env python3
"""Create time-based WebVTT chapters for an audiobook that has no chapters.

The audio is split into chapters of equal length, none longer than --max-minutes.
Each boundary is then moved to the longest pause in the narration close to its
even mark, so a chapter does not start in the middle of a sentence.

The whole file is decoded once to find the pauses. That takes about a minute for
a twelve-hour book and avoids imprecise seeking in MP3 files. The audio file is
only read, never changed.

Requires ffmpeg and ffprobe on PATH.

Usage:
  python3 tools/make-chapters.py "media/my-book/My Book.mp3"
  python3 tools/make-chapters.py book.m4b -o media/my-book/en/chapters.vtt --max-minutes 30

Without -o the file is written as chapters.vtt next to the audio file. An existing
file is kept unless --force is given.

Afterwards, in the book's book.json:
  - set the language's "chapterSource" to "vtt" and "chapters" to the file's path,
    relative to the book folder (or to "basePath" when the language has one)
  - raise "cacheVersion" so browsers and offline downloads pick up the chapters

One chapter file serves several encodings of the same recording (Opus, AAC, MP3)
as long as they share one timeline.
"""
import argparse
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile

LEAD_IN = 0.4    # seconds of pause left before speech resumes at a chapter start
PAUSE_SEARCH_SECONDS = 5


def probe_duration(path):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        capture_output=True, text=True,
    )
    try:
        return float(result.stdout.strip())
    except ValueError:
        return None


def find_pauses(path, noise, min_pause, expected):
    """Decode the file once. Return (pauses, decoded_seconds)."""
    command = [
        "ffmpeg", "-hide_banner", "-nostdin", "-nostats", "-i", path, "-vn", "-sn", "-dn",
        "-af", f"silencedetect=noise={noise}:d={min_pause}", "-f", "null", "-", "-progress", "pipe:1",
    ]
    show_progress = sys.stderr.isatty() and expected
    decoded = None
    # The filter log goes to a file: reading only one of two pipes would stall ffmpeg.
    with tempfile.TemporaryFile("w+", encoding="utf-8", errors="replace") as log:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=log, text=True)
        for line in process.stdout:
            match = re.match(r"out_time_us=(\d+)", line)
            if not match:
                continue
            decoded = int(match.group(1)) / 1e6
            if show_progress:
                print(f"\rFinding pauses: {min(100, decoded / expected * 100):3.0f}%", end="", file=sys.stderr)
        process.wait()
        if show_progress:
            print(file=sys.stderr)
        log.seek(0)
        text = log.read()
    if process.returncode != 0:
        sys.exit(f"ffmpeg could not decode the file:\n{text[-800:]}")

    pauses, begin = [], None
    for line in text.replace("\r", "\n").splitlines():
        match = re.search(r"silence_start: (-?[\d.]+)", line)
        if match:
            begin = max(0.0, float(match.group(1)))
            continue
        match = re.search(r"silence_end: (-?[\d.]+)", line)
        if match and begin is not None:
            pauses.append((begin, float(match.group(1))))
            begin = None
    return pauses, decoded


def stamp(seconds):
    ms = int(seconds * 1000)  # floor, so the last cue never passes the end of the audio
    hours, rest = divmod(ms, 3600000)
    minutes, rest = divmod(rest, 60000)
    secs, ms = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}"


def plan_chapters(total, max_len, pauses):
    """Return (starts, notes). Every chapter is at most max_len seconds long."""
    # Spread the chapters evenly so the last one is not a short leftover. Each boundary
    # may move +/- slack from its even mark; two neighbours can therefore drift apart
    # by 2 * slack, and even + 2 * slack <= max_len keeps every chapter within the limit.
    count = max(1, math.ceil(total / max_len))
    if count > 1:
        margin = min(PAUSE_SEARCH_SECONDS, max_len / 4)
        count = math.ceil(total / (max_len - 2 * margin))
    even = total / count
    slack = min(math.floor((max_len - even) / 2), even / 2)

    starts, notes = [0.0], []
    for number in range(2, count + 1):
        mark = (number - 1) * even
        candidates = [(s, e) for s, e in pauses if s >= mark - slack and e <= mark + slack]
        if candidates:
            s, e = max(candidates, key=lambda pause: (round(pause[1] - pause[0], 2), -abs(pause[1] - mark)))
            cut = e - min(LEAD_IN, (e - s) / 2)
            notes.append(f"  {number:3d}  {stamp(cut)}  pause {e - s:.2f}s")
        else:
            cut = mark
            notes.append(f"  {number:3d}  {stamp(cut)}  no pause nearby, cut at the even mark")
        starts.append(cut)
    return starts, notes


def main():
    parser = argparse.ArgumentParser(
        description="Create time-based WebVTT chapters, cut at pauses in the narration.",
        epilog="Then set chapterSource/chapters in book.json and raise cacheVersion.",
    )
    parser.add_argument("audio", help="audio file to read (MP3, M4A, M4B, WebM, ...)")
    parser.add_argument("-o", "--output", help="chapter file to write (default: chapters.vtt next to the audio)")
    parser.add_argument("--max-minutes", type=float, default=20, help="longest allowed chapter (default: 20)")
    parser.add_argument("--title", default="Part {n}", help='chapter title, {n} is the number (default: "Part {n}")')
    parser.add_argument("--noise", default="-35dB", help="level below which audio counts as a pause (default: -35dB)")
    parser.add_argument("--min-pause", type=float, default=0.35, help="shortest pause to consider, in seconds (default: 0.35)")
    parser.add_argument("--force", action="store_true", help="replace an existing chapter file")
    args = parser.parse_args()

    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"{tool} was not found on PATH.")
    if not os.path.isfile(args.audio):
        sys.exit(f"Audio file not found: {args.audio}")
    if not math.isfinite(args.max_minutes) or args.max_minutes <= 0:
        sys.exit("--max-minutes must be a finite number greater than zero.")
    try:
        sample = args.title.format(n=1)
    except (KeyError, IndexError, ValueError):
        sample = ""
    if not sample.strip() or "-->" in sample or "\n" in sample:
        sys.exit('--title must be one non-empty line without "-->"; use {n} for the chapter number.')
    output = args.output or os.path.join(os.path.dirname(os.path.abspath(args.audio)), "chapters.vtt")
    if os.path.exists(output) and not args.force:
        sys.exit(f"{output} already exists. Use --force to replace it.")

    probed = probe_duration(args.audio)
    pauses, decoded = find_pauses(args.audio, args.noise, args.min_pause, probed)
    total = probed
    if decoded and (probed is None or abs(probed - decoded) > 1):
        total = decoded
        if probed is not None:
            print(
                f"Warning: the file header says {stamp(probed)} but the audio decodes to {stamp(decoded)}.\n"
                "The decoded length is used. This usually means a variable-bitrate MP3 without a\n"
                "length header; browsers may then land some seconds away from a chapter start.",
                file=sys.stderr,
            )
    if not total or total <= 0:
        sys.exit("Could not determine the length of the audio.")

    starts, notes = plan_chapters(total, args.max_minutes * 60, pauses)
    lines = ["WEBVTT", ""]
    for index, start in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else total
        lines += [f"{stamp(start)} --> {stamp(end)}", args.title.format(n=index + 1), ""]
    with open(output, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(lines))

    lengths = [(starts[i + 1] if i + 1 < len(starts) else total) - start for i, start in enumerate(starts)]
    print(f"Audio length {stamp(total)}, {len(pauses)} pauses found.")
    print(f"{len(starts)} chapters, {min(lengths) / 60:.2f} to {max(lengths) / 60:.2f} minutes each.")
    if notes:
        print("Chapter starts:")
        print("\n".join(notes))
    print(f"Wrote {output}")
    print('Next: set "chapterSource": "vtt" and "chapters" in book.json, and raise "cacheVersion".')


if __name__ == "__main__":
    main()
