#!/usr/bin/env bash
set -euo pipefail
apk_path="$1"
release_version="$2"
release_commit="$3"
sdk_tools="${ANDROID_HOME:?Set ANDROID_HOME}/build-tools/36.0.0"
expected_certificate="${ANDROID_CERT_SHA256:?Set the existing upgrade certificate fingerprint}"
"$sdk_tools/zipalign" -c -P 16 4 "$apk_path"
apk_signatures="$("$sdk_tools/apksigner" verify --print-certs "$apk_path")"
actual_certificate="$(printf '%s\n' "$apk_signatures" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p')"
for signature_range in 'v1:23:23' 'v2:26:27' 'v3:28:36'; do
  IFS=: read -r scheme minimum maximum <<< "$signature_range"
  verification="$("$sdk_tools/apksigner" verify --verbose --min-sdk-version "$minimum" --max-sdk-version "$maximum" "$apk_path")"
  if ! printf '%s\n' "$verification" | grep -Eq "Verified using $scheme scheme .*: true"; then echo "Missing $scheme signature" >&2; exit 1; fi
done
if [ "${actual_certificate,,}" != "${expected_certificate,,}" ]; then echo 'APK upgrade certificate mismatch' >&2; exit 1; fi
apk_badging="$("$sdk_tools/aapt" dump badging "$apk_path")"
if [[ "$apk_badging" == *application-debuggable* ]]; then echo 'Refusing a debuggable APK' >&2; exit 1; fi
if [[ "$apk_badging" != *"name='dev.supermd.studio'"* || "$apk_badging" != *"versionName='$release_version'"* || "$apk_badging" != *"native-code: 'arm64-v8a'"* ]]; then echo 'APK identity/version/ABI mismatch' >&2; exit 1; fi
apk_metadata="$(unzip -p "$apk_path" assets/web/build-info.json)"
node - "$apk_metadata" "$release_version" "$release_commit" <<'NODE'
const [raw, version, commit] = process.argv.slice(2);
const metadata = JSON.parse(raw);
if (metadata.version !== version || metadata.commit !== commit || metadata.dirty !== false) throw Error('APK was not built from the clean tagged source');
NODE
echo 'Verified signed, non-debuggable, 16-KB-aligned arm64 release APK'
