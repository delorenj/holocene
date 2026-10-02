import contextlib
import copy
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
import zipfile

TOOLS = Path(__file__).resolve().parents[1]
AUTO = TOOLS.parent
SPEC = importlib.util.spec_from_file_location("honda_installer", TOOLS / "install_honda_image.py")
INSTALLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALLER)
PIN = "f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6"


def snapshot(root):
    return sorted((str(path.relative_to(root)), path.lstat().st_mode, path.lstat().st_mtime_ns,
                   os.readlink(path) if path.is_symlink() else path.read_bytes() if path.is_file() else None)
                  for path in root.rglob("*"))


def java_path():
    home = os.environ.get("JAVA_HOME")
    java = Path(home) / "bin/java" if home else Path(shutil.which("java") or "/missing-java")
    return str(java)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="holoc9-tool-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.sdk = self.root / "sdk"
        self.sdk.mkdir()
        self.archive = self.root / "image.zip"
        self.feed_path = self.root / "feed.xml"
        self.payload = {name: (name + " verified").encode() for name in INSTALLER.REQUIRED_PAYLOAD}
        self.payload["x86_64/source.properties"] = b"AndroidVersion.ApiLevel=33\nSystemImage.Abi=x86_64\nPkg.Revision=1\n"
        self.payload["x86_64/data/example.txt"] = b"non-required but verified"
        self.feed = ET.fromstring('''<repository xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<license id="unrelated-license" type="text">Never accept this license</license>
<license id="honda-ivi-sdk-license" type="text">  Honda terms\n   line two.&#13;\n\nNext paragraph.  </license>
<remotePackage path="system-images;android-33;Honda-ivi-9inch-LHD">
<type-details xsi:type="sys-img:sysImgDetailsType"><api-level>33</api-level><tag><id>android-automotive</id><display>Honda</display></tag><vendor><id>honda_ivi</id><display>Honda</display></vendor><abi>x86_64</abi></type-details>
<revision><major>25</major><minor>3</minor><micro>120114</micro></revision>
<display-name>Honda 9-inch</display-name><uses-license ref="honda-ivi-sdk-license"/>
<archives><archive><complete><size>0</size><checksum>0</checksum><url>fixture.zip</url></complete></archive></archives>
</remotePackage></repository>''')
        self.target = self.sdk / "system-images/android-33/Honda-ivi-9inch-LHD"
        self.rebuild()

    def rebuild(self, extra=None):
        with zipfile.ZipFile(self.archive, "w") as archive:
            for name, content in self.payload.items():
                archive.writestr(name, content)
            if extra:
                archive.writestr(*extra)
        complete = self.feed.find("remotePackage/archives/archive/complete")
        complete.find("size").text = str(self.archive.stat().st_size)
        complete.find("checksum").text = hashlib.sha1(self.archive.read_bytes()).hexdigest()
        self.save_feed()

    def save_feed(self):
        self.feed_path.write_bytes(ET.tostring(self.feed).replace(b"\r", b"&#13;"))

    def install(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            INSTALLER.install(self.sdk, self.feed_path, self.archive)
        return output.getvalue()

    def refuses_unchanged(self):
        before = snapshot(self.sdk)
        with self.assertRaises(SystemExit):
            self.install()
        self.assertEqual(before, snapshot(self.sdk))

    def test_fresh_complete_payload_and_selected_license(self):
        self.assertIn("Installed complete verified", self.install())
        for name, content in self.payload.items():
            self.assertEqual(content, (self.target / name).read_bytes())
        metadata = ET.parse(self.target / "x86_64/package.xml").getroot()
        self.assertEqual("honda-ivi-sdk-license", metadata.find("license").get("id"))
        self.assertFalse((self.sdk / "licenses/unrelated-license").exists())
        self.assertEqual("120114", metadata.findtext("localPackage/revision/micro"))

    def test_fully_matching_rerun_changes_nothing(self):
        self.install()
        before = snapshot(self.sdk)
        self.assertIn("unchanged", self.install())
        self.assertEqual(before, snapshot(self.sdk))

    def test_partial_system_image_refused_without_metadata_or_receipt(self):
        (self.target / "x86_64").mkdir(parents=True)
        (self.target / "x86_64/system.img").write_bytes(b"partial-system")
        self.refuses_unchanged()

    def test_existing_ramdisk_is_not_overwritten(self):
        (self.target / "x86_64").mkdir(parents=True)
        (self.target / "x86_64/ramdisk.img").write_bytes(b"operator-existing-ramdisk")
        self.refuses_unchanged()

    def test_complete_content_conflict_refused(self):
        self.install()
        path = self.target / "x86_64/data/example.txt"
        path.write_bytes(b"x" * len(path.read_bytes()))
        self.refuses_unchanged()

    def test_stale_metadata_refused(self):
        self.install()
        (self.target / "x86_64/package.xml").write_bytes(b"old revision")
        self.refuses_unchanged()

    def test_staging_failure_leaves_sdk_unchanged(self):
        before = snapshot(self.sdk)
        with patch.object(zipfile.ZipFile, "extractall", side_effect=OSError("interrupted extraction")):
            with self.assertRaises(OSError):
                self.install()
        self.assertEqual(before, snapshot(self.sdk))
        self.assertFalse(list(self.root.glob(".holoc9-image-*")))

    def test_checksum_mismatch_precedes_sdk_mutation(self):
        self.feed.find("remotePackage/archives/archive/complete/checksum").text = "0" * 40
        self.save_feed()
        self.refuses_unchanged()

    def test_traversal_precedes_sdk_mutation(self):
        self.rebuild(("x86_64/../../escaped", b"bad"))
        self.refuses_unchanged()

    def test_archive_symlink_precedes_sdk_mutation(self):
        member = zipfile.ZipInfo("x86_64/link")
        member.create_system = 3
        member.external_attr = (stat.S_IFLNK | 0o777) << 16
        self.rebuild((member, b"/outside"))
        self.refuses_unchanged()

    def test_incomplete_archive_precedes_sdk_mutation(self):
        self.payload.pop("x86_64/vendor.img")
        self.rebuild()
        self.refuses_unchanged()

    def test_destination_symlink_refused(self):
        self.target.parent.mkdir(parents=True)
        self.target.symlink_to(self.root, target_is_directory=True)
        self.refuses_unchanged()

    def test_missing_referenced_license_refused(self):
        self.feed.find("remotePackage/uses-license").set("ref", "unrelated-license")
        self.save_feed()
        self.refuses_unchanged()

    def test_existing_receipt_preserved_with_other_hash(self):
        receipt = self.sdk / "licenses/honda-ivi-sdk-license"
        receipt.parent.mkdir()
        receipt.write_bytes(b"operator-receipt")
        self.install()
        self.assertTrue(receipt.read_bytes().startswith(b"operator-receipt\n"))
        self.assertEqual(2, len(receipt.read_bytes().splitlines()))

    def test_existing_payload_missing_receipt_refused(self):
        self.install()
        (self.sdk / "licenses/honda-ivi-sdk-license").unlink()
        self.refuses_unchanged()

    def test_license_acceptance_flag_required(self):
        before = snapshot(self.sdk)
        result = subprocess.run([sys.executable, str(TOOLS / "install_honda_image.py"), "--sdk", str(self.sdk), "--feed", str(self.feed_path), "--archive", str(self.archive)], capture_output=True, timeout=10)
        self.assertNotEqual(0, result.returncode)
        self.assertIn(b"--accept-honda-license", result.stderr)
        self.assertEqual(before, snapshot(self.sdk))

    def sdk_check(self, feed=None):
        sdk = Path(os.environ.get("ANDROID_HOME", Path.home() / "Android/Sdk"))
        classpath = sdk / "cmdline-tools/latest/lib/avdmanager-classpath.jar"
        self.assertTrue(classpath.is_file(), "Installed SDK command-line-tools required for JAXB regression")
        if feed is not None:
            self.feed = feed
            self.save_feed()
        self.install()
        metadata = self.target / "x86_64/package.xml"
        receipt_hash = (self.sdk / "licenses/honda-ivi-sdk-license").read_text().strip()
        before = snapshot(self.sdk)
        for xml in (self.feed_path, metadata):
            result = subprocess.run([java_path(), "--class-path", str(classpath), str(TOOLS / "tests/SdkLicenseCheck.java"), str(xml), str(self.sdk), receipt_hash], capture_output=True, text=True, timeout=30)
            self.assertEqual(0, result.returncode, result.stdout + result.stderr)
            self.assertIn("checkAccepted=true", result.stdout)
            print(result.stdout.strip())
        self.assertEqual(before, snapshot(self.sdk))

    def test_sdk_jaxb_accepts_selected_serialized_license_read_only(self):
        self.sdk_check()

    def test_sdk_jaxb_accepts_actual_honda_legal_text(self):
        feed_path = os.environ.get("HOLOCENE_HONDA_FEED")
        if not feed_path:
            self.skipTest("Set HOLOCENE_HONDA_FEED for actual Honda legal-text regression")
        official = ET.parse(feed_path).getroot()
        feed = copy.deepcopy(self.feed)
        selected = next(node for node in official.findall("license") if node.get("id") == INSTALLER.LICENSE_ID)
        feed.remove(next(node for node in feed.findall("license") if node.get("id") == INSTALLER.LICENSE_ID))
        feed.append(copy.deepcopy(selected))
        self.sdk_check(feed)


class WrapperTests(unittest.TestCase):
    def properties(self):
        return dict(line.split("=", 1) for line in (AUTO / "gradle/wrapper/gradle-wrapper.properties").read_text().splitlines() if "=" in line)

    def test_distribution_pin_has_exact_sha256_length_and_value(self):
        pin = self.properties()["distributionSha256Sum"]
        self.assertRegex(pin, r"\A[0-9a-f]{64}\Z")
        self.assertEqual(PIN, pin)

    def test_cold_wrapper_starts_from_official_zip_in_isolated_home(self):
        archive = os.environ.get("HOLOCENE_GRADLE_ZIP")
        if not archive:
            self.skipTest("Set HOLOCENE_GRADLE_ZIP for isolated offline cold wrapper start")
        archive = Path(archive).resolve(strict=True)
        with tempfile.TemporaryDirectory(prefix="holoc9-cold-wrapper-") as temporary:
            root = Path(temporary)
            wrapper = root / "gradle/wrapper"
            wrapper.mkdir(parents=True)
            shutil.copy2(AUTO / "gradle/wrapper/gradle-wrapper.jar", wrapper / "gradle-wrapper.jar")
            properties = (AUTO / "gradle/wrapper/gradle-wrapper.properties").read_text()
            properties = re.sub(r"(?m)^distributionUrl=.*$", "distributionUrl=" + archive.as_uri(), properties)
            (wrapper / "gradle-wrapper.properties").write_text(properties)
            environment = dict(os.environ, GRADLE_USER_HOME=str(root / "isolated-home"))
            result = subprocess.run([java_path(), "-classpath", str(wrapper / "gradle-wrapper.jar"), "org.gradle.wrapper.GradleWrapperMain", "--version"], cwd=root, env=environment, capture_output=True, text=True, timeout=120)
            self.assertEqual(0, result.returncode, result.stdout + result.stderr)
            self.assertIn("Gradle 8.11.1", result.stdout)
            self.assertTrue(list((root / "isolated-home").rglob("*.zip.ok")))
            print("Cold wrapper isolated-home official ZIP integrity/start: PASS")

    def test_official_zip_passes_exact_wrapper_verifier_without_cache(self):
        archive = os.environ.get("HOLOCENE_GRADLE_ZIP")
        if not archive:
            self.skipTest("Set HOLOCENE_GRADLE_ZIP to an existing official ZIP for cold-integrity regression")
        with Path(archive).open("rb") as source:
            self.assertEqual(PIN, hashlib.file_digest(source, "sha256").hexdigest())
        result = subprocess.run([java_path(), "--class-path", str(AUTO / "gradle/wrapper/gradle-wrapper.jar"), str(TOOLS / "tests/WrapperChecksumCheck.java"), str(AUTO / "gradle/wrapper/gradle-wrapper.properties"), archive], capture_output=True, text=True, timeout=30)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn("Install.verifyDownloadChecksum passed", result.stdout)
        print(result.stdout.strip())


if __name__ == "__main__":
    unittest.main()
