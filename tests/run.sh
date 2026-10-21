#!/usr/bin/env bash
# 全量单元测试：用 esbuild 把 TS 打成 cjs，node 直接跑（无需 Worker / 浏览器运行时）。
set -e
cd "$(dirname "$0")/.."

# 测试失败（set -e 提前退出）时也要清理临时打包产物
trap 'rm -f _bundle.cjs' EXIT

echo "==> 打包 src/index.ts"
npx esbuild src/index.ts --bundle --format=cjs --platform=node --outfile=_bundle.cjs --log-level=error

echo
echo "========== @mox/agent-core 单元测试 =========="
node tests/core.test.cjs
node tests/adapters.test.cjs
