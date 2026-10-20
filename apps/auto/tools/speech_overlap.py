#!/usr/bin/env python3
"""Did the car ever say two things at once, or anything while the mic was open? Prints the intervals and the overlaps.

Three independent sources, all optional except the logcat:
  * the app's speech queue: logcat tag HoloceneSpeech (start / end / halt per utterance, mic arming / recording / idle);
  * the platform: AudioService's active recording configurations (the car's SpeechRecognitionManagerService dumps them on
    every change: "session:N -- source client=MIC" while a capture runs, "null or empty" when none does) are when the OS
    had the microphone open, and the Honda audio HAL's AudioFocusControl MM_AF,AMP startMixing/stopMixing is when it
    mixed an assistant source (our TTS, earcons and clips) into the speakers. (SystemUI's mic indicator is no use here:
    it is held on screen for a minimum time after a capture ends.);
  * what the speakers actually got: the emulator's audio OUTPUT captured with tools/sim_audio_tap.py (host clock, so
    --offset-ms, device minus host, lines it up with logcat).

    adb -s emulator-5554 logcat -v epoch > logcat.txt           # while the test runs
    python3 tools/speech_overlap.py --logcat logcat.txt --tap tap.jsonl --offset-ms -1293 [--from T --to T]

Checks (each prints PASS or FAIL with the offending intervals):
  1 speech x speech      two queue utterances whose [start, end) intersect
  2 speech x recording   an utterance (the arming prompt included) inside the app's recording window or the OS capture window
  3 HAL mix x OS mic     the audio HAL mixing our assistant source while the OS had a capture running
  4 audio x mic open     sound on the speakers while the app or the OS had the mic open (needs --tap)
  5 audio with no owner  sound that no utterance started within --latency-ms before it (speech that outlived its end)
Exit status 1 when any check fails.
"""
import argparse
import json
import re
import sys

SPEECH = re.compile(r"^\s*(\d+\.\d+)\s+\d+\s+\d+\s+\w\s+HoloceneSpeech:\s+(\w+) (\w*) id=(\S*) memo=(\S+) seq=(-?\d+) "
                    r"mic=(\w+) reason=(.*?) at=(\d+)\s*$")
OS_MIC = re.compile(r"^\s*(\d+\.\d+)\s.*dumpAudioRecordingConfigurations, (session:\d+ -- source client=MIC|List<AudioRecordingConfiguration> is null or empty)")
AMP = re.compile(r"^\s*(\d+\.\d+)\s.*AudioFocusControl: MM_AF,AMP,(startMixing|stopMixing)")


class Span:
    def __init__(self, kind, label, start, end=None, detail=""):
        self.kind, self.label, self.start, self.end, self.detail = kind, label, start, end, detail

    def closed(self, horizon):
        return self.end if self.end is not None else horizon

    def __repr__(self):
        return "%s %s [%.3f, %s)" % (self.kind, self.label, self.start, "open" if self.end is None else "%.3f" % self.end)


def parse_logcat(path, lo, hi):
    speech, rec_app, os_mic, amp = [], [], [], []
    open_u = {}
    rec = None
    mic_on = None
    mix_on = None
    last = 0.0
    with open(path, errors="replace") as f:
        for line in f:
            m = SPEECH.match(line)
            if m:
                t = int(m.group(9)) / 1000.0  # the app's own wall clock stamp (same clock as logcat's epoch)
                if t < lo or t > hi:
                    continue
                last = max(last, t)
                action, kind, uid, memo, seq, mic, reason = m.group(2, 3, 4, 5, 6, 7, 8)
                if action == "start":
                    open_u[uid] = Span("speech", "%s %s" % (kind, short(uid)), t, detail=memo)
                elif action in ("end", "halt") and uid in open_u:
                    s = open_u.pop(uid)
                    s.end = t
                    s.detail = "%s -> %s %s" % (s.detail, action, reason)
                    speech.append(s)
                elif action == "mic":
                    if reason == "recording":
                        rec = Span("recording", "app mic", t)
                    elif reason == "idle" and rec is not None:
                        rec.end = t
                        rec_app.append(rec)
                        rec = None
                continue
            m = OS_MIC.match(line)
            if m:
                t = float(m.group(1))
                if t < lo or t > hi:
                    continue
                last = max(last, t)
                active = m.group(2).startswith("session")
                if active and mic_on is None:
                    mic_on = t
                elif not active and mic_on is not None:
                    os_mic.append(Span("recording", "OS capture active", mic_on, t))
                    mic_on = None
                continue
            m = AMP.match(line)
            if m:
                t = float(m.group(1))
                if t < lo or t > hi:
                    continue
                if m.group(2) == "startMixing" and mix_on is None:
                    mix_on = t
                elif m.group(2) == "stopMixing" and mix_on is not None:
                    amp.append(Span("hal", "assistant mix", mix_on, t))
                    mix_on = None
    for s in open_u.values():
        speech.append(s)
    if rec is not None:
        rec_app.append(rec)
    if mic_on is not None:
        os_mic.append(Span("recording", "OS capture active", mic_on))
    if mix_on is not None:
        amp.append(Span("hal", "assistant mix", mix_on))
    speech.sort(key=lambda s: s.start)
    return speech, rec_app, os_mic, amp, last


def short(uid):
    if uid.startswith("replies/"):
        tail = uid.rsplit("/", 1)[-1]
        return tail[:24] + "..." + tail[-12:] if len(tail) > 40 else tail
    return uid if len(uid) <= 40 else uid[:37] + "..."


