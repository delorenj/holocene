#!/usr/bin/env bash
set -euo pipefail

VAULT="DeLoSecrets"
ITEM_TITLE="Holocene Android Auto release signing"
OP_BIN="${OP_BIN:-op}"
if [[ -z "${ANDROID_HOME:-}" && -d "$HOME/Android/Sdk" ]]; then
  export ANDROID_HOME="$HOME/Android/Sdk"
fi

if ! command -v "$OP_BIN" >/dev/null 2>&1; then
  echo "1Password CLI (op) is required to resolve the release signing identity." >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to select the keystore attachment." >&2
  exit 1
fi

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/holocene-auto-release.XXXXXX")
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT
keystore="$work_dir/holocene-auto-release.jks"

item_json=$("$OP_BIN" item get "$ITEM_TITLE" --vault "$VAULT" --format json)
key_alias=$(jq -r '.fields[] | select(.label == "key_alias") | .value' <<<"$item_json")
keystore_file_id=$(jq -r '.files[] | select(.name == "keystore") | .id' <<<"$item_json")
if [[ -z "$key_alias" || "$key_alias" == "null" || -z "$keystore_file_id" || "$keystore_file_id" == "null" ]]; then
  echo "Release signing item is missing its key_alias or keystore attachment." >&2
  exit 1
fi

store_password=$("$OP_BIN" read --no-newline "op://$VAULT/$ITEM_TITLE/password")
"$OP_BIN" read --out-file "$keystore" "op://$VAULT/$ITEM_TITLE/keystore"
if [[ -z "$store_password" ]]; then
  echo "Release signing password resolved to an empty value." >&2
  exit 1
fi

export HOLOCENE_AUTO_RELEASE_KEYSTORE="$keystore"
export HOLOCENE_AUTO_RELEASE_KEYSTORE_PASSWORD="$store_password"
export HOLOCENE_AUTO_RELEASE_KEY_ALIAS="$key_alias"
export HOLOCENE_AUTO_RELEASE_KEY_PASSWORD="$store_password"
./gradlew bundleRelease --console=plain

bundle="app/build/outputs/bundle/release/app-release.aab"
echo "AAB=$bundle"
sha256sum "$bundle"
