#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/27.1.12297006}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
build_cpus="${SUPERMD_BUILD_CPUS:-$(awk '/Cpus_allowed_list/ {print $2}' /proc/self/status)}"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android26-clang"
export CC_aarch64_linux_android="$CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER"
export AR_aarch64_linux_android="$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-ar"
# One build at a time. Scope the lock to this project, never kill unrelated work.
exec 9>android/.build.lock
flock -n 9 || { echo "An Android build is already running for this project." >&2; exit 1; }
nice -n 10 taskset -c "$build_cpus" npm run build
nice -n 10 taskset -c "$build_cpus" cargo rustc --locked --release --target aarch64-linux-android --manifest-path smd-core/Cargo.toml --lib -- -C link-arg=-Wl,-z,max-page-size=16384
mkdir -p android/app/src/main/jniLibs/arm64-v8a android/app/src/main/assets/web
cp smd-core/target/aarch64-linux-android/release/libsmd_core.so android/app/src/main/jniLibs/arm64-v8a/
rsync -a --delete dist/ android/app/src/main/assets/web/
node --input-type=module <<'NODE'
import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
writeFileSync('android/app/src/main/assets/web/build-info.json', JSON.stringify({ version: JSON.parse(readFileSync('package.json')).version, commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0 }));
NODE
cd android
./gradlew --stop
nice -n 10 taskset -c "$build_cpus" ./gradlew --no-daemon --max-workers=2 :app:testDebugUnitTest :app:lintRelease :app:assembleRelease
