#!/usr/bin/env python3
"""Is the Honda simulator's microphone actually delivering sound? (mise run auto:sim:mic-check)

Runs the app's diagnostic mic probe (a 6 s AudioRecord capture that logs rms/peak as HoloceneProbe
mic_result), looks at the host's PulseAudio/PipeWire capture streams owned by qemu while the guest is
recording, and prints one verdict:

  OK (rms 142.7 peak 707)
  SILENT: emulator audio stream stuck (2 corked qemu streams) -> run: mise run auto:sim:stop && mise run auto:sim
  SILENT: host mic passthrough is off ...
  SILENT: host microphone is muted ...

Why: on 2026-10-16 a memo recorded on the simulator was digital silence (peak -73 dB) because the
emulator's capture stream was stuck CORKED; the pipeline only said "empty_transcript" 40 s later.
A qemu stream is corked while the guest is NOT recording, so the state is only meaningful sampled
during the probe, which is what this does.

Exit: 0 OK, 1 SILENT, 2 inconclusive (probe did not run).
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import time

APP_ID = "io.automaticai.holocene"
APP_ACTIVITY = "sh.delo.holocene.auto.MainActivity"
EXTRA_RUN_MIC = "sh.delo.holocene.extra.RUN_MIC"
SERIAL = "emulator-5554"
ADB = os.path.join(os.environ.get("ANDROID_HOME", os.path.expanduser("~/Android/Sdk")), "platform-tools", "adb")
# Same line the Agent Pad and the inbox watcher use: a peak under -60 dBFS heard nothing.
SILENCE_DBFS = -60.0
SILENCE_PEAK = 32768 * 10 ** (SILENCE_DBFS / 20)  # ~32.8 of 32768
RESTART = "mise run auto:sim:stop && mise run auto:sim"


def parse_source_outputs(text):
    """Streams from `pactl list source-outputs`: [{id, binary, name, corked}]."""
    streams = []
    for block in re.split(r"\n(?=Source Output #)", text.strip()):
        m = re.match(r"Source Output #(\d+)", block)
        if not m:
            continue
        corked = re.search(r"^\s*Corked:\s*(\w+)", block, re.M)
        binary = re.search(r'application\.process\.binary = "([^"]*)"', block)
        name = re.search(r'application\.name = "([^"]*)"', block)
        streams.append({
            "id": int(m.group(1)),
            "binary": binary.group(1) if binary else "",
            "name": name.group(1) if name else "",
            "corked": bool(corked and corked.group(1).lower() == "yes"),
        })
    return streams


def qemu_streams(streams):
    return [s for s in streams if "qemu" in (s["binary"] + " " + s["name"]).lower()]


def parse_mic_result(logcat):
    """(rms, peak, read_error, samples) from the last HoloceneProbe mic_result line, or None."""
    found = None
    for line in logcat.splitlines():
        if "event=mic_result " not in line and not line.rstrip().endswith("event=mic_result"):
            continue
        rms = re.search(r"\brms=([0-9.]+)", line)
        peak = re.search(r"\bpeak=(\d+)", line)
        err = re.search(r"\breadError=(-?\d+)", line)
        samples = re.search(r"\bsamples=(\d+)", line)
        if rms and peak:
            found = (float(rms.group(1)), int(peak.group(1)), int(err.group(1)) if err else 0, int(samples.group(1)) if samples else 0)
    return found


LOG = os.path.expanduser("~/.local/state/holocene-auto/emulator.log")


def audio_problem(log_text, cmdlines):
    """Why the running emulator can never capture host audio, or None.

    Seen 2026-10-16: an emulator started from a shell without the desktop's X/Pulse environment prints
    "Could not init `pa' audio driver" (guest mic = exact zeros, no qemu stream, and `hostmicon` changes nothing),
    or falls back to the -headless binary ("Authorization required, but no authorization protocol specified").
    log_text is the whole emulator.log (only the newest start counts); cmdlines are the process command lines."""
    for line in cmdlines:
        if "qemu-system-x86_64-headless" in line or " -no-audio" in line or " -no-window" in line:
            return "the emulator runs headless / without audio (started from a shell with no desktop display)"
    start = log_text.rfind("Android emulator version")
    if "Could not init `pa' audio driver" in log_text[max(start, 0):]:
        return "the emulator could not reach PulseAudio when it started (no XDG_RUNTIME_DIR / PULSE_SERVER in its shell)"
    return None


def verdict(result, streams, host_muted=None, problem=None):
    """(exit_code, text). result is parse_mic_result(); streams is the qemu list sampled during the probe or None if unknown.
    problem is audio_problem(): an emulator that has no host audio at all, which no passthrough toggle fixes."""
    if result is None:
        return 2, "INCONCLUSIVE: the app's mic probe did not report a result (app not installed, mic permission, or host restricted); run: mise run auto:dev --grant-mic"
    rms, peak, read_error, _samples = result
    if read_error < 0:
        return 1, f"SILENT: AudioRecord read failed (readError={read_error}); the guest mic is not capturing -> {RESTART}"
    if peak >= SILENCE_PEAK:
        return 0, f"OK (rms {rms:.1f} peak {peak})"
    detail = f"rms {rms:.1f} peak {peak}"
    if streams is None:
        return 1, f"SILENT ({detail}): pactl is unavailable so the cause is unknown. Try: {RESTART}"
    corked = [s for s in streams if s["corked"]]
    live = [s for s in streams if not s["corked"]]
    if corked and not live:
        return 1, (f"SILENT ({detail}): emulator audio stream stuck ({len(corked)} corked qemu stream{'s' if len(corked) != 1 else ''})"
                   f" -> run {RESTART}")
    if problem and not live:
        return 1, f"SILENT ({detail}): {problem}; hostmicon cannot fix that -> start it from a desktop terminal: {RESTART}"
    if not streams:
        return 1, (f"SILENT ({detail}): host mic passthrough is off (no qemu capture stream while the guest records)"
                   " -> run: adb -s emulator-5554 emu avd hostmicon (headless/-no-audio runs never capture)")
    if host_muted:
        return 1, f"SILENT ({detail}): the host default microphone is muted (pactl set-source-mute @DEFAULT_SOURCE@ 0)"
    extra = f"; {len(corked)} leaked corked stream(s) are also present, restart clears them: {RESTART}" if corked else ""
    return 1, f"SILENT ({detail}): the qemu stream is live but delivers silence: host mic quiet, wrong default source (pactl get-default-source) or unplugged{extra}"


def run(cmd, timeout=15):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def adb(*args, timeout=15):
    return run([ADB, "-s", SERIAL, *args], timeout)


def emulator_audio_problem():
    try:
        with open(LOG, errors="replace") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - 2_000_000))  # the newest start is near the end; the log is appended forever
            text = fh.read()
    except OSError:
        text = ""
    cmdlines = [ln for ln in run(["ps", "-eo", "args"]).splitlines() if "qemu-system-x86_64" in ln and "-avd" in ln]
    return audio_problem(text, cmdlines)


def sample_streams():
    if not shutil.which("pactl"):
        return None
    out = run(["pactl", "list", "source-outputs"])
    return qemu_streams(parse_source_outputs(out)) if out is not None else None


def host_source_muted():
    if not shutil.which("pactl"):
        return None
    out = run(["pactl", "get-source-mute", "@DEFAULT_SOURCE@"]).strip().lower()
    return out.endswith("yes") if out else None


def dismiss_honda_dialog():
    """Tick "Do not show this again" and tap Cancel on the head unit's "Connect the Device" dialog (1280x720 layout)."""
    time.sleep(1.5)  # the dialog reappears a moment after each app start
    adb("shell", "input", "tap", "550", "360")  # "Do not show this again"
    time.sleep(0.5)
    adb("shell", "input", "tap", "453", "459")  # Cancel
    time.sleep(1)


