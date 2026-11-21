import re
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "tools" / "make-chapters.py"


class ChapterScriptTest(unittest.TestCase):
    def test_short_chapter_limits_cover_the_recording(self):
        with tempfile.TemporaryDirectory() as folder:
            audio = Path(folder) / "sample.wav"
            with wave.open(str(audio), "wb") as wav:
                wav.setparams((1, 2, 8000, 0, "NONE", ""))
                wav.writeframes(bytes(21 * 8000 * 2))
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
