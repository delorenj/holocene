"""Capture the current AAOS app screen through adb, with runtime provenance.

Does not start capture/ASR, grant permissions, change car state, or manufacture pixels.
Viewport/font settings and navigation are explicit caller actions in the owned emulator.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess

APP = "io.automaticai.holocene"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adb", required=True)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--label", required=True)
    parser.add_argument("--apk", required=True, type=Path)
    parser.add_argument("--include-system-dialog", action="store_true", help="Record an explicit OS dialog over the app; not unobscured UI acceptance proof")
    args = parser.parse_args()
    if not re.fullmatch(r"emulator-\d+", args.serial):
        raise SystemExit("Only a worker-owned emulator is supported")
    if not re.fullmatch(r"[a-z0-9-]+", args.label):
        raise SystemExit("Use a portable capture label")
    args.evidence.mkdir(parents=True, exist_ok=True)
    record = {
        "captured_at_utc": datetime.now(timezone.utc).isoformat(),
        "serial": args.serial,
        "package": APP,
        "system_dialog_expected": args.include_system_dialog,
        "apk_sha256": hashlib.sha256(args.apk.read_bytes()).hexdigest(),
        "kind": "adb exec-out screencap; authentic runtime pixels; debug APK only",
        "commands": [],
    }
    image = args.evidence / (args.label + ".png")
    provenance = args.evidence / (args.label + ".json")
    if image.exists() or provenance.exists():
        raise SystemExit("Refusing to overwrite existing evidence")

    def adb(*command, binary=False):
        entry = {"argv": list(command)}
        record["commands"].append(entry)
        provenance.write_text(json.dumps(record, indent=2))
        try:
            result = subprocess.run([args.adb, "-s", args.serial, *command], capture_output=True, timeout=25)
        except subprocess.TimeoutExpired:
            entry["error"] = "25-second adb timeout"
            raise
        entry["returncode"] = result.returncode
        entry["stderr"] = result.stderr.decode(errors="replace")
        if not binary:
            entry["stdout"] = result.stdout.decode(errors="replace")
        if result.returncode:
            raise RuntimeError(entry["stderr"])
        return result.stdout

    try:
        if adb("shell", "getprop", "ro.kernel.qemu").strip() != b"1":
            raise SystemExit("Runtime is not an emulator")
        if adb("shell", "pm", "has-feature", "android.hardware.type.automotive").strip() != b"true":
            raise SystemExit("Runtime is not Android Automotive")
        installed = adb("shell", "pm", "path", "--user", "current", APP).decode().strip().splitlines()
        base = next((line.removeprefix("package:") for line in installed if line.endswith("/base.apk")), "")
        if not re.fullmatch(r"/data/app/[A-Za-z0-9/_.=+~\-]+/base\.apk", base):
            raise RuntimeError("Installed base APK path unavailable; no identity proof")
        record["installed_apk_sha256"] = adb("shell", "sha256sum", base).decode().split()[0]
        if record["installed_apk_sha256"] != record["apk_sha256"]:
            raise RuntimeError("Installed APK differs from the artifact; no capture recorded")
        package = adb("shell", "dumpsys", "package", APP).decode()
        version = re.search(r"versionCode=(\d+).*", package)
        name = re.search(r"versionName=(.+)", package)
        record["versionCode"] = int(version[1]) if version else None
        record["versionName"] = name[1].strip() if name else None
        for key, command in {
            "viewport": ("shell", "wm", "size"),
            "density": ("shell", "wm", "density"),
            "font_scale": ("shell", "settings", "--user", "current", "get", "system", "font_scale"),
            "foreground_user": ("shell", "am", "get-current-user"),
            "sdk": ("shell", "getprop", "ro.build.version.sdk"),
            "build_fingerprint": ("shell", "getprop", "ro.build.fingerprint"),
            "window_and_insets": ("shell", "dumpsys", "window", "windows"),
            "foreground_activity": ("shell", "dumpsys", "activity", "activities"),
        }.items():
            record[key] = adb(*command).decode(errors="replace")
        if not args.include_system_dialog and not re.search(r"(?:mResumedActivity|topResumedActivity)[=:].*" + re.escape(APP), record["foreground_activity"]):
            raise SystemExit("Holocene is not the resumed activity")
        png = adb("exec-out", "screencap", "-p", binary=True)
        if png[:8] != b"\x89PNG\r\n\x1a\n":
            raise RuntimeError("adb did not return a PNG; no image recorded")
        record["png_dimensions"] = [int.from_bytes(png[16:20], "big"), int.from_bytes(png[20:24], "big")]
        record["png_sha256"] = hashlib.sha256(png).hexdigest()
        image.write_bytes(png)
        record["status"] = "CAPTURED"
        print(str(image))
    except BaseException as error:
        record["status"] = "BLOCKED"
        record["error"] = str(error)
        raise
    finally:
        provenance.write_text(json.dumps(record, indent=2))


if __name__ == "__main__":
    main()
