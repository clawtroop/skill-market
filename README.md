# Skill Market (Standalone Service)

独立部署的 Skill Market 服务。

对外暴露（按《Skill Market 适配接入方案》）：

- `POST /v1/skills/search`
- `GET  /v1/skills/{skill_id}`
- `GET  /v1/skills/{skill_id}/download` （返回 skill.tar.gz，tar 根目录包含 `SKILL.md`）

后端存储：
- PostgreSQL：skill 元数据（name/description/when_to_use/完整 body/ resources manifest / tos key / sha256）
- 火山引擎 TOS：每个 skill 整目录打包为 `skill.tar.gz` 上传

## 快速开始

```bash
cp .env.example .env
# 编辑 .env 填 DATABASE_URL + TOS_* 凭证 + SKILL_MARKET_INGEST_CATALOG_ROOT
npm install
```

### 首次数据入库（ingest）

从 reference 目录扫描 501 个 skill：

```bash
npm run ingest
# 预览不真正上传/写库
DRY_RUN=1 npm run ingest:dry
```

ingest 过程：
1. 用 SkillCatalogLoader 扫描 + 校验 frontmatter + 资源清单
2. 每个 skill dir 打 `tar -czf`（tar 内部根目录直接是 SKILL.md + references/ + ...）
3. 上传到 TOS `skills/{skill_id}/skill.tar.gz`
4. 计算 sha256，写入 Postgres `skill_market_items`

### 启动服务

```bash
npm run dev          # tsx 热更新
# 或
npm run build && npm start
```

服务默认监听 4000。

## Docker

```bash
docker compose up -d db
# 准备好 TOS 凭证后执行 ingest（需要把 TOS_* 也传给容器）
docker compose run --rm -e TOS_ACCESS_KEY=... skill-market npm run ingest
docker compose up skill-market
```

## 环境变量

见 `.env.example`。关键：

- `DATABASE_URL`
- `TOS_ENDPOINT / TOS_ACCESS_KEY / TOS_SECRET_KEY / TOS_BUCKET / TOS_REGION / TOS_PREFIX`
- `SKILL_MARKET_INGEST_CATALOG_ROOT` （ingest 用）
- `PUBLIC_BASE_URL` （构造 archive_url）

## 与参考目录解耦

- 代码已完整独立（不依赖原单体 TaskBoard / run token）
- catalog 原来 FS 扫描只保留在 ingest 脚本和 loader 里
- 运行时 search 走 PG 内存轻量索引 + 词重叠 ranker（完整复用 reference 的 text/ranker 逻辑）
- load / download 走 PG + TOS

## 端点示例

```bash
curl -X POST http://localhost:4000/v1/skills/search \
  -H 'content-type: application/json' \
  -d '{"query": "前端视觉优化 redesign", "topK": 3}'

curl http://localhost:4000/v1/skills/ad-creative

curl -I http://localhost:4000/v1/skills/ad-creative/download
# Content-Type: application/gzip
# X-Skill-ID: ad-creative
# X-Skill-SHA256: ...
```

## 注意事项

- 首次 ingest 建议在有足够带宽/权限的机器上跑（501 个 tar 上传）。
- 后续 skill 更新：重新跑 ingest（ON CONFLICT 更新）或单独写 admin 上传接口。
- 当前 ranker 是纯词袋 overlap（中英混合 token），对语义召回可后续加 embedding / PG vector 扩展。
- download 接口直接从 TOS 流式代理返回（不落地），支持大文件。

## 目录结构

```
src/
  main.ts
  app.module.ts
  common/
    persistence/pg-pool.ts
    storage/tos-storage.service.ts
  skill-market/
    *.ts (service, repo, controller, config, types, errors, ranker, text, loader, module, filter)
scripts/
  ingest-skill-market.ts
```

本项目即为可独立部署的 skill market 新服务。