def parse_tap(path, offset_s, lo, hi, threshold, merge_gap):
    """Sound on the speakers as device-clock spans: packets with rms over threshold, merged across short gaps."""
    spans = []
    cur = None
    with open(path) as f:
        for line in f:
            try:
                p = json.loads(line)
            except ValueError:
                continue
            t = p["t"] + offset_s
            if t < lo or t > hi:
                continue
            e = t + p["n"] / 16000.0
            if p["rms"] < threshold:
                continue
            if cur and t - cur.end <= merge_gap:
                cur.end = max(cur.end, e)
                cur.detail = max(cur.detail, p["rms"])
            else:
                if cur:
                    spans.append(cur)
                cur = Span("audio", "speaker output", t, e, p["rms"])
    if cur:
        spans.append(cur)
    return spans


def intersect(a, b, horizon, tol=0.0):
    s = max(a.start, b.start)
    e = min(a.closed(horizon), b.closed(horizon))
    return (e - s) if e - s > tol else 0.0


def report(name, pairs):
    if not pairs:
        print("PASS  %s: 0 overlaps" % name)
        return True
    print("FAIL  %s: %d overlap(s)" % (name, len(pairs)))
    for a, b, ms in pairs:
        print("        %.0f ms  %r  x  %r" % (ms * 1000, a, b))
    return False


def main(argv=None):
    p = argparse.ArgumentParser(description="Overlap audit of the car's speech queue, mic and speaker output")
    p.add_argument("--logcat", required=True, help="adb logcat -v epoch output")
    p.add_argument("--tap", help="sim_audio_tap.py .jsonl (emulator audio output, host clock)")
    p.add_argument("--offset-ms", type=float, default=0.0, help="device clock minus host clock, ms (tap only)")
    p.add_argument("--from", dest="lo", type=float, default=0.0, help="device epoch seconds")
    p.add_argument("--to", dest="hi", type=float, default=float("inf"))
    p.add_argument("--threshold", type=float, default=30.0, help="tap rms that counts as sound (silence is 0-3)")
    p.add_argument("--latency-ms", type=float, default=700.0, help="check 5: how late sound may trail an utterance")
    p.add_argument("--tol-ms", type=float, default=30.0, help="boundary tolerance for the tap checks (clock alignment)")
    p.add_argument("--quiet", action="store_true", help="no interval listing")
    a = p.parse_args(argv)
    speech, rec_app, os_mic, amp, last = parse_logcat(a.logcat, a.lo, a.hi)
    horizon = min(a.hi, last + 1.0)
    audio = parse_tap(a.tap, a.offset_ms / 1000.0, a.lo, a.hi, a.threshold, 0.12) if a.tap else None

    if not a.quiet:
        print("intervals (device clock, epoch s):")
        rows = [(s.start, s) for s in speech + rec_app + os_mic] + ([(s.start, s) for s in audio] if audio else [])
        for _, s in sorted(rows, key=lambda r: r[0]):
            end = s.closed(horizon)
            extra = (" rms<=%.0f" % s.detail) if s.kind == "audio" else (" " + s.detail if s.detail else "")
            print("  %.3f  %+7.3fs  %-9s %-44s%s" % (s.start, end - s.start, s.kind, s.label[:44], extra[:90]))
        print()

    ok = True
    pairs = []
    for i, x in enumerate(speech):
        for y in speech[i + 1:]:
            ms = intersect(x, y, horizon)
            if ms:
                pairs.append((x, y, ms))
    ok &= report("1 speech x speech (queue)", pairs)

    pairs = []
    for r in rec_app + os_mic:
        for s in speech:
            ms = intersect(s, r, horizon)
            if ms:
                pairs.append((s, r, ms))
    ok &= report("2 speech x recording (queue vs app mic + OS capture)", pairs)

    pairs = [(h, r, intersect(h, r, horizon)) for h in amp for r in os_mic if intersect(h, r, horizon)]
    ok &= report("3 HAL assistant mix x OS capture", pairs)

    if audio is not None:
        tol = a.tol_ms / 1000.0
        pairs = []
        for r in os_mic + rec_app:
            for s in audio:
                ms = intersect(s, r, horizon, tol)
                if ms:
                    pairs.append((s, r, ms))
        ok &= report("4 speaker output x mic open (tap, tolerance %d ms)" % a.tol_ms, pairs)

        lat = a.latency_ms / 1000.0
        orphans = []
        for s in audio:
            # Sound at every moment of s must trail some utterance that was current at most `lat` earlier.
            t = s.start
            while t < s.end:
                owned = any(u.start - tol <= t and t <= u.closed(horizon) + lat for u in speech)
                if not owned:
                    orphans.append((s, Span("none", "no utterance within %d ms" % a.latency_ms, t, t + 0.05), 0.05))
                    break
                t += 0.05
        ok &= report("5 speaker output with no owning utterance (latency %d ms)" % a.latency_ms, orphans)
        on = sum(s.end - s.start for s in audio)
        print("      speaker output: %d spans, %.1f s of sound in the window" % (len(audio), on))
    print("RESULT %s  (%d utterances, %d app recordings, %d OS capture windows, %d HAL mix windows)"
          % ("ZERO OVERLAPS" if ok else "OVERLAPS FOUND", len(speech), len(rec_app), len(os_mic), len(amp)))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
