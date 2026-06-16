# Skill Market 适配接入方案

## 背景

当前 `nanobee` 已经具备 Claude Code workspace agent、agent-runtime platform MCP server、agent profile skill 安装投影等基础能力。Skill Market 的目标使用场景是：workspace agent，也就是 Claude Code，在处理用户指令时，能够稳定地发现、读取并使用相关 skill。

本方案采用：

- 统一 `skill_tools` platform MCP 入口
- Claude Code 自主判断 skill 适用性
- Claude Code system prompt policy
- runtime event audit

Skill Market 不直接接入 Claude Code，而是通过现有 `agent-runtime` 的 platform MCP server 暴露能力，由 `nanoctl` 作为后端适配层访问外部 Skill Market 服务。`nanoctl` 不负责判断“某个 skill 是否足够完成任务”，它只提供已安装 skill 清单、skill 内容、market 检索和安装状态；最终是否使用已有 skill、是否继续查询 Skill Market，由 Claude Code 基于 `SKILL.md` 和任务上下文自主判断。

## 总体架构

```text
Claude Code
  -> system prompt policy 要求执行前调用统一 skill_tools
  -> platform MCP tools:
       skill_tools_list_installed
       skill_tools_get
       skill_tools_search_market
       skill_tools_install        Phase 1 必做，至少支持 mode=current
       skill_tools_report_usage   可选
  -> Claude Code 自主判断已安装 skill 是否满足当前任务
  -> 若不满足、不确定或只部分满足，再查 Skill Market
  -> agent-runtime mcpserver
  -> nanoctl /api/skill-market/*
  -> 外部 Skill Market 服务
  -> 返回 skill metadata / SKILL.md / archive package
```

## 现有基础

当前代码中已有以下能力可以复用：

1. Claude Code 启动时加载 strict MCP config，MCP 工具集合可控。
2. `agent-runtime/internal/mcpserver` 已提供 platform MCP server，并通过 `callSupportAPI` 转发到 `nanoctl`。
3. `sidecar` 的 MCP auth context 已包含 `AgentID`、`WorkspaceID`、`PathSpec`、`RunID`。
4. `SkillReference`、`SkillInstallationProjection`、`.tar.gz` skill archive 安装逻辑已经存在。
5. Claude runtime 的 skill 安装目录已经约定为：

```text
{agent_home}/.claude/skills/{skill_id}
```

skill archive 要求：

```text
skill.tar.gz
  SKILL.md
  assets/... 可选
```

## 接入原则

### Claude Code 负责 skill 适用性判断

skill 本质上是给 agent 阅读和执行的自然语言操作说明，适用边界通常写在 `SKILL.md` 中。不要要求 `nanoctl` 把所有 skill 完全数据化，也不要让 `nanoctl` 做“已有 skill 是否满足当前用户任务”的最终判断。

Claude Code 的执行前流程应为：

```text
1. 调用 skill_tools_list_installed 获取已安装 skills。
2. 根据 name / description / SKILL.md 判断是否已有 skill 明确适用。
3. 如果已有 skill 明确适用，读取并使用该 skill。
4. 如果没有明确适用、只部分覆盖或 Claude Code 不确定，调用 skill_tools_search_market。
5. 对市场返回的候选 skill 调用 skill_tools_get，读取 `SKILL.md` 后再执行任务。
```

判断权在 Claude Code，服务端只提供事实和检索能力。

### Skill Market 只负责发现和内容分发

外部 Skill Market 服务建议只负责：

- skill 检索
- skill 详情
- skill package 下载地址
- skill 元数据

不要让外部 Skill Market 直接操作 workspace、agent profile 或 runtime 文件系统。

### nanoctl 负责业务适配

`nanoctl` 负责：

- 鉴权
- user/workspace/agent 上下文绑定
- 外部 Skill Market API 调用
- skill archive 镜像到 TOS
- 本地 `Skill` 记录创建或更新
- profile skill refs 绑定
- sidecar apply profile 或安装投影
- 返回已安装 skill 的可读信息和 `SKILL.md`
- 对 market 返回结果做 runtime/user/workspace 级别的确定性过滤

