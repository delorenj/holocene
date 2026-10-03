import argparse
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import sys
import threading
import time
import wave

TOOLS = Path(__file__).resolve().parent
GEN = TOOLS / "_gen"
PROTO_DIR = Path(os.environ.get("ANDROID_HOME", str(Path.home() / "Android/Sdk"))) / "emulator/lib"
RATE = 16000
FRAME_MS = 20
MAX_INPUT_SECONDS = 5.0
MAX_FRAME_BYTES = 48000
TOKEN_FILE = Path.home() / ".emulator_console_auth_token"


def mask(text, token):
    return text.replace(token, "<redacted>") if token else text


def read_token(path=TOKEN_FILE):
    return Path(path).read_text().strip()


def read_wav(path):
    with wave.open(str(path), "rb") as source:
        channels = source.getnchannels()
        width = source.getsampwidth()
        rate = source.getframerate()
        frames = source.getnframes()
        if channels != 1 or width != 2:
            raise ValueError("input must be mono signed 16-bit PCM")
        if rate != RATE:
            raise ValueError("input must be %d Hz" % RATE)
        if frames / rate > MAX_INPUT_SECONDS:
            raise ValueError("input exceeds %.1f seconds" % MAX_INPUT_SECONDS)
        pcm = source.readframes(frames)
        return rate, pcm


def split_frames(pcm, rate=RATE, frame_ms=FRAME_MS):
    size = rate * frame_ms // 1000 * 2
    if size > MAX_FRAME_BYTES:
        raise ValueError("frame exceeds the injection buffer budget")
    for start in range(0, len(pcm), size):
        chunk = pcm[start:start + size]
        if len(chunk) % 2:
            chunk += b"\0"
        yield chunk


