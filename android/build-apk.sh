#!/bin/bash
# 本机构建 APK 的一键脚本（受限环境：进程地址空间硬上限 4GB）
#
# 用法：
#   ./build-apk.sh            构建 debug APK（可直接安装，使用 ~/.android/debug.keystore 签名）
#
# 前置：
#   ~/toolchain/jdk-21.0.13+9        JDK 21
#   ~/toolchain/android-sdk          platforms/android-35 + build-tools/35.0.0
#
# 关键点（踩过的坑，别改）：
#   1. MALLOC_ARENA_MAX=2 —— glibc 每线程 arena 预留 64MB 虚拟地址，构建期上百线程，
#      不压住会白白吃掉 1GB+ 地址空间，进而 metaspace 预留失败。
#   2. 堆不能太大也不能太小：Xmx1536m 实测 VmPeak≈2.0GB，留 2GB 余量给 mmap 的 jar。
#   3. ANDROID_USER_HOME 必须指向可写目录：本机 /root 属于 nobody，AGP 建 debug.keystore
#      时会报 "Cannot create directory /root/.android"。
#   4. build-tools 统一钉死 35.0.0（见 ~/.gradle/init.gradle）：各插件模块自带 AGP 版本
#      不一，默认会去要 34.0.0 并尝试联网下载，本机直接失败。
#   5. 不要运行 npx cap sync！它会重写 capacitor.settings.gradle，把插件指向 node_modules
#      里不兼容的串口插件版本，导致启动白屏。只同步网页资源，用下面这段 cp。
set -e

cd "$(dirname "$0")"
PRJ="$(cd .. && pwd)"

export JAVA_HOME="$HOME/toolchain/jdk-21.0.13+9"
export PATH="$JAVA_HOME/bin:$PATH"
export GRADLE_USER_HOME="$HOME/.gradle"
export MALLOC_ARENA_MAX=2
export TMPDIR="$HOME/build-tmp"
export ANDROID_HOME="$HOME/toolchain/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_USER_HOME="$HOME/.android"
export ANDROID_PREFS_ROOT="$HOME"
export ANDROID_SDK_HOME="$HOME"

mkdir -p "$TMPDIR" "$ANDROID_USER_HOME"

# 1) 同步网页资源（等价于 npx cap copy android，但不会碰 capacitor.settings.gradle）
echo ">> 同步 dist/ -> android/app/src/main/assets/public/"
rm -rf app/src/main/assets/public
mkdir -p app/src/main/assets/public
cp -r "$PRJ/dist/." app/src/main/assets/public/
: > app/src/main/assets/public/cordova.js
: > app/src/main/assets/public/cordova_plugins.js

# 2) 编译
echo ">> gradle assembleDebug"
./gradlew :app:assembleDebug --console=plain --no-daemon -Duser.home="$HOME"

APK="app/build/outputs/apk/debug/app-debug.apk"
if [ ! -f "$APK" ]; then
  echo "!! 构建结束但没找到 $APK" >&2
  exit 1
fi

OUT="$PRJ/build-output/apk"
mkdir -p "$OUT"
cp "$APK" "$OUT/ATS-Mini-Remote-debug.apk"
echo ">> 完成: $OUT/ATS-Mini-Remote-debug.apk ($(du -h "$OUT/ATS-Mini-Remote-debug.apk" | cut -f1))"