`nanoctl` 不负责：

- 判断已有 skill 是否足够完成当前用户任务
- 对 `SKILL.md` 做完整语义理解
- 决定 Claude Code 最终应该使用哪个 skill

### agent-runtime 只做薄 MCP 适配

`agent-runtime` 负责：

- 注册 `skill_tools_*` MCP tools
- 校验 MCP 参数
- 注入 `workspace_id`、`agent_id`、`path_spec`
- 转发到 `nanoctl`
- 返回结构化 tool result

## agent-runtime 改造

### 新增统一 skill_tools MCP tools

在目录：

```text
src/nano-agent-runtime/internal/mcpserver
```

新增：

```text
skill_tools.go
```

建议第一期提供：

- `skill_tools_list_installed`
- `skill_tools_get`
- `skill_tools_search_market`
- `skill_tools_install mode=current`

第二期再提供：

- `skill_tools_install mode=persistent`
- `skill_tools_report_usage`

### 注册工具

在 `server.go` 的 `ListTools` 中追加：

```go
tools = append(tools, skillTools()...)
```

在 `CallTool` 中追加：

```go
if isSkillTool(in.Name) {
	return s.callSkillTool(ctx, in)
}
```

### ToolCallRequest 增加 AgentID

当前 `ToolCallRequest` 有 `WorkspaceID` 和 `PathSpec`，但 skill 安装或查询 installed skills 需要明确当前 workspace agent。

建议改为：

```go
type ToolCallRequest struct {
	AgentID     string              `json:"agent_id,omitempty"`
	WorkspaceID string              `json:"workspace_id"`
	PathSpec    sidecarapi.PathSpec `json:"path_spec"`
	Name        string              `json:"name"`
	Args        map[string]any      `json:"args"`
}
```

在 sidecar MCP call 入口中，从 `mcpTokenContext` 注入：

```go
call.AgentID = ctx.AgentID
call.WorkspaceID = ctx.WorkspaceID
call.PathSpec = ctx.PathSpec
```

REST `/v1/mcp/call` 路径同样注入：

```go
req.AgentID = ctx.AgentID
req.WorkspaceID = ctx.WorkspaceID
req.PathSpec = ctx.PathSpec
```

### agent-runtime 到 nanoctl 的内部 API

新增常量：

```go
const (
	skillToolsListInstalledToolName = "skill_tools_list_installed"
	skillToolsGetToolName           = "skill_tools_get"
	skillToolsSearchMarketToolName  = "skill_tools_search_market"
	skillToolsInstallToolName       = "skill_tools_install"

	platformSkillMarketSearchAPIPath        = "/api/skill-market/search"
	platformSkillMarketGetAPIPath           = "/api/skill-market/get"
	platformSkillMarketListInstalledAPIPath = "/api/skill-market/list_installed"
	platformSkillMarketInstallAPIPath       = "/api/skill-market/install"
)
```

所有 tool call 返回统一使用现有 `ToolCallResponse`：

```json
{
  "ok": true,
  "result": {}
}
```

错误返回：

```json
{
  "ok": false,
  "error_code": "invalid_argument",
  "error": "query is required"
}
```

## nanoctl 改造

### 新增 sidecar auth API group

在 `handlers.go` 中新增：

```text
POST /api/skill-market/search
POST /api/skill-market/get
POST /api/skill-market/list_installed
POST /api/skill-market/install
POST /api/skill-market/report_usage   可选
```

这些接口必须挂在 `requireSidecarAuth()` 下，只允许 agent-runtime 调用。

示意：

```go
sidecarSkillMarket := api.Group("/skill-market", s.requireSidecarAuth())
sidecarSkillMarket.POST("/search", s.handleSkillMarketSearch)
sidecarSkillMarket.POST("/get", s.handleSkillMarketGet)
sidecarSkillMarket.POST("/list_installed", s.handleSkillMarketListInstalled)
sidecarSkillMarket.POST("/install", s.handleSkillMarketInstall)
```

### nanoctl 职责

