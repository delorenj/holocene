"""Record what the simulator plays (its audio OUTPUT) with a host-clock time on every packet.

The emulator's gRPC streamAudio hands out the guest's mixed output as it is played. Each packet carries the epoch
microsecond it was produced, so the result can be lined up with logcat (device clock) and server logs (host clock):

    uv run --no-project --with "protobuf>=7.35" --with grpcio python tools/sim_audio_tap.py --port 8554 \
        --seconds 1800 --out /tmp/tap

writes /tmp/tap.wav (16 kHz mono, packets back to back, no gaps filled) and /tmp/tap.jsonl, one line per packet:
{"t": <epoch s the packet starts>, "n": <samples>, "r": <sample rate>, "rms": .., "peak": ..}.
speech_overlap.py reads the jsonl.
Read-only for the guest: it never touches the microphone.
"""
import argparse
import json
import math
from pathlib import Path
import struct
import sys
import threading
import time
import wave

sys.path.insert(0, str(Path(__file__).resolve().parent))
import emulator_audio as ea  # noqa: E402


def level(pcm):
    n = len(pcm) // 2
    if not n:
        return 0.0, 0
    s = struct.unpack("<%dh" % n, pcm[:n * 2])
    return math.sqrt(sum(v * v for v in s) / n), max(abs(v) for v in s)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--port", type=int, default=8554)
    p.add_argument("--seconds", type=float, required=True)
    p.add_argument("--out", type=Path, required=True, help="path prefix: <out>.wav and <out>.jsonl")
    a = p.parse_args(argv)
    ctrl = ea.Controller(a.port, ea.auth_token(a.port))
    call = ctrl.stub.streamAudio(ctrl.audio_format(), metadata=ctrl.metadata(), timeout=a.seconds + 30)
    threading.Thread(target=lambda: (time.sleep(a.seconds), call.cancel()), daemon=True).start()
    packets = 0
    with wave.open(str(a.out) + ".wav", "wb") as w, open(str(a.out) + ".jsonl", "w") as j:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(ea.RATE)
        try:
            for pk in call:
                rms, peak = level(pk.audio)
                w.writeframes(pk.audio)
                j.write(json.dumps({"t": round(pk.timestamp / 1e6, 4), "n": len(pk.audio) // 2, "r": ea.RATE,
                                    "rms": round(rms, 1), "peak": peak}) + "\n")
                packets += 1
                if packets % 250 == 0:
                    j.flush()
        except ctrl.grpc.RpcError as failure:
            if failure.code() != ctrl.grpc.StatusCode.CANCELLED:
                print("stream ended: %s" % failure.code().name, file=sys.stderr)
    print(json.dumps({"packets": packets, "out": str(a.out)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
