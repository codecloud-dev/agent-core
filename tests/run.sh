#!/usr/bin/env bash
# 全量单元测试：用 esbuild 把 TS 打成 cjs，node 直接跑（无需 Worker / 浏览器运行时）。
set -e
cd "$(dirname "$0")/.."

echo "==> 打包 src/index.ts"
npx esbuild src/index.ts --bundle --format=cjs --platform=node --outfile=_bundle.cjs --log-level=error

echo
echo "========== @mox/agent-core 单元测试 =========="
node tests/core.test.cjs

rm -f _bundle.cjs