`nanoctl` 的 Skill Market adapter 需要完成：

1. 根据 `agent_id`、`workspace_id` 获取用户、workspace agent、profile、runtime type。
2. 读取当前 profile 已绑定的 `SkillIDs` 和本地 skill installation。
3. 返回已安装 skill 的 name、description、source、install 状态和 `SKILL.md` 内容。
4. 调外部 Skill Market search/get API。
5. 将外部返回转换为 Claude 可读的候选 skill 和 `SKILL.md`。
6. 对 market 返回结果做确定性过滤，例如 runtime 不兼容、用户不可见、已禁用、重复版本。
7. 对 `install` 请求，镜像 package 到 TOS 并复用现有 `CreateSkill` / `UpdateSkill` / `ApplyAgentProfile` 链路。

`nanoctl` 不返回 `coverage=full|partial|none` 这类最终判断。是否已有 skill 满足使用需求，由 Claude Code 读取已安装 skills 后自行判断。

## MCP Tool 契约

### 1. skill_tools_list_installed

用途：列出当前 workspace agent 已安装 skills，供 Claude Code 在执行前判断是否已有 skill 适用于当前任务。

#### MCP 参数

```json
{}
```

#### nanoctl 返回给 MCP

```json
{
  "ok": true,
  "result": {
    "workspace_agent_id": "wa_xxx",
    "workspace_id": "ws_xxx",
    "runtime_type": "claude",
    "skills": [
      {
        "skill_id": "skill-market-bootstrap",
        "name": "Skill Market Bootstrap",
        "description": "Helps Claude decide when to query Skill Market.",
        "source": "builtin",
        "kind": "bootstrap",
        "installed": true,
        "install_path": "/workspace/runtimes/claude/agents/wa_xxx/home/.claude/skills/skill-market-bootstrap",
        "content_hash": "sha256:...",
        "skill_md_available": true
      },
      {
        "skill_id": "redesign-skill",
        "name": "redesign-skill",
        "description": "Upgrades existing websites and apps to premium quality.",
        "source": "user",
        "kind": "execution",
        "installed": true,
        "install_path": "/workspace/runtimes/claude/agents/wa_xxx/home/.claude/skills/redesign-skill",
        "content_hash": "sha256:...",
        "skill_md_available": true
      }
    ],
    "policy": {
      "decision_owner": "claude_code",
      "when_to_search_market": "If no installed skill clearly applies, if installed skills only partially cover the task, or if you are uncertain, call skill_tools_search_market."
    }
  }
}
```

说明：

- `kind` 是可选辅助字段，由 skill 作者或 Skill Market 提供，`nanoctl` 只做校验和透传。
- `kind` 建议枚举为 `bootstrap`、`execution`、`memory`、`tooling`、`unknown`。
- 当上游没有提供 `kind` 时，`nanoctl` 可以返回 `unknown`，也可以省略该字段。
- `kind=bootstrap` 或 `kind=memory` 的 skill 只能辅助判断或提供上下文，不代表任务一定已被满足。
- `kind=execution` 或 `kind=tooling` 的 skill 通常才是 Claude Code 完成具体任务时要直接使用的 skill。
- Claude Code 不能只依赖 `kind` 做最终判断；如果 `kind` 缺失、为 `unknown` 或描述不明确，应调用 `skill_tools_get` 读取 `SKILL.md`。
- `nanoctl` 不判断 coverage，只把可读信息交给 Claude Code。

### 2. skill_tools_get

用途：读取已安装或市场候选 skill 的详情和 `SKILL.md` 内容。

#### MCP 参数

```json
{
  "skill_id": "redesign-skill",
  "source": "installed",
  "include_content": true
}
```

字段说明：

- `skill_id`：必填。
- `source`：可选，`installed`、`market`、`auto`。默认 `auto`。
- `include_content`：可选，是否返回 `skill_md`。默认 true。

#### nanoctl 返回给 MCP

