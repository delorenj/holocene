import argparse
import copy
import hashlib
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
import xml.etree.ElementTree as ET
import zipfile

PACKAGE = "system-images;android-33;Honda-ivi-9inch-LHD"
LICENSE_ID = "honda-ivi-sdk-license"
REQUIRED_PAYLOAD = {
    "x86_64/system.img", "x86_64/ramdisk.img", "x86_64/vendor.img",
    "x86_64/userdata.img", "x86_64/kernel-ranchu", "x86_64/source.properties",
}


def sdk_license_text(text):
    text = re.sub(r"(?<=\s)[ \t]*", "", text, flags=re.ASCII)
    text = re.sub(r"(?<!\n)\n(?!\n)", " ", text)
    text = re.sub(r" +", " ", text)
    return text.strip("".join(chr(value) for value in range(33)))


def package_metadata(feed, package):
    reference = package.find("uses-license").get("ref")
    licenses = [node for node in feed.findall("license") if node.get("id") == reference]
    if reference != LICENSE_ID or len(licenses) != 1 or not licenses[0].text:
        raise SystemExit("Missing or unexpected referenced Honda license")
    license_node = copy.deepcopy(licenses[0])
    license_hash = hashlib.sha1(sdk_license_text(license_node.text).encode("utf-8")).hexdigest()
    repository_ns = "http://schemas.android.com/repository/android/common/01"
    system_ns = "http://schemas.android.com/sdk/android/repo/sys-img2/01"
    xsi = "http://www.w3.org/2001/XMLSchema-instance"
    ET.register_namespace("repo", repository_ns)
    ET.register_namespace("xsi", xsi)
    repository = ET.Element(f"{{{repository_ns}}}repository", {"xmlns:sys-img": system_ns})
    repository.append(license_node)
    local = ET.SubElement(repository, "localPackage", {"path": PACKAGE, "obsolete": "false"})
    details = copy.deepcopy(package.find("type-details"))
    details.set(f"{{{xsi}}}type", "sys-img:sysImgDetailsType")
    local.append(details)
    for tag in ("revision", "display-name", "uses-license"):
        local.append(copy.deepcopy(package.find(tag)))
    ET.indent(repository)
    metadata = ET.tostring(repository, encoding="utf-8", xml_declaration=True).replace(b"\r", b"&#13;")
    serialized_license = ET.fromstring(metadata).find("license").text
    if sdk_license_text(serialized_license) != sdk_license_text(license_node.text):
        raise SystemExit("Serialized license normalization mismatch")
    return metadata, license_hash


def archive_members(archive):
    members = {}
    for member in archive.infolist():
        path = PurePosixPath(member.filename)
        mode = member.external_attr >> 16
        if (path.is_absolute() or ".." in path.parts or "\\" in member.filename
                or not path.parts or path.parts[0] != "x86_64"
                or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR))):
            raise SystemExit("Unsafe archive path or file type")
        name = path.as_posix()
        if name in members or name == "x86_64/package.xml":
            raise SystemExit("Duplicate or conflicting archive metadata")
        if name == "x86_64" and not member.is_dir():
            raise SystemExit("Archive root must be a directory")
        members[name] = member
    if not REQUIRED_PAYLOAD.issubset(members) or any(members[name].file_size == 0 or members[name].is_dir() for name in REQUIRED_PAYLOAD):
        raise SystemExit("Archive lacks complete required Honda payload")
    properties = archive.read(members["x86_64/source.properties"]).decode("utf-8")
    properties = dict(line.split("=", 1) for line in properties.splitlines() if "=" in line)
    if properties.get("AndroidVersion.ApiLevel") != "33" or properties.get("SystemImage.Abi") != "x86_64":
        raise SystemExit("Archive source.properties API/ABI mismatch")
    return members


