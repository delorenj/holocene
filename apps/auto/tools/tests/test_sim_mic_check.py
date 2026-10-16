import importlib.util
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("sim_mic_check", TOOLS / "sim_mic_check.py")
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)

QEMU = '''Source Output #{id}
\tDriver: PipeWire
\tSource: 71
\tCorked: {corked}
\tProperties:
\t\tapplication.name = "qemu-system-x86_64"
\t\tapplication.process.binary = "qemu-system-x86_64"
'''
FFMPEG = '''Source Output #9
\tDriver: PipeWire
\tCorked: no
\tProperties:
\t\tapplication.name = "Lavf61.7.100"
\t\tapplication.process.binary = "ffmpeg"
'''


def pactl(*specs):
    return "\n".join(QEMU.format(id=i, corked=c) for i, c in specs) + "\n" + FFMPEG


class ParseTests(unittest.TestCase):
    def test_streams_and_cork_state(self):
        streams = M.parse_source_outputs(pactl((11, "yes"), (12, "no")))
        self.assertEqual([(s["id"], s["corked"]) for s in streams], [(11, True), (12, False), (9, False)])
        self.assertEqual([s["id"] for s in M.qemu_streams(streams)], [11, 12])

    def test_mic_result_line(self):
        log = ("10-16 15:44:29.1 I HoloceneProbe: event=mic_started t=1 gen=1 rate=16000\n"
               "10-16 15:44:35.2 I HoloceneProbe: event=mic_result t=2 gen=1 samples=96000 rms=142.7 peak=707 nonzero=95000 readError=0 envelope_100ms=1,2\n")
        self.assertEqual(M.parse_mic_result(log), (142.7, 707, 0, 96000))
        self.assertIsNone(M.parse_mic_result("event=mic_result_ignored late=true samples=3"))
        self.assertIsNone(M.parse_mic_result(""))


class VerdictTests(unittest.TestCase):
    def streams(self, *specs):
        return M.qemu_streams(M.parse_source_outputs(pactl(*specs)))

    def test_ok(self):
        code, text = M.verdict((142.7, 707, 0, 1), self.streams((1, "no")))
        self.assertEqual((code, text), (0, "OK (rms 142.7 peak 707)"))

    def test_stuck_corked_streams(self):
        code, text = M.verdict((2.0, 2, 0, 1), self.streams((1, "yes"), (2, "yes")))
        self.assertEqual(code, 1)
        self.assertIn("SILENT", text)
        self.assertIn("emulator audio stream stuck (2 corked qemu streams)", text)
        self.assertIn("mise run auto:sim:stop && mise run auto:sim", text)

    def test_one_corked_stream_is_singular(self):
        self.assertIn("(1 corked qemu stream)", M.verdict((2.0, 2, 0, 1), self.streams((1, "yes")))[1])

    def test_passthrough_off_means_no_qemu_stream(self):
        code, text = M.verdict((2.0, 2, 0, 1), [])
        self.assertEqual(code, 1)
        self.assertIn("passthrough is off", text)

    def test_muted_host_mic(self):
        code, text = M.verdict((0.0, 0, 0, 1), self.streams((1, "no")), host_muted=True)
        self.assertEqual(code, 1)
        self.assertIn("muted", text)

    def test_live_stream_but_silent_with_leaks(self):
        code, text = M.verdict((2.0, 2, 0, 1), self.streams((1, "no"), (2, "yes")), host_muted=False)
        self.assertEqual(code, 1)
        self.assertIn("live but delivers silence", text)
        self.assertIn("1 leaked corked", text)

    def test_peak_just_under_the_contract_line_is_silent(self):
        self.assertEqual(M.verdict((20.0, 32, 0, 1), self.streams((1, "no")))[0], 1)
        self.assertEqual(M.verdict((20.0, 33, 0, 1), self.streams((1, "no")))[0], 0)

    def test_no_pactl_still_reports_silence(self):
        code, text = M.verdict((2.0, 2, 0, 1), None)
        self.assertEqual(code, 1)
        self.assertIn("pactl is unavailable", text)

    def test_read_error_and_missing_result(self):
        self.assertEqual(M.verdict((0.0, 0, -3, 0), [])[0], 1)
        self.assertEqual(M.verdict(None, [])[0], 2)


if __name__ == "__main__":
    unittest.main()