```json
{
  "ok": true,
  "result": {
    "skill": {
      "skill_id": "redesign-skill",
      "name": "redesign-skill",
      "description": "Upgrades existing websites and apps to premium quality.",
      "source": "installed",
      "kind": "execution",
      "version": "2026.06.01",
      "content_hash": "sha256:...",
      "installed": true,
      "installable": true,
      "skill_md": "# redesign-skill\n\nUse when...",
      "metadata": {
        "categories": ["frontend", "design"],
        "tags": ["ui", "ux"],
        "entrypoint": "SKILL.md"
      }
    }
  }
}
```

说明：

- `skill_md` 是 Claude Code 判断和执行的核心输入。
- `kind` 如果存在，只是辅助判断。缺失或为 `unknown` 时，Claude Code 应直接依据 `skill_md` 判断是否适用。
- `nanoctl` 不需要理解 `skill_md` 全文，只负责返回。

### 3. skill_tools_search_market

用途：当 Claude Code 判断已安装 skills 不明确适用、只部分适用或不确定时，查询 Skill Market。

#### MCP 参数

```json
{
  "query": "优化前端页面视觉",
  "reason": "已安装 skills 中没有明确覆盖 React UI redesign 的执行类 skill",
  "already_considered_skill_ids": ["skill-market-bootstrap", "memory-bootstrap"],
  "repo_hints": {
    "languages": ["typescript"],
    "frameworks": ["react"],
    "files": ["src/app/page.tsx"]
  },
  "max_results": 5
}
```

字段说明：

- `query`：必填，用户任务原文或 Claude 总结后的任务。
- `reason`：建议填写，说明为什么需要查市场，便于审计。
- `already_considered_skill_ids`：可选，Claude 已经看过但认为不足的 skill。
- `repo_hints`：可选，仓库语言、框架、相关文件路径。
- `max_results`：可选，默认 5。

#### agent-runtime 转发到 nanoctl

```json
{
  "agent_id": "wa_xxx",
  "workspace_id": "ws_xxx",
  "path_spec": {
    "workspace_root": "/workspace",
    "platform_root": "/workspace/platform",
    "runtime_home": "/workspace/runtimes/claude/home",
    "project_dir": "/workspace/project"
  },
  "query": "优化前端页面视觉",
  "reason": "已安装 skills 中没有明确覆盖 React UI redesign 的执行类 skill",
  "already_considered_skill_ids": ["skill-market-bootstrap", "memory-bootstrap"],
  "repo_hints": {
    "languages": ["typescript"],
    "frameworks": ["react"],
    "files": ["src/app/page.tsx"]
  },
  "max_results": 5
}
```

#### nanoctl 返回给 MCP

```json
{
  "ok": true,
  "result": {
    "query": "优化前端页面视觉",
    "skills": [
      {
        "skill_id": "redesign-skill",
        "name": "redesign-skill",
        "description": "Upgrades existing websites and apps to premium quality.",
        "confidence": 0.93,
        "reason": "用户要求前端视觉升级，匹配 UI redesign 场景",
        "categories": ["frontend", "design"],
        "tags": ["ui", "ux", "react"],
        "version": "2026.06.01",
        "content_hash": "sha256:...",
        "installed": false,
        "requires_install": true,
        "usage_mode": "install_current_then_follow",
        "skill_md_available": true
      }
    ]
  }
}
```

### 4. skill_tools_install

用途：安装或持久化某个 skill。Phase 1 必须支持 `mode=current`，否则带脚本、模板、代码或 assets 的 market skill 无法在当前 run 稳定使用。

`mode=persistent` 涉及 profile 更新、sidecar apply profile、当前 Claude session 是否重启等问题，建议第二期做。

#### MCP 参数

```json
{
  "skill_id": "redesign-skill",
  "mode": "persistent"
}
```

`mode` 建议支持：

- `current`：安装到当前 run 的动态 skill 目录，当前 run 通过返回的 entrypoint 路径立即使用。
- `persistent`：持久安装到 agent profile，后续 run 或 session 重启后稳定可见。

#### current 返回

