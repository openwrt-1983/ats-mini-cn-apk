#!/bin/bash
# 本机打包网页资源到 dist/（替代 vite build）
#
# 为什么不用 vite：本机进程地址空间硬上限 4GB，vite/rollup 内部的 WASM 分配直接
# 抛 RangeError: Cannot allocate Wasm memory，dist/ 出不来。tailwind CLI + esbuild
# 都是原生二进制，占用极小，产物等价（React 19 + 同样的 JSX/CSS，无代码分割）。
#
# 用法：./build-web.sh   然后 ./android/build-apk.sh 出 APK
set -e
cd "$(dirname "$0")"

export PATH="/home/mima1234/.workbuddy/binaries/node/versions/22.22.2/bin:$PATH"
export TMPDIR="$HOME/build-tmp"
mkdir -p "$TMPDIR" dist/assets

echo ">> tailwind"
# 必须显式 -c：tailwind.config.js 是 ESM（export default），CLI 自动探测会失败，
# 结果是把 @tailwind 指令原样留在产物里 → 整个界面没有样式。
./node_modules/.bin/tailwindcss -c tailwind.config.js -i src/index.css -o dist/assets/index.css --minify

echo ">> esbuild"
# 注意：main.jsx 里有 import './index.css'。若直接把产物写进 dist/assets/，
# esbuild 会把那份未经 tailwind 处理的原始 CSS 一起写成 index.css，把上面
# tailwind 的产物覆盖掉（界面会整个没样式）。所以先输出到临时目录再搬。
./node_modules/.bin/esbuild src/main.jsx \
  --bundle --minify --format=esm --target=es2022 \
  --jsx=automatic --loader:.js=jsx \
  --define:process.env.NODE_ENV=\"production\" \
  --outfile="$TMPDIR/app-bundle/index.js"
mv -f "$TMPDIR/app-bundle/index.js" dist/assets/index.js
rm -f "$TMPDIR/app-bundle/index.css"

# 静态资源：dist/index.html 用绝对路径 /assets/...，Capacitor 从 https://localhost 根目录提供服务
for f in icon.png logo.png manifest.json vite.svg; do
  [ -f "public/$f" ] && cp -f "public/$f" "dist/$f"
done

ls -lh dist/assets/index.js dist/assets/index.css
echo ">> dist 就绪"
