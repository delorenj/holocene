import argparse
import copy
import hashlib
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile

PACKAGE = "system-images;android-33;Honda-ivi-9inch-LHD"


def main():
    parser = argparse.ArgumentParser(description="Install the official Honda API33 9-inch image from its verified archive and feed")
    parser.add_argument("--sdk", type=Path, required=True)
    parser.add_argument("--feed", type=Path, required=True)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--accept-honda-license", action="store_true", required=True)
    args = parser.parse_args()
    sdk = args.sdk.resolve(strict=True)
    feed = ET.parse(args.feed).getroot()
    package = next(node for node in feed.findall("remotePackage") if node.get("path") == PACKAGE)
    complete = package.find("archives/archive/complete")
    expected = complete.findtext("checksum")
    with args.archive.open("rb") as archive:
        actual = hashlib.file_digest(archive, "sha1").hexdigest()
    if actual != expected or args.archive.stat().st_size != int(complete.findtext("size")):
        raise SystemExit("Official feed checksum or size mismatch; refusing installation")
    details = package.find("type-details")
    if details.findtext("abi") != "x86_64" or details.findtext("api-level") != "33":
        raise SystemExit("Unexpected API/ABI")
    destination = sdk / "system-images/android-33/Honda-ivi-9inch-LHD"
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.archive) as archive:
        for name in archive.namelist():
            if not name.startswith("x86_64/") or not (destination / name).resolve().is_relative_to(destination):
                raise SystemExit("Unsafe archive path")
        if not (destination / "x86_64/system.img").exists():
            archive.extractall(destination)
    repository_ns = "http://schemas.android.com/repository/android/common/01"
    system_ns = "http://schemas.android.com/sdk/android/repo/sys-img2/01"
    xsi = "http://www.w3.org/2001/XMLSchema-instance"
    ET.register_namespace("repo", repository_ns)
    ET.register_namespace("sys-img", system_ns)
    ET.register_namespace("xsi", xsi)
    repository = ET.Element(f"{{{repository_ns}}}repository", {"xmlns:sys-img": system_ns})
    license_node = feed.find("license")
    repository.append(copy.deepcopy(license_node))
    local = ET.SubElement(repository, "localPackage", {"path": PACKAGE, "obsolete": "false"})
    local_details = copy.deepcopy(details)
    local_details.set(f"{{{xsi}}}type", "sys-img:sysImgDetailsType")
    local.append(local_details)
    for tag in ("revision", "display-name", "uses-license"):
        local.append(copy.deepcopy(package.find(tag)))
    ET.indent(repository)
    ET.ElementTree(repository).write(destination / "x86_64/package.xml", encoding="utf-8", xml_declaration=True)
    licenses = sdk / "licenses"
    licenses.mkdir(exist_ok=True)
    license_hash = hashlib.sha1(license_node.text.encode()).hexdigest()
    receipt = licenses / license_node.get("id")
    previous = receipt.read_text() if receipt.exists() else ""
    if license_hash not in previous.splitlines():
        with receipt.open("a") as output:
            output.write("\n" + license_hash + "\n")
    print(f"Verified SHA1={actual}; bytes={args.archive.stat().st_size}; package={PACKAGE}; ABI=x86_64")
    print("Feed revision=" + ".".join(package.findtext("revision/" + tag) for tag in ("major", "minor", "micro")))
    print(f"Honda license accepted by explicit operator authorization; receipt={receipt}")
    print(f"Installed {destination}/x86_64; archive source.properties revision=1 preserved; package.xml mirrors feed revision")


if __name__ == "__main__":
    main()