```json
{
  "ok": true,
  "result": {
    "skill_id": "redesign-skill",
    "mode": "current",
    "installed": true,
    "effective": "immediate_by_path",
    "workspace_agent_id": "wa_xxx",
    "runtime_type": "claude",
    "install_path": "/workspace/runtimes/claude/agents/wa_xxx/run-skills/run_xxx/redesign-skill",
    "entrypoint": "/workspace/runtimes/claude/agents/wa_xxx/run-skills/run_xxx/redesign-skill/SKILL.md",
    "content_hash": "sha256:...",
    "instruction": "Read the entrypoint file and follow this skill for the current task.",
    "message": "Skill installed for the current run. Read the entrypoint file before continuing."
  }
}
```

`current` 模式会真实解包 skill archive，因此适用于包含脚本、模板、代码、assets 的 skill。Claude Code 不依赖原生 skill 自动发现，而是根据 tool result 中的 `entrypoint` 显式读取 `SKILL.md`。

#### persistent 返回

```json
{
  "ok": true,
  "result": {
    "skill_id": "redesign-skill",
    "mode": "persistent",
    "installed": true,
    "effective": "next_run",
    "workspace_agent_id": "wa_xxx",
    "runtime_type": "claude",
    "install_path": "/workspace/runtimes/claude/agents/wa_xxx/home/.claude/skills/redesign-skill",
    "entrypoint": "/workspace/runtimes/claude/agents/wa_xxx/home/.claude/skills/redesign-skill/SKILL.md",
    "content_hash": "sha256:...",
    "message": "Skill installed persistently. It will be available in the next Claude Code run or after session restart."
  }
}
```

### 5. skill_tools_report_usage

用途：记录 skill 是否被选中、读取、安装、应用或跳过。

#### MCP 参数

```json
{
  "skill_id": "redesign-skill",
  "usage": "applied",
  "reason": "用户任务是前端 redesign，已按 skill 执行"
}
```

`usage` 建议枚举：

- `selected`
- `read`
- `installed`
- `applied`
- `skipped`

#### 返回

```json
{
  "ok": true,
  "result": {
    "recorded": true
  }
}
```

## 外部 Skill Market 服务接口

外部 Skill Market 面向 nanoctl，建议提供以下接口。

### 1. POST /v1/skills/search

#### 请求

```json
{
  "query": "优化前端页面视觉",
  "task_type": "frontend",
  "repo_hints": {
    "languages": ["typescript"],
    "frameworks": ["react"],
    "files": ["src/app/page.tsx"]
  },
  "max_results": 5,
  "user_context": {
    "user_id": "u_xxx",
    "workspace_id": "ws_xxx"
  }
}
```

#### 返回

```json
{
  "skills": [
    {
      "skill_id": "redesign-skill",
      "name": "redesign-skill",
      "description": "Upgrades existing websites and apps to premium quality.",
      "confidence": 0.93,
      "reason": "Matches frontend redesign intent.",
      "categories": ["frontend", "design"],
      "tags": ["ui", "ux", "react"],
      "version": "2026.06.01",
      "content_hash": "sha256:...",
      "requires": {
        "runtime_types": ["claude"],
        "tools": ["browser", "filesystem"]
      }
    }
  ]
}
```

### 2. GET /v1/skills/{skill_id}

#### 返回

```json
{
  "skill_id": "redesign-skill",
  "name": "redesign-skill",
  "description": "Upgrades existing websites and apps to premium quality.",
  "version": "2026.06.01",
  "content_hash": "sha256:...",
  "skill_md": "# redesign-skill\n\nUse when...",
  "package": {
    "archive_url": "https://skill-market.example.com/skills/redesign-skill/skill.tar.gz",
    "sha256": "..."
  },
  "metadata": {
    "categories": ["frontend", "design"],
    "tags": ["ui", "ux"],
    "entrypoint": "SKILL.md"
  }
}
```

### 3. GET /v1/skills/{skill_id}/download

用于下载 `.tar.gz` skill archive。

要求：

- 返回内容必须是 gzip tar archive。
- archive 内必须包含根目录下的 `SKILL.md`。
- archive path 不能包含绝对路径或 `..` 逃逸。
- 建议响应头包含：

