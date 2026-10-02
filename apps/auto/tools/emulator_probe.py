import argparse
import json
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

APP = "sh.delo.holocene.auto.feasibility"
ACTIVITY = APP + "/sh.delo.holocene.auto.MainActivity"


def main():
    parser = argparse.ArgumentParser(description="Emulator-only diagnostic UI/microphone smoke probe; no real agent commands")
    parser.add_argument("--adb", required=True)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    if not args.serial.startswith("emulator-"):
        raise SystemExit("Refusing a non-emulator serial")
    evidence = args.evidence.resolve(strict=True)
    transcript = []

    def adb(*command):
        result = subprocess.run([args.adb, "-s", args.serial, *command], capture_output=True, timeout=30)
        if "screencap" not in command:
            transcript.append({"command": list(command), "returncode": result.returncode, "stdout": result.stdout.decode(errors="replace"), "stderr": result.stderr.decode(errors="replace")})
        if result.returncode:
            raise RuntimeError(result.stderr.decode(errors="replace"))
        return result.stdout

    if adb("shell", "getprop", "ro.kernel.qemu").strip() != b"1":
        raise SystemExit("Device is not an emulator")

    def hierarchy(name):
        adb("shell", "uiautomator", "dump", "/sdcard/holoc9-probe.xml")
        local = evidence / (name + ".xml")
        adb("pull", "/sdcard/holoc9-probe.xml", str(local))
        return ET.parse(local).getroot()

    def click(prefix, name):
        root = hierarchy(name)
        for node in root.iter("node"):
            if node.get("package") not in (APP, "com.android.permissioncontroller", "com.google.android.permissioncontroller"):
                continue
            if node.get("text", "").lower().startswith(prefix.lower()):
                coordinates = [int(value) for value in re.findall(r"\d+", node.get("bounds", ""))]
                if len(coordinates) == 4:
                    x1, y1, x2, y2 = coordinates
                    adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))
                    return True
        return False

    try:
        adb("shell", "am", "start", "-W", "-n", ACTIVITY)
        time.sleep(1)
        if not click("Preview canned input", "before-preview"):
            raise RuntimeError("Fixture preview button unavailable")
        hierarchy("fixture-preview")
        if not click("Probe microphone", "before-mic"):
            adb("shell", "input", "swipe", "750", "600", "750", "250", "400")
            if not click("Probe microphone", "before-mic-scrolled"):
                raise RuntimeError("Mic button unavailable under current host UI")
        time.sleep(1)
        permission = hierarchy("mic-permission")
        if any("Allow" in node.get("text", "") or "While using" in node.get("text", "") for node in permission.iter("node")):
            granted = click("While using", "permission-choice") or click("Allow", "permission-choice")
            if not granted:
                raise RuntimeError("Permission dialog requires human diagnostic review")
            time.sleep(1)
            click("Probe microphone", "mic-retry")
        time.sleep(4)
        hierarchy("after-mic")
        if not click("Probe final ASR", "before-asr"):
            raise RuntimeError("ASR diagnostic button unavailable")
        time.sleep(16)
        hierarchy("after-asr")
        if not click("Cancel diagnostic", "before-cancel"):
            raise RuntimeError("Cancel diagnostic button unavailable")
        hierarchy("after-cancel")
        (evidence / "diagnostic-controls.png").write_bytes(adb("exec-out", "screencap", "-p"))
        (evidence / "mic-asr-probe.log").write_bytes(adb("logcat", "-d", "-s", "HoloceneProbe"))
    finally:
        (evidence / "emulator-probe-commands.json").write_text(json.dumps(transcript, indent=2))


if __name__ == "__main__":
    main()
