#!/usr/bin/env bash
# 一次性打包脚本：把每个含 SKILL.md 的 skill 目录打成 skill.tar.gz
# 输出结构与 TOS key 约定对齐：dist-archives/{skill_id}/skill.tar.gz
# 整批上传到 TOS 桶的 skill-market-mcp/ 前缀下后，路径即为：
#   skill-market-mcp/{skill_id}/skill.tar.gz
#
# 用法：
#   SRC=/path/to/skills bash scripts/pack-archives.sh
# 默认 SRC 指向本机 reference catalog。
set -euo pipefail

SRC="${SRC:-/Users/aweminds/Documents/agent-economic/agent-economic-harness/skill-market/skills}"
OUT="${OUT:-$(cd "$(dirname "$0")/.." && pwd)/dist-archives}"

if [[ ! -d "$SRC" ]]; then
  echo "源目录不存在: $SRC" >&2
  exit 1
fi

mkdir -p "$OUT"
ok=0
skip=0

for dir in "$SRC"/*/; do
  name="$(basename "$dir")"
  # 跳过隐藏目录和非法 slug
  [[ "$name" == .* ]] && continue
  if [[ ! -f "$dir/SKILL.md" ]]; then
    echo "skip (no SKILL.md): $name"
    skip=$((skip + 1))
    continue
  fi
  mkdir -p "$OUT/$name"
  # tar 根目录直接是 SKILL.md + 资源（与 ingest 脚本 cwd=skillDir, ['.'] 一致）
  # 排除 macOS 噪声文件，保证归档干净、sha 稳定
  tar --no-xattrs \
      --exclude='.DS_Store' \
      --exclude='._*' \
      -czf "$OUT/$name/skill.tar.gz" \
      -C "$dir" .
  ok=$((ok + 1))
done

echo ""
echo "打包完成："
echo "  成功 : $ok"
echo "  跳过 : $skip"
echo "  输出 : $OUT"
echo ""
echo "上传方式（任选其一）："
echo "  - 用 tosutil/控制台把 $OUT 下所有目录拖到桶的 skill-market-mcp/ 前缀下"
echo "  - 最终对象路径应为: skill-market-mcp/{skill_id}/skill.tar.gz"
