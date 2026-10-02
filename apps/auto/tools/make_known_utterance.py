import argparse
import ctypes
import hashlib
import json
from pathlib import Path
import struct
import wave

PHRASE = "summarize recent work"
VOICES = ("slt", "kal16", "rms", "awb")
MAX_SECONDS = 5.0
LIB_DIR = "/usr/lib/x86_64-linux-gnu"


class CstWave(ctypes.Structure):
    _fields_ = [("type", ctypes.c_char_p), ("sample_rate", ctypes.c_int), ("num_samples", ctypes.c_int),
                ("num_channels", ctypes.c_int), ("samples", ctypes.POINTER(ctypes.c_short))]


def synthesize(phrase, voice):
    if voice not in VOICES:
        raise ValueError("unsupported flite voice: " + voice)
    core = ctypes.CDLL(LIB_DIR + "/libflite.so.2.2", mode=ctypes.RTLD_GLOBAL)
    for dependency in ("libflite_usenglish.so.2.2", "libflite_cmulex.so.2.2"):
        ctypes.CDLL(LIB_DIR + "/" + dependency, mode=ctypes.RTLD_GLOBAL)
    library = ctypes.CDLL(LIB_DIR + "/libflite_cmu_us_%s.so.2.2" % voice)
    core.flite_init()
    register = getattr(library, "register_cmu_us_" + voice)
    register.restype = ctypes.c_void_p
    core.flite_text_to_wave.restype = ctypes.POINTER(CstWave)
    core.flite_text_to_wave.argtypes = [ctypes.c_char_p, ctypes.c_void_p]
    result = core.flite_text_to_wave(phrase.encode("ascii"), register())
    if not result:
        raise RuntimeError("flite returned no waveform")
    waveform = result.contents
    if waveform.num_channels != 1:
        raise RuntimeError("expected mono flite output")
    rate = waveform.sample_rate
    pcm = struct.pack("<%dh" % waveform.num_samples, *waveform.samples[:waveform.num_samples])
    return rate, pcm


def write_wav(path, rate, pcm):
    with wave.open(str(path), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(rate)
        target.writeframes(pcm)


def describe(path):
    with wave.open(str(path), "rb") as source:
        frames = source.getnframes()
        rate = source.getframerate()
        pcm = source.readframes(frames)
        samples = struct.unpack("<%dh" % frames, pcm)
        peak = max((abs(value) for value in samples), default=0)
        rms = (sum(value * value for value in samples) / frames) ** 0.5 if frames else 0.0
        return {"channels": source.getnchannels(), "sample_width_bytes": source.getsampwidth(), "sample_rate": rate,
                "samples": frames, "duration_s": round(frames / rate, 3), "peak": peak, "rms": round(rms, 1),
                "sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description="Generate the canonical benign diagnostic utterance with the system flite library")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--phrase", default=PHRASE)
    parser.add_argument("--voice", default=VOICES[0], choices=VOICES)
    args = parser.parse_args()
    rate, pcm = synthesize(args.phrase, args.voice)
    if len(pcm) / 2 / rate > MAX_SECONDS:
        raise SystemExit("utterance exceeds five seconds")
    write_wav(args.out, rate, pcm)
    info = describe(args.out)
    info.update({"phrase": args.phrase, "voice": "flite cmu_us_" + args.voice, "library": "libflite 2.2 via ctypes"})
    print(json.dumps(info, indent=2))


if __name__ == "__main__":
    main()