```text
Content-Type: application/gzip
X-Skill-ID: redesign-skill
X-Skill-Version: 2026.06.01
X-Skill-SHA256: ...
```

## Bootstrap Skill

建议新增内置 bootstrap skill，作为统一 `skill_tools` 使用规则说明：

```text
skill-market-bootstrap/
  SKILL.md
```

建议内容：

```md
# Skill Market Bootstrap

Use this skill before starting software engineering tasks.

Workflow:
1. Summarize the user's request.
2. Call `skill_tools_list_installed` before execution.
3. Inspect installed skill names, descriptions, summaries, and `SKILL.md` when needed.
4. If an installed skill clearly applies, follow that skill.
5. If no installed skill clearly applies, if installed skills only partially cover the task, or if you are uncertain, call `skill_tools_search_market`.
6. For relevant market results, call `skill_tools_install` with `mode=current`.
7. Read the returned `entrypoint` file and follow that skill for the current task.
8. If persistent installation is useful, call `skill_tools_install` with `mode=persistent`.
9. If no relevant skill exists, continue normally.
```

接入方式：

- 将 `skill-market-bootstrap` 做成 builtin skill。
- 默认注入 Claude workspace agent profile 的 `SkillIDs` 或 `SkillRefs`。
- 通过现有 `ApplyAgentProfile` 安装到 `.claude/skills/skill-market-bootstrap`。

## System Prompt Policy

仅安装 bootstrap skill 不足以保证稳定触发。需要在 Claude Code system prompt 追加短规则，要求它先走统一 `skill_tools` 入口，但不要让 `nanoctl` 代替 Claude 做适用性裁决：

```text
Before starting any software engineering task, call `skill_tools_list_installed` through platform MCP.
Inspect the installed skills and decide whether any installed skill clearly applies to the current task.
The optional `kind` field is only a hint; if it is missing, unknown, or unclear, inspect SKILL.md with `skill_tools_get`.
If an installed skill clearly applies, call `skill_tools_get` and follow its SKILL.md.
If no installed skill clearly applies, if coverage is partial, or if you are uncertain, call `skill_tools_search_market`.
For relevant market results, call `skill_tools_install` with `mode=current`, then read the returned entrypoint file and follow that skill.
```

规则要短，避免和用户任务、已有 agent profile prompt 冲突。

## Event Audit

Claude Code 的 MCP tool use 会进入 runtime event stream。审计逻辑检查：

```text
tool_name contains "skill_tools_list_installed"
```

建议记录以下状态：

- `missing_inventory`：工程任务未调用 `skill_tools_list_installed`。
- `inventory_loaded`：已调用 `skill_tools_list_installed`。
- `used_installed`：Claude 读取并使用了已安装 skill。
- `market_searched`：已调用 `skill_tools_search_market`。
- `selected`：市场 search 返回高相关 skill。
- `read`：调用了 `skill_tools_get`。
- `applied`：读取 skill 后继续执行任务。
- `skipped`：模型说明无合适 skill 或主动跳过。

第一期可以只做 warning 级别审计，不阻断任务。

如果后续要求强制触发，可以在下一轮自动注入提示：

```text
You have not inspected installed skills yet. Call `skill_tools_list_installed` before continuing.
```

## 安装生效策略

### current 模式：当前 run 安装并显式使用

对从 Skill Market 获取的新 skill，建议默认走 `skill_tools_install mode=current`，而不是只返回 `SKILL.md`。这样纯说明型 skill 和带脚本、模板、代码、assets 的 skill 都能走同一条路径。

`current` 模式的关键前提：

```text
Claude Code 进程启动时，必须提前通过 --add-dir 加入一个固定的动态 skill 根目录。
```

原因是 `--add-dir` 是进程启动参数，当前 Claude session 启动后通常不能再动态追加目录。如果中途安装到一个 Claude Code 无权访问的新目录，当前 run 可能无法读取该 skill 的脚本或 assets。

建议目录：

```text
{agent_home}/run-skills/{run_id}/{skill_id}
```

Claude Code 启动参数需要预置：