def probe_once(log=print):
    """Run the in-app mic probe; returns (mic_result or None, qemu streams sampled while it records, refused).

    blocked is "focus" when the guest denied audio focus (seen right after a cold boot, before the car audio
    service settles) or "covered" when something paused the app mid-probe (the Honda "Connect the Device"
    dialog covers it after boot): the probe never recorded, so the caller dismisses/waits and tries again.
    """
    user = (adb("shell", "am", "get-current-user").strip() or "10")
    if not user.isdigit():
        user = "10"
    adb("shell", "pm", "grant", "--user", user, APP_ID, "android.permission.RECORD_AUDIO")
    adb("logcat", "-c")
    # Plain force-stop on purpose. Sending the app HOME first (to let Chromium flush) raises the Honda "Connect the
    # Device" dialog over it and the probe never records. The pad's own state no longer needs a graceful exit: its
    # last-played-reply marker is kept natively (PadPrefs), because the WebView's localStorage does not survive any
    # cold start.
    adb("shell", "am", "force-stop", "--user", user, APP_ID)
    adb("shell", "am", "start", "--user", user, "-n", f"{APP_ID}/{APP_ACTIVITY}", "--ez", EXTRA_RUN_MIC, "true")
    log("mic probe running (about 10 s)...")
    streams = None
    sampled = False
    begin = time.time()
    started_at = None
    result = None
    blocked = None
    # A cold-booted sim can take 15+ s before the app even schedules the probe: wait up to 45 s for it to
    # start, then up to 10 s for its 6 s capture to report.
    while time.time() < (started_at + 10 if started_at else begin + 45):
        time.sleep(0.5)
        logs = adb("logcat", "-d", "-s", "HoloceneProbe:I")
        if started_at is None and "event=mic_started" in logs:
            started_at = time.time()
        # sample the host side ~2.5 s into the guest recording, when a healthy qemu stream is surely running
        if started_at and not sampled and time.time() - started_at >= 2.5:
            streams = sample_streams()
            sampled = True
        result = parse_mic_result(logs)
        if result:
            break
        if "source=focus-denied" in logs:
            blocked = "focus"
            break
        if "source=pause" in logs:
            blocked = "covered"
            break
    # leave the app in its normal state rather than on the probe screen
    adb("shell", "am", "force-stop", "--user", user, APP_ID)
    adb("shell", "am", "start", "--user", user, "-n", f"{APP_ID}/{APP_ACTIVITY}")
    return result, streams, blocked


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--no-fix", action="store_true", help="do not turn host mic passthrough on and retry when it was off")
    args = ap.parse_args(argv)
    if "device" not in run([ADB, "-s", SERIAL, "get-state"]):
        print(f"{SERIAL} is not running. Run: mise run auto:sim", file=sys.stderr)
        return 2
    if f"package:{APP_ID}" not in run([ADB, "-s", SERIAL, "shell", "pm", "list", "packages", APP_ID]):
        print(f"INCONCLUSIVE: {APP_ID} is not installed on {SERIAL}; run: mise run auto:dev --grant-mic")
        return 2
    result, streams, blocked = probe_once()
    for _ in range(3):  # the car audio service may still be settling, or the Honda dialog covers the app
        if not blocked:
            break
        if blocked == "covered":
            print("something covers the app (Honda 'Connect the Device' dialog?); tapping Cancel and retrying...")
            dismiss_honda_dialog()
        else:
            print("guest denied audio focus (still booting?); retrying in 4 s...")
            time.sleep(4)
        result, streams, blocked = probe_once()
    problem = emulator_audio_problem()
    code, text = verdict(result, streams, host_source_muted(), problem)
    if code == 1 and streams == [] and not args.no_fix and not problem:
        # No qemu capture stream at all: passthrough is off. Turn it on and look once more.
        adb("emu", "avd", "hostmicon")
        time.sleep(1)
        result2, streams2, _ = probe_once()
        code2, text2 = verdict(result2, streams2, host_source_muted())
        if code2 == 0:
            print(f"{text2}  [host mic passthrough was OFF; turned it on]")
            return 0
        text = text2 if streams2 else text
    print(text)
    return code


if __name__ == "__main__":
    sys.exit(main())
