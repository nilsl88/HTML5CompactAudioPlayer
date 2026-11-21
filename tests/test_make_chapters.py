import errno
import os
import re
import runpy
import subprocess
import sys
import tempfile
import unittest
import wave
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "tools" / "make-chapters.py"


def write_sample(audio, seconds):
    with wave.open(str(audio), "wb") as wav:
        wav.setparams((1, 2, 8000, 0, "NONE", ""))
        wav.writeframes(bytes(seconds * 8000 * 2))


class ChapterScriptTest(unittest.TestCase):
    def test_pause_log_pairs_boundaries_and_ignores_unfinished_intervals(self):
        parse_pauses = runpy.run_path(str(SCRIPT))["parse_pauses"]
        log = "silence_end: 0\rsilence_start: -0.01\nsilence_end: 1.2\nprogress\nsilence_start: 8"
        self.assertEqual(parse_pauses(log), [(0.0, 1.2)])

    def test_failed_copy_on_mount_removes_only_the_partial_output(self):
        publish = runpy.run_path(str(SCRIPT))["publish_new_file"]
        with tempfile.TemporaryDirectory() as folder:
            staged = Path(folder) / "staged"
            output = Path(folder) / "chapters.vtt"
            staged.write_bytes(b"WEBVTT\n\n")
            with patch("os.link", side_effect=OSError(errno.ENOTSUP, "No hard links")):
                @contextmanager
                def fail_on_close(path, mode):
                    with open(path, mode) as handle:
                        yield handle
                    if mode == "xb":
                        raise OSError(errno.ENOSPC, "Flush failed")

                with patch.dict(publish.__globals__, {"open": fail_on_close}), self.assertRaises(OSError):
                    publish(staged, output)
                self.assertFalse(output.exists())
                for replaced in (False, True):
                    def interrupt(source, destination):
                        destination.write(source.read(4))
                        if replaced:
                            output.unlink()
                            output.write_bytes(b"Another writer's chapters")
                        raise OSError(errno.ENOSPC, "Full")

                    with patch("shutil.copyfileobj", side_effect=interrupt), self.assertRaises(OSError):
                        publish(staged, output)
                    if replaced:
                        self.assertEqual(output.read_bytes(), b"Another writer's chapters")
                        with self.assertRaises(FileExistsError):
                            publish(staged, output)
                    else:
                        self.assertFalse(output.exists())
                        publish(staged, output)
                        self.assertEqual(output.read_bytes(), staged.read_bytes())
                        output.unlink()

    def test_force_preserves_audio_even_when_the_output_is_an_alias(self):
        with tempfile.TemporaryDirectory() as folder:
            audio = Path(folder) / "sample.wav"
            write_sample(audio, 1)
            original = audio.read_bytes()
            symlink = audio.with_name("symbolic.vtt")
            symlink.symlink_to(audio)
            hardlink = audio.with_name("hard.vtt")
            os.link(audio, hardlink)
            for output in (audio, symlink, hardlink):
                with self.subTest(output=output):
                    audio.write_bytes(original)
                    result = subprocess.run(
                        [sys.executable, str(SCRIPT), str(audio), "-o", str(output), "--force"],
                        capture_output=True, text=True, timeout=5,
                    )
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("audio file", result.stderr)
                    self.assertEqual(audio.read_bytes(), original)
                    self.assertTrue(output.samefile(audio))
            chapters = audio.with_name("chapters.vtt")
            chapters.write_text("Existing chapters")
            chapters.chmod(0o640)
            original_mode = chapters.stat().st_mode
            command = [sys.executable, str(SCRIPT), str(audio), "-o", str(chapters)]
            self.assertNotEqual(subprocess.run(command, capture_output=True, timeout=5).returncode, 0)
            self.assertEqual(chapters.read_text(), "Existing chapters")
            subprocess.run([*command, "--force"], capture_output=True, check=True, timeout=5)
            self.assertTrue(chapters.read_text().startswith("WEBVTT\n"))
            self.assertEqual(chapters.stat().st_mode, original_mode)
            self.assertEqual(audio.read_bytes(), original)

    def test_short_chapter_limits_cover_the_recording(self):
        with tempfile.TemporaryDirectory() as folder:
            audio = Path(folder) / "sample.wav"
            write_sample(audio, 21)
            for seconds in (3, 10, 10.0001):
                with self.subTest(seconds=seconds):
                    output = audio.with_name(f"chapters-{seconds}.vtt")
                    subprocess.run(
                        [sys.executable, str(SCRIPT), str(audio), "-o", str(output),
                         "--max-minutes", str(seconds / 60)],
                        check=True, capture_output=True, timeout=5,
                    )
                    cues = re.findall(r"00:00:([\d.]+) --> 00:00:([\d.]+)", output.read_text())
                    previous_end = 0
                    for start, end in cues:
                        start, end = float(start), float(end)
                        self.assertEqual(start, previous_end)
                        self.assertGreater(end, start)
                        self.assertLessEqual(end - start, seconds + 0.001)
                        previous_end = end
                    self.assertEqual(previous_end, 21)


if __name__ == "__main__":
    unittest.main()