def verify_payload(destination, archive, members, metadata):
    expected = {name for name, member in members.items() if not member.is_dir()} | {"x86_64/package.xml"}
    actual = set()
    for path in destination.rglob("*"):
        if path.is_symlink() or (not path.is_dir() and not path.is_file()):
            raise SystemExit("Existing payload contains unsupported files")
        if path.is_file():
            actual.add(path.relative_to(destination).as_posix())
    if actual != expected:
        raise SystemExit("Existing payload incomplete or conflicting; refusing changes")
    for name, member in members.items():
        path = destination / name
        if member.is_dir():
            if not path.is_dir():
                raise SystemExit("Existing payload directory missing")
            continue
        if not path.is_file() or path.stat().st_size != member.file_size:
            raise SystemExit("Existing payload size mismatch; refusing changes")
        with path.open("rb") as installed, archive.open(member) as incoming:
            if hashlib.file_digest(installed, "sha256").digest() != hashlib.file_digest(incoming, "sha256").digest():
                raise SystemExit("Existing payload content mismatch; refusing changes")
    if (destination / "x86_64/package.xml").read_bytes() != metadata:
        raise SystemExit("Existing package metadata mismatch; refusing changes")


def reject_symlink_path(path, sdk):
    for current in (path, *path.parents):
        if current == sdk.parent:
            break
        if current.is_symlink() or (current.exists() and current != path and not current.is_dir()):
            raise SystemExit("SDK target path conflicts or contains symlinks")


def install(sdk, feed_path, archive_path):
    sdk = sdk.resolve(strict=True)
    if not sdk.is_dir():
        raise SystemExit("SDK root must be an existing directory")
    feed = ET.parse(feed_path).getroot()
    packages = [node for node in feed.findall("remotePackage") if node.get("path") == PACKAGE]
    if len(packages) != 1:
        raise SystemExit("Expected exactly one Honda candidate package")
    package = packages[0]
    complete = package.find("archives/archive/complete")
    with archive_path.open("rb") as source:
        checksum = hashlib.file_digest(source, "sha1").hexdigest()
    if checksum != complete.findtext("checksum") or archive_path.stat().st_size != int(complete.findtext("size")):
        raise SystemExit("Official feed checksum or size mismatch; refusing installation")
    details = package.find("type-details")
    if details.findtext("abi") != "x86_64" or details.findtext("api-level") != "33":
        raise SystemExit("Unexpected API/ABI")
    metadata, license_hash = package_metadata(feed, package)
    destination = sdk / "system-images/android-33/Honda-ivi-9inch-LHD"
    receipt = sdk / "licenses" / LICENSE_ID
    reject_symlink_path(destination, sdk)
    reject_symlink_path(receipt, sdk)
    if receipt.exists() and not receipt.is_file():
        raise SystemExit("License receipt path is not a regular file")
    previous = receipt.read_bytes() if receipt.exists() else b""
    accepted = license_hash.encode() in previous.splitlines()
    with zipfile.ZipFile(archive_path) as archive:
        members = archive_members(archive)
        if destination.exists():
            if not destination.is_dir():
                raise SystemExit("Existing destination is not a directory")
            verify_payload(destination, archive, members, metadata)
            if not accepted:
                raise SystemExit("Existing license receipt differs; explicit recovery required")
            print(f"Verified existing complete matching installation unchanged: {destination}/x86_64")
            return
        with tempfile.TemporaryDirectory(prefix=".holoc9-image-", dir=sdk.parent) as temporary:
            stage = Path(temporary) / "payload"
            stage.mkdir()
            archive.extractall(stage)
            (stage / "x86_64/package.xml").write_bytes(metadata)
            verify_payload(stage, archive, members, metadata)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists() or destination.is_symlink():
                raise SystemExit("Destination appeared during staging; refusing overwrite")
            stage.rename(destination)
    if not accepted:
        receipt.parent.mkdir(exist_ok=True)
        with receipt.open("ab") as output:
            output.write((b"\n" if previous and not previous.endswith(b"\n") else b"") + license_hash.encode() + b"\n")
    revision = ".".join(package.findtext("revision/" + tag) for tag in ("major", "minor", "micro"))
    print(f"Verified SHA1={checksum}; bytes={archive_path.stat().st_size}; package={PACKAGE}; ABI=x86_64; feed revision={revision}")
    print(f"SDK-normalized referenced Honda license accepted: hash={license_hash}; receipt={receipt}")
    print(f"Installed complete verified payload {destination}/x86_64; official source.properties preserved")


def main():
    parser = argparse.ArgumentParser(description="Install the official Honda API33 9-inch image from its verified archive and feed")
    parser.add_argument("--sdk", type=Path, required=True)
    parser.add_argument("--feed", type=Path, required=True)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--accept-honda-license", action="store_true", required=True)
    args = parser.parse_args()
    install(args.sdk, args.feed, args.archive)


if __name__ == "__main__":
    main()
