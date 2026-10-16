#!/usr/bin/env python3
"""Drive the Honda IVI simulator's vehicle HAL through the emulator's incubating CarService gRPC.

Same channel Android Studio's "Car data" extended-controls page uses: CarService.sendCarEvent carries
a serialized vhal_proto EmulatorMessage (SET_PROPERTY_CMD) straight into the guest's vehicle HAL.
That works on this *user* build, where `adb shell cmd car_service inject-vhal-event` is refused.

Needs only grpcio (no generated stubs; the messages are hand-encoded):
  uv run --no-project --with grpcio python sim_car.py drive
"""
import argparse
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from emulator_audio import auth_token  # stdlib-only at import time

SEND = "/android.emulation.control.incubating.CarService/sendCarEvent"
SET_PROPERTY_CMD = 8

# VehicleProperty ids (GLOBAL area 0).
PARKING_BRAKE_ON = 0x11200402  # bool
GEAR_SELECTION = 0x11400400  # int32 bit: N=1 R=2 P=4 D=8
PERF_VEHICLE_SPEED = 0x11600207  # float, m/s
HW_KEY_INPUT = 0x11410A10  # int32[]: action(0 down, 1 up), keycode, display (0 main, 1 cluster)

GEAR_N, GEAR_R, GEAR_P, GEAR_D = 1, 2, 4, 8

# name -> (brake_on, gear, speed m/s)
PRESETS = {
    "drive": (0, GEAR_D, 13.4),   # ~30 mph: moving, UXR 0x1ff, requiresDistractionOptimization
    "idle": (0, GEAR_D, 0.0),     # stopped in D: idling, UXR 0x10
    "reverse": (0, GEAR_R, 1.5),
    "park": (1, GEAR_P, 0.0),     # parked: unrestricted
}


def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def zigzag32(n):
    return (n << 1) ^ (n >> 31)


def field(num, wire, payload):
    return varint(num << 3 | wire) + payload


def delimited(num, body):
    return field(num, 2, varint(len(body)) + body)


def prop_value(prop, ints=(), floats=()):
    body = field(1, 0, varint(prop)) + field(4, 0, varint(0))  # prop, area_id 0
    if ints:
        body += delimited(5, b"".join(varint(zigzag32(i)) for i in ints))  # repeated sint32
    if floats:
        body += delimited(7, b"".join(struct.pack("<f", f) for f in floats))
    return body


def set_property(prop, ints=(), floats=()):
    message = field(1, 0, varint(SET_PROPERTY_CMD)) + delimited(5, prop_value(prop, ints, floats))
    return delimited(1, message)  # CarEvent { bytes data = 1 }


class Car:
    def __init__(self, port):
        import grpc
        self.grpc = grpc
        self.metadata = (("authorization", "Bearer " + (auth_token(port) or "")),)
        self.send = grpc.insecure_channel("127.0.0.1:%d" % port).unary_unary(
            SEND, request_serializer=lambda b: b, response_deserializer=lambda b: b)

    def set(self, prop, ints=(), floats=()):
        self.send(set_property(prop, ints, floats), metadata=self.metadata, timeout=5)


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8554)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in PRESETS:
        sub.add_parser(name)
    sp = sub.add_parser("speed")
    sp.add_argument("mps", type=float)
    kp = sub.add_parser("hwkey")
    kp.add_argument("code", type=int)
    kp.add_argument("--display", type=int, default=0)
    kp.add_argument("--hold-ms", type=int, default=80)
    args = ap.parse_args(argv)
    car = Car(args.port)
    try:
        if args.cmd in PRESETS:
            brake, gear, speed = PRESETS[args.cmd]
            car.set(PARKING_BRAKE_ON, ints=[brake])
            car.set(GEAR_SELECTION, ints=[gear])
            car.set(PERF_VEHICLE_SPEED, floats=[speed])
        elif args.cmd == "speed":
            car.set(PERF_VEHICLE_SPEED, floats=[args.mps])
        elif args.cmd == "hwkey":
            import time
            car.set(HW_KEY_INPUT, ints=[0, args.code, args.display])
            time.sleep(args.hold_ms / 1000)
            car.set(HW_KEY_INPUT, ints=[1, args.code, args.display])
    except car.grpc.RpcError as error:
        sys.exit("emulator gRPC refused: %s %s (is the sim up with -grpc 8554? mise run auto:sim)"
                 % (error.code(), error.details()))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