def silence(milliseconds, rate=RATE):
    return b"\0\0" * (rate * milliseconds // 1000)


def stats(pcm, window_ms=100, rate=RATE):
    count = len(pcm) // 2
    samples = struct.unpack("<%dh" % count, pcm[:count * 2])
    if not count:
        return {"samples": 0, "rms": 0.0, "peak": 0, "nonzero": 0, "envelope": []}
    window = rate * window_ms // 1000
    envelope = []
    for start in range(0, count - window + 1, window):
        chunk = samples[start:start + window]
        envelope.append(int(math.sqrt(sum(v * v for v in chunk) / window)))
    return {"samples": count, "rms": round(math.sqrt(sum(v * v for v in samples) / count), 1),
            "peak": max(abs(v) for v in samples), "nonzero": sum(1 for v in samples if v), "envelope": envelope}


def activity_span(envelope, threshold, window_ms=100):
    active = [index for index, value in enumerate(envelope) if value >= threshold]
    if not active:
        return None
    return {"first_ms": active[0] * window_ms, "last_ms": (active[-1] + 1) * window_ms}


def write_wav(path, pcm, rate=RATE):
    with wave.open(str(path), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(rate)
        target.writeframes(pcm)


def ensure_stubs():
    if (GEN / "emulator_controller_pb2_grpc.py").exists():
        return
    GEN.mkdir(exist_ok=True)
    subprocess.run([sys.executable, "-m", "grpc_tools.protoc", "-I", str(PROTO_DIR), "--python_out=" + str(GEN),
                    "--grpc_python_out=" + str(GEN), str(PROTO_DIR / "emulator_controller.proto")], check=True)


def load_stubs():
    ensure_stubs()
    sys.path.insert(0, str(GEN))
    import grpc
    import emulator_controller_pb2 as pb
    import emulator_controller_pb2_grpc as rpc
    return grpc, pb, rpc


class Controller:
    def __init__(self, port, token, host="127.0.0.1"):
        self.grpc, self.pb, self.rpc = load_stubs()
        self.token = token
        self.channel = self.grpc.insecure_channel("%s:%d" % (host, port))
        self.stub = self.rpc.EmulatorControllerStub(self.channel)

    def metadata(self, authenticated=True):
        return (("authorization", "Bearer " + self.token),) if authenticated and self.token else ()

    def status(self, authenticated=True, timeout=10):
        from google.protobuf import empty_pb2
        return self.stub.getStatus(empty_pb2.Empty(), metadata=self.metadata(authenticated), timeout=timeout)

    def microphone(self, enabled=None, timeout=10):
        from google.protobuf import empty_pb2
        if enabled is not None:
            self.stub.setMicrophoneState(self.pb.MicrophoneState(realAudioEnabled=enabled), metadata=self.metadata(), timeout=timeout)
        return self.stub.getMicrophoneState(empty_pb2.Empty(), metadata=self.metadata(), timeout=timeout).realAudioEnabled

    def audio_format(self, mode=None):
        fmt = self.pb.AudioFormat(samplingRate=RATE, channels=self.pb.AudioFormat.Mono, format=self.pb.AudioFormat.AUD_FMT_S16)
        if mode is not None:
            fmt.mode = mode
        return fmt

    def inject(self, pcm, lead_ms=0, tail_ms=0, timeout=30, cancel=None):
        payload = silence(lead_ms) + pcm + silence(tail_ms)
        fmt = self.audio_format()
        sent = {"packets": 0, "bytes": 0, "cancelled": False}
        finished = threading.Event()
        cancelled_rpc = threading.Event()

        def requests():
            for chunk in split_frames(payload):
                if cancel is not None and cancel.is_set():
                    sent["cancelled"] = True
                    return
                sent["packets"] += 1
                sent["bytes"] += len(chunk)
                yield self.pb.AudioPacket(format=fmt, timestamp=int(time.time() * 1e6), audio=chunk)
        started = time.monotonic()
        call = self.stub.injectAudio.future(requests(), metadata=self.metadata(), timeout=timeout)

        def cancel_when_requested():
            while not finished.wait(0.05):
                if cancel is not None and cancel.is_set():
                    cancelled_rpc.set()
                    call.cancel()
                    return

        watcher = threading.Thread(target=cancel_when_requested, daemon=True)
        watcher.start()
        try:
            call.result(timeout=timeout)
        except self.grpc.FutureCancelledError:
            if cancelled_rpc.is_set():
                sent["cancelled"] = True
            else:
                raise
        except self.grpc.RpcError as failure:
            if failure.code() == self.grpc.StatusCode.CANCELLED and cancelled_rpc.is_set():
                sent["cancelled"] = True
            else:
                raise
        finally:
            finished.set()
        sent["elapsed_s"] = round(time.monotonic() - started, 3)
        sent["lead_ms"] = lead_ms
        sent["tail_ms"] = tail_ms
        return sent

    def capture(self, seconds, started=None, timeout_margin=5.0):
        call = self.stub.streamAudio(self.audio_format(), metadata=self.metadata(), timeout=seconds + timeout_margin)
        chunks = []
        stamps = []
        begin = time.monotonic()
        ready = threading.Event()

        def stopper():
            time.sleep(seconds)
            call.cancel()
        threading.Thread(target=stopper, daemon=True).start()
        error = None
        try:
            for packet in call:
                if not ready.is_set():
                    ready.set()
                    if started is not None:
                        started.set()
                chunks.append(packet.audio)
                stamps.append(round(time.monotonic() - begin, 3))
        except self.grpc.RpcError as failure:
            error = failure.code().name
        return b"".join(chunks), stamps, error


def command_status(args):
    token = read_token()
    ctrl = Controller(args.port, token)
    report = {"unauthenticated": None, "authenticated": None, "microphone_real_audio": None}
    try:
        ctrl.status(authenticated=False)
        report["unauthenticated"] = "ACCEPTED"
    except ctrl.grpc.RpcError as failure:
        report["unauthenticated"] = failure.code().name
    status = ctrl.status()
    report["authenticated"] = "OK uptime_ms=%d booted=%s" % (status.uptime, status.booted)
    report["microphone_real_audio"] = ctrl.microphone(False if args.disable_host_mic else None)
    print(json.dumps(report))


def command_inject(args):
    token = read_token()
    ctrl = Controller(args.port, token)
    rate, pcm = read_wav(args.wav)
    result = ctrl.inject(pcm, args.lead_ms, args.tail_ms)
    result["input_stats"] = {k: v for k, v in stats(pcm).items() if k != "envelope"}
    result["injected_at_epoch"] = round(time.time(), 3)
    print(json.dumps(result))


def command_capture(args):
    token = read_token()
    ctrl = Controller(args.port, token)
    pcm, stamps, error = ctrl.capture(args.seconds)
    if args.out:
        write_wav(args.out, pcm)
    result = stats(pcm)
    result.update({"packets": len(stamps), "first_packet_s": stamps[0] if stamps else None, "stream_end": error or "EOF", "bytes": len(pcm)})
    result["active"] = activity_span(result["envelope"], max(50, result["peak"] // 20))
    print(json.dumps(result))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Authenticated loopback emulator audio injection and capture")
    sub = parser.add_subparsers(dest="command", required=True)
    status = sub.add_parser("status")
    status.add_argument("--port", type=int, required=True)
    status.add_argument("--disable-host-mic", action="store_true")
    status.set_defaults(run=command_status)
    inject = sub.add_parser("inject")
    inject.add_argument("--port", type=int, required=True)
    inject.add_argument("--wav", type=Path, required=True)
    inject.add_argument("--lead-ms", type=int, default=0)
    inject.add_argument("--tail-ms", type=int, default=1500)
    inject.set_defaults(run=command_inject)
    capture = sub.add_parser("capture")
    capture.add_argument("--port", type=int, required=True)
    capture.add_argument("--seconds", type=float, required=True)
    capture.add_argument("--out", type=Path)
    capture.set_defaults(run=command_capture)
    args = parser.parse_args(argv)
    try:
        args.run(args)
    except Exception as failure:
        token = ""
        try:
            token = read_token()
        except OSError:
            pass
        print(mask("%s: %s" % (type(failure).__name__, failure), token), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
