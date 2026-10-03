import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import wave
from unittest import mock

TESTS = Path(__file__).resolve().parent
TOOLS = TESTS.parent
VENV_PYTHON = TOOLS / ".venv/bin/python"


def load(name):
    spec = importlib.util.spec_from_file_location(name, TOOLS / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AUDIO = load("emulator_audio")
BUDGET = load("emulator_budget")
UTTERANCE = load("make_known_utterance")
ASSET = TOOLS / "assets/summarize-recent-work.wav"
PROVENANCE = TOOLS / "assets/summarize-recent-work.provenance.json"


class WaveformTests(unittest.TestCase):
    def test_silence_has_zero_energy(self):
        result = AUDIO.stats(AUDIO.silence(500))
        self.assertEqual((result["samples"], result["peak"], result["nonzero"], result["rms"]), (8000, 0, 0, 0.0))

    def test_signal_rms_peak_and_envelope(self):
        pcm = (b"\xe8\x03" * 1600) + AUDIO.silence(100)
        result = AUDIO.stats(pcm)
        self.assertEqual(result["peak"], 1000)
        self.assertEqual(result["envelope"], [1000, 0])
        self.assertEqual(AUDIO.activity_span(result["envelope"], 100), {"first_ms": 0, "last_ms": 100})
        self.assertIsNone(AUDIO.activity_span([0, 0], 100))

    def test_frames_are_small_even_and_lossless(self):
        pcm = bytes(range(256)) * 20
        frames = list(AUDIO.split_frames(pcm))
        self.assertTrue(all(len(frame) <= 640 and len(frame) % 2 == 0 for frame in frames))
        self.assertEqual(b"".join(frames), pcm)
        self.assertLessEqual(max(len(f) for f in frames), AUDIO.MAX_FRAME_BYTES)

    def test_odd_trailing_byte_is_padded(self):
        self.assertEqual(len(list(AUDIO.split_frames(b"\x01\x00\x02"))[-1]) % 2, 0)

    def test_injection_budget_is_three_hundred_milliseconds_or_less_per_packet(self):
        self.assertLessEqual(AUDIO.FRAME_MS, 300)
        self.assertLessEqual(AUDIO.RATE * AUDIO.FRAME_MS // 1000 * 2, 48000)


class InputValidationTests(unittest.TestCase):
    def write(self, directory, name, channels, width, rate, seconds):
        path = Path(directory) / name
        with wave.open(str(path), "wb") as target:
            target.setnchannels(channels)
            target.setsampwidth(width)
            target.setframerate(rate)
            target.writeframes(b"\0" * int(rate * seconds) * channels * width)
        return path

    def test_rejects_wrong_format_and_over_five_seconds(self):
        with tempfile.TemporaryDirectory() as directory:
            for args in ((2, 2, 16000, 1), (1, 1, 16000, 1), (1, 2, 44100, 1), (1, 2, 16000, 5.5)):
                with self.assertRaises(ValueError):
                    AUDIO.read_wav(self.write(directory, "bad.wav", *args))
            rate, pcm = AUDIO.read_wav(self.write(directory, "ok.wav", 1, 2, 16000, 5))
            self.assertEqual((rate, len(pcm)), (16000, 160000))

    def test_overlong_wav_is_rejected_before_samples_are_loaded(self):
        source = mock.MagicMock()
        source.__enter__.return_value = source
        source.__exit__.return_value = None
        source.getnchannels.return_value = 1
        source.getsampwidth.return_value = 2
        source.getframerate.return_value = AUDIO.RATE
        source.getnframes.return_value = AUDIO.RATE * 6
        with mock.patch.object(AUDIO.wave, "open", return_value=source):
            with self.assertRaises(ValueError):
                AUDIO.read_wav("overlong.wav")
        source.readframes.assert_not_called()

    def test_token_is_masked_in_error_text(self):
        self.assertEqual(AUDIO.mask("denied secret123 for secret123", "secret123"), "denied <redacted> for <redacted>")
        self.assertEqual(AUDIO.mask("plain", ""), "plain")


class CanonicalAssetTests(unittest.TestCase):
    def test_asset_matches_provenance_and_limits(self):
        info = json.loads(PROVENANCE.read_text())
        described = UTTERANCE.describe(ASSET)
        self.assertEqual(described["sha256"], info["sha256"])
        self.assertEqual((described["channels"], described["sample_width_bytes"], described["sample_rate"]), (1, 2, 16000))
        self.assertLessEqual(described["duration_s"], 5.0)
        self.assertGreater(described["peak"], 1000)
        self.assertEqual(info["phrase"], "summarize recent work")
        self.assertIn("separate evidence", info["claim_boundary"])

    def test_asset_is_reproducible_from_the_system_synthesizer(self):
        rate, pcm = UTTERANCE.synthesize(UTTERANCE.PHRASE, "slt")
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "again.wav"
            UTTERANCE.write_wav(target, rate, pcm)
            self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), json.loads(PROVENANCE.read_text())["sha256"])