```text
--add-dir {agent_home}/run-skills
```

`skill_tools_install mode=current` 做：

1. 从 Skill Market 获取 skill archive。
2. 解包到 `{agent_home}/run-skills/{run_id}/{skill_id}`。
3. 校验 archive 内必须有 `SKILL.md`。
4. 返回 `install_path`、`entrypoint`、`content_hash`。
5. 在 tool result 中显式提示 Claude Code 读取 `entrypoint` 并按该 skill 执行。

返回的 `instruction` 必须明确：

```text
Read the entrypoint file and follow this skill for the current task.
```

这样 current 模式具备两个保证：

- 文件可见性：`--add-dir` 已提前允许 Claude Code 访问动态 skill 根目录。
- 行为触发：tool result 显式要求 Claude Code 读取 `SKILL.md`，不依赖 Claude Code 自动重新扫描已安装 skills。

### 第一推荐：当前 run 安装，后续按需持久安装

第一期建议：

- `skill_tools_list_installed` 返回已安装 skill 清单。
- Claude Code 自主判断是否已有 skill 明确适用。
- 不明确适用时，调用 `skill_tools_search_market` 找市场候选。
- 对市场候选调用 `skill_tools_install mode=current`。
- Claude 当前 run 读取返回的 `entrypoint` 并使用该 skill。
- 是否持久安装由后续策略决定。

优点：

- 不需要重启当前 Claude session。
- 不影响当前任务执行。
- 支持带脚本、模板、代码、assets 的 skill。
- 最快落地。

### 持久安装作为第二期

`skill_tools_install mode=persistent` 可能导致：

- profile 更新
- sidecar apply profile
- Claude session close
- 下一个 run 才稳定可见

所以返回里必须明确：

```json
{
  "effective": "next_run"
}
```

不要承诺当前 run 立即从 `.claude/skills` 自动发现新安装 skill。

## 分期计划

### Phase 1：稳定发现和当前 run 安装

交付：

- `skill_tools_list_installed`
- `skill_tools_get`
- `skill_tools_search_market`
- `skill_tools_install mode=current`
- Claude 启动时预置动态 skill 根目录 `--add-dir`
- `skill-market-bootstrap` builtin skill
- Claude system prompt policy
- event audit warning

目标：

- Claude Code 在工程任务前稳定获取已安装 skill 清单。
- Claude Code 自主判断已有 skill 是否适用，不确定时再查 Skill Market。
- 从 Skill Market 获取的新 skill 默认安装到当前 run 动态目录。
- 当前 run 可以通过返回的 `entrypoint` 读取并使用 `SKILL.md`、脚本、模板和 assets。

### Phase 2：持久安装

交付：

- `skill_tools_install mode=persistent`
- profile skill refs 更新
- apply profile
- install projection 状态返回

目标：

- 选中的 skill 可以持久安装到 workspace agent。
- 后续 run 自动可用。

### Phase 3：质量闭环

交付：

- `skill_tools_report_usage`
- skill 命中率、读取率、应用率统计
- 未触发补偿机制
- 基于 event audit 的推荐调优

目标：

- 衡量 Skill Market 是否真正提升任务成功率。
- 逐步优化检索排序和触发策略。

## 第一版最小接口清单

agent-runtime MCP tools：

```text
skill_tools_list_installed
skill_tools_get
skill_tools_search_market
skill_tools_install
```

nanoctl sidecar APIs：

```text
POST /api/skill-market/search
POST /api/skill-market/get
POST /api/skill-market/list_installed
POST /api/skill-market/install
```

外部 Skill Market APIs：

```text
POST /v1/skills/search
GET  /v1/skills/{skill_id}
GET  /v1/skills/{skill_id}/download
```

第一版应支持 `skill_tools_install mode=current`。从 Skill Market 获取的新 skill 统一安装到当前 run 动态 skill 目录，并返回 `entrypoint` 给 Claude Code 显式读取使用。是否已有 skill 满足使用需求，由 Claude Code 在读取已安装 skill 清单后自行判断；`nanoctl` 只提供事实、内容、market 检索和安装能力。
