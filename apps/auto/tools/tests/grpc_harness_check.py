import json
from pathlib import Path
import sys
import threading
import time

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
import emulator_audio as audio

grpc, pb, rpc = audio.load_stubs()
from concurrent import futures
from google.protobuf import empty_pb2

TOKEN = "unit-test-token-not-a-secret"
SIGNAL = (b"\x10\x27\xf0\xd8" * 800)


class Auth(grpc.ServerInterceptor):
    def intercept_service(self, continuation, details):
        metadata = dict(details.invocation_metadata)
        if metadata.get("authorization") != "Bearer " + TOKEN:
            def deny(request, context):
                context.abort(grpc.StatusCode.UNAUTHENTICATED, "missing or wrong token")
            return grpc.unary_unary_rpc_method_handler(deny)
        return continuation(details)


class Fake(rpc.EmulatorControllerServicer):
    def __init__(self):
        self.packets = []
        self.mic = True
        self.stream_cancelled = threading.Event()

    def getStatus(self, request, context):
        return pb.EmulatorStatus(uptime=7, booted=True)

    def getMicrophoneState(self, request, context):
        return pb.MicrophoneState(realAudioEnabled=self.mic)

    def setMicrophoneState(self, request, context):
        self.mic = request.realAudioEnabled
        return empty_pb2.Empty()

    def injectAudio(self, request_iterator, context):
        for packet in request_iterator:
            self.packets.append((packet.format.samplingRate, packet.format.channels, packet.format.format, len(packet.audio)))
        return empty_pb2.Empty()

    def streamAudio(self, request, context):
        context.add_callback(self.stream_cancelled.set)
        for start in range(0, len(SIGNAL), 640):
            yield pb.AudioPacket(format=request, timestamp=1, audio=SIGNAL[start:start + 640])
        while context.is_active():
            time.sleep(0.01)


def main():
    fake = Fake()
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=4), interceptors=[Auth()])
    rpc.add_EmulatorControllerServicer_to_server(fake, server)
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    out = {}
    try:
        ctrl = audio.Controller(port, TOKEN)
        try:
            ctrl.status(authenticated=False)
            out["unauthenticated"] = "ACCEPTED"
        except grpc.RpcError as failure:
            out["unauthenticated"] = failure.code().name
        wrong = audio.Controller(port, "wrong")
        try:
            wrong.status()
            out["wrong_token"] = "ACCEPTED"
        except grpc.RpcError as failure:
            out["wrong_token"] = failure.code().name
        out["authenticated"] = ctrl.status().booted
        out["mic_after_disable"] = ctrl.microphone(False)
        pcm = (b"\x01\x00" * 16000)[:16000 * 2]
        started = time.monotonic()
        sent = ctrl.inject(pcm, lead_ms=100, tail_ms=200)
        out["inject_packets"] = sent["packets"]
        out["inject_bytes"] = sent["bytes"]
        out["inject_formats"] = sorted(set(p[:3] for p in fake.packets))
        out["inject_max_packet"] = max(p[3] for p in fake.packets)
        cancel = threading.Event()
        cancel.set()
        fake.packets.clear()
        cancelled = ctrl.inject(pcm, cancel=cancel)
        out["cancelled_inject"] = cancelled["cancelled"]
        out["cancelled_packets"] = cancelled["packets"]
        began = time.monotonic()
        captured, stamps, error = ctrl.capture(0.5)
        out["capture_bytes"] = len(captured)
        out["capture_error"] = error
        out["capture_bounded_s"] = round(time.monotonic() - began, 2)
        out["capture_matches_signal"] = captured == SIGNAL
        out["server_saw_cancel"] = fake.stream_cancelled.wait(2)
    finally:
        server.stop(0)
    print(json.dumps(out))


main()