class BudgetTests(unittest.TestCase):
    GIB = 1024 ** 3

    def test_stat_parser_ignores_non_numeric_lines(self):
        self.assertEqual(BUDGET.parse_stat("anon 10\nfile 5\nbad x\nlong line here 1\n"), {"anon": 10, "file": 5})

    def test_reclaimable_file_cache_does_not_trigger_a_stop(self):
        stat = {"file": 2 * self.GIB}
        self.assertIsNone(BUDGET.verdict(int(3.5 * self.GIB), stat))

    def test_pinned_memory_stops_before_the_cap(self):
        self.assertEqual(BUDGET.verdict(int(3.6 * self.GIB), {"file": int(0.1 * self.GIB)}), "pinned")
        self.assertLess(BUDGET.DEFAULT_LIMIT, BUDGET.DEFAULT_HARD)
        self.assertLess(BUDGET.DEFAULT_HARD, 4 * self.GIB)

    def test_hard_threshold_stops_regardless_of_cache(self):
        self.assertEqual(BUDGET.verdict(int(3.9 * self.GIB), {"file": 3 * self.GIB}), "hard")

    def test_foreign_or_missing_process_is_not_owned(self):
        self.assertFalse(BUDGET.owned(2 ** 22 + 12345, 5590))
        self.assertFalse(BUDGET.owned(1, 5590))


@unittest.skipUnless(VENV_PYTHON.exists(), "isolated grpc venv tools/.venv not present")
class GrpcHarnessTests(unittest.TestCase):
    def test_authenticated_paced_injection_bounded_capture_and_cancellation(self):
        result = subprocess.run([str(VENV_PYTHON), "-B", str(TESTS / "grpc_harness_check.py")], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(report["unauthenticated"], "UNAUTHENTICATED")
        self.assertEqual(report["wrong_token"], "UNAUTHENTICATED")
        self.assertTrue(report["authenticated"])
        self.assertFalse(report["mic_after_disable"])
        self.assertEqual(report["inject_formats"], [[16000, 0, 1]])
        self.assertLessEqual(report["inject_max_packet"], 640)
        self.assertEqual(report["inject_bytes"], 41600)
        self.assertTrue(report["cancelled_inject"])
        self.assertEqual(report["cancelled_packets"], 0)
        self.assertTrue(report["blocked_cancelled"])
        self.assertLess(report["blocked_elapsed_s"], 1.0)
        self.assertLessEqual(report["blocked_packets_before_cancel"], 1)
        self.assertTrue(report["server_saw_inject_cancel"])
        self.assertEqual(report["capture_error"], "CANCELLED")
        self.assertLess(report["capture_bounded_s"], 2.0)
        self.assertTrue(report["capture_matches_signal"])
        self.assertTrue(report["server_saw_cancel"])


if __name__ == "__main__":
    unittest.main()
