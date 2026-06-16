# Skill Market 服务接入文档

整体链路（详见《Skill Market 适配接入方案.md》）：

```
Claude Code
  → agent-runtime platform MCP server（注册 skill_tools_* 工具）
  → nanoctl /api/skill-market/*（业务适配层）
  → 外部 Skill Market 服务（本服务）   ← 本文档描述的部分
```

本服务**只负责事实与检索**：skill 检索、归档下载（SKILL.md 含在归档内）。不做「skill 是否满足任务」的判断（那是 Claude Code 的职责），不操作 workspace / agent profile / runtime 文件系统。

---

## 一、服务基本信息


| 项        | 值                                                    |
| -------- | ---------------------------------------------------- |
| 协议       | HTTP / JSON                                          |
| 默认端口     | `4000`（由 `PORT` 配置）                                  |
| 鉴权       | v1 无鉴权（建议放在内网，仅 nanoctl 可达；如需鉴权见文末「安全建议」）            |
| 数据来源     | Postgres（元数据 + SKILL.md 正文）+ 火山 TOS（skill.tar.gz 归档） |
| skill 总量 | 499                                                  |


服务地址记为 `${SKILL_MARKET_BASE_URL}`，例如 `http://skill-market.internal:4000`。

---

## 二、接口契约（两个核心接口）

### 1. 检索 skill — `POST /v1/skills/search`

供 nanoctl 实现 `skill_tools_search_market` 时调用。

**请求体：**

```json
{
  "query": "accessibility audit for react",
  "topK": 5
}
```


| 字段                                          | 类型     | 必填  | 说明                        |
| ------------------------------------------- | ------ | --- | ------------------------- |
| `query`                                     | string | 是   | 检索词，1~2000 字符，支持中英文       |
| `topK`                                      | int    | 否   | 返回条数，1~10，默认 5            |
| `max_results`                               | int    | 否   | `topK` 的别名（兼容），二者皆缺省时默认 5 |
| `task_type` / `repo_hints` / `user_context` | any    | 否   | v1 接受但不参与排序（预留）           |


**响应 200：**

```json
{
  "skills": [
    {
      "skill_id": "a11y-audit",
      "name": "Accessibility Audit",
      "description": "...",
      "confidence": 0.8123,
      "reason": "lexical overlap match (score=0.8123)",
      "archive_url": "${PUBLIC_BASE_URL}/v1/skills/a11y-audit/download"
    }
  ]
}
```

- `confidence`：0~1 的词法重叠得分（name 0.45 + description 0.4 + when_to_use 0.15 加权）。**注意：这是词法匹配，不是语义检索**，无匹配项会被过滤，可能返回空数组 `{"skills":[]}`。
- 排序：得分降序，同分按 `skill_id` 升序。
- `archive_url`：完整 skill 包（含 SKILL.md + 资源）的下载直链。**命中后直接据此下载并安装即可，无需再调其他接口读取 SKILL.md。** 由 `PUBLIC_BASE_URL` 拼成，若该 env 为空则为相对路径，**部署时务必配置 `PUBLIC_BASE_URL` 为服务对外可达地址**。归档 sha256 在下载响应头 `X-Skill-SHA256` 返回，供下载后校验。

### 2. 下载 skill 归档 — `GET /v1/skills/{skill_id}/download`

返回 `skill.tar.gz` 二进制流（包根直接是 `SKILL.md` + `references/scripts/assets` 等资源）。agent 命中 skill 后直接下载、解包即可使用，SKILL.md 就在包内。

**响应 200：** `Content-Type: application/gzip`，响应头含：


| 响应头                   | 说明                                               |
| --------------------- | ------------------------------------------------ |
| `Content-Disposition` | `attachment; filename="{skill_id}-skill.tar.gz"` |
| `X-Skill-ID`          | skill id                                         |
| `X-Skill-SHA256`      | 归档 sha256（与 search 响应一致，用于校验）                       |
| `X-Skill-Name`        | skill 名称                                         |
| `Content-Length`      | 字节数                                              |


**错误：** 404（skill 不存在）；502（TOS 取归档失败，`{"message":"failed to fetch archive from storage"}`）。

### 辅助接口 — `GET /v1/skills?limit=N`

运维健康检查用，返回 `{"count":499,"items":[...]}`。可用于确认索引是否正确加载（`count` 应为 499）。

---

## 三、错误码约定


| HTTP | 含义     | 触发场景                       |
| ---- | ------ | -------------------------- |
| 400  | 参数错误   | query 为空/超 2000 字符、topK 越界 |
| 404  | 资源不存在  | skill_id 不存在               |
| 502  | 存储后端失败 | TOS 取归档失败                  |
| 500  | 服务内部错误 | 其他未预期错误                    |


错误响应体统一为 `{"statusCode":<code>,"message":"..."}`（download 的 502 为 `{"message":"..."}`）。

---

## 四、接入要点

### nanoctl 

新增 `/api/skill-market/`* 内部接口（挂 `requireSidecarAuth()`，仅 agent-runtime 可调），内部转调本服务：


| nanoctl 能力 | 转调本服务                                                              |
| ---------- | ------------------------------------------------------------------ |
| market 检索  | `POST /v1/skills/search`（响应内含 `archive_url`）                        |
| 安装 skill   | 用 search 返回的 `archive_url`（即 `GET /v1/skills/{id}/download`）拿 tar.gz，解包到 agent profile，SKILL.md 在包内 |


需要在 nanoctl 配置中加入本服务地址，例如 `SKILL_MARKET_BASE_URL=http://skill-market.internal:4000`。
**网络要求：nanoctl 必须能内网访问到本服务。**

### agent-runtime 

按方案文档「agent-runtime 改造」：注册 `skill_tools_`* MCP 工具、校验参数、转发到 nanoctl `/api/skill-market/`*。**不直接调用本服务**，只经 nanoctl。注入 `AgentID/WorkspaceID/RunID` 等 context 由 agent-runtime 负责。

### Claude Code

按方案文档：strict MCP config 放出 `skill_tools_`* 工具；system prompt policy 引导 Claude Code 在「不确定/部分覆盖」时调用 `skill_tools_search_market`。判断权在 Claude Code，本服务只提供事实。

---

## 五、自检命令（部署后验证本服务可用）

```bash
BASE=http://<服务地址>:4000

# 1. 索引加载（连库 + 数据导入是否成功），应返回 count: 499
curl "$BASE/v1/skills"

# 2. 检索（响应内含 archive_url）
curl -X POST "$BASE/v1/skills/search" \
  -H 'Content-Type: application/json' \
  -d '{"query":"accessibility audit"}'

# 3. 下载归档（验证 TOS 链路；SKILL.md 在包内）
curl -L "$BASE/v1/skills/a11y-audit/download" -o t.tar.gz && tar -tzf t.tar.gz | head
```

三条全通 = 本服务这层就绪，剩余为上游（nanoctl / agent-runtime / Claude Code）对接。