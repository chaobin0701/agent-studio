# 本地 Phoenix 执行追踪

> 2026-10-28：当前追踪出口已迁移到 LangSmith，配置与验收入口见 [LangSmith 追踪](langsmith-tracing.md)。本文中的 Phoenix 入库数量和命令属于历史验收记录，不代表当前配置。

## 边界

本次仅将应用追踪适配器替换为 Arize Phoenix。**LangGraph、Agent／Prompt／Skill／Tool／MCP／模型／知识库管理、发布版本、本地 Trace、审计与模型调用计费保持不变**。Phoenix 不接管资源配置，不建立新的执行循环，不增加业务重试或模型调用。

应用直接依赖 `@arizeai/phoenix-otel@2.2.0`，通过其私有 Provider 和 OpenTelemetry / OpenInference 语义导出 OTLP/HTTP Protobuf（Phoenix 端点不接收 OTLP/JSON）。已删除直接的 LangSmith SDK 依赖、环境配置、链接端点及追踪调用。LangGraph 的 `@langchain/core` 仍间接依赖其自带的 LangSmith 库；该库不是本项目追踪实现，不能粗暴删除而破坏 LangGraph。自动全状态追踪继续被隔离。

## 独立服务启动

在当前开发工作区执行，不使用主项目的 Compose 文件：

```sh
mkdir -p infra/phoenix
(umask 077; printf 'PHOENIX_POSTGRES_PASSWORD=%s\nPHOENIX_PORT=6006\n' "$(openssl rand -hex 32)" > infra/phoenix/.env)
docker compose --env-file infra/phoenix/.env -f docker-compose.phoenix.yml up -d --wait
```

已有 `infra/phoenix/.env` 时不要覆盖它，尤其不要替换正在使用的数据库密码。文件已被 Git 忽略。密码推荐 64 位十六进制，以避免数据库 URL 转义问题。

- UI 和 OTLP 入口：[本地 Phoenix](http://127.0.0.1:6006)。端口冲突时在上述文件修改 `PHOENIX_PORT`，同时调整应用的 collector 和 web URL。
- Compose 使用独立 project `agent-studio-phoenix`；Phoenix、专用 PostgreSQL、持久卷均不复用主项目数据库。
- Phoenix 与数据库只连接 internal 网络，不向宿主机直接发布数据库或 gRPC 端口。轻量 Nginx 网关只发布 `127.0.0.1` 的 HTTP 端口，固定代理到 Phoenix，不提供任意转发。
- `PHOENIX_TELEMETRY_ENABLED=false`、`PHOENIX_ALLOW_EXTERNAL_RESOURCES=false`；禁用 Phoenix 助手、Phoenix MCP、SQL 正文日志，不配置外部模型或远端 exporter。网关关闭访问日志，不记录认证头／请求内容。
- 数据保存到独立 `phoenix_postgres_data` 和 `phoenix_data` 命名卷，重启不删除追踪记录。

```sh
# 状态、日志与单独停止；不会操作主项目服务。
docker compose --env-file infra/phoenix/.env -f docker-compose.phoenix.yml ps
docker compose --env-file infra/phoenix/.env -f docker-compose.phoenix.yml logs --tail=50 phoenix
docker compose --env-file infra/phoenix/.env -f docker-compose.phoenix.yml stop
```

不要运行 `down -v`，它会删除 Phoenix 的持久数据。备份／恢复应只针对专用 Phoenix PostgreSQL。该本机入口默认无登录，仅适用于开发机器／受控平台运维主机；不要改成公网监听。跨主机共享需先补反向代理认证、TLS 与访问控制，不能把 UI 当作本项目多租户隔离接口。

## 应用配置

配置示例在根 `.env.example`。默认开启，只连接本地，即使服务未启动也不阻塞任务。

```dotenv
PHOENIX_TRACING=true
PHOENIX_COLLECTOR_ENDPOINT=http://127.0.0.1:6006/v1/traces
PHOENIX_WEB_URL=http://127.0.0.1:6006
PHOENIX_PROJECT_NAME=generic-agents
PHOENIX_API_KEY=
PHOENIX_SAMPLE_RATE=1
PHOENIX_TIMEOUT_MS=2000
PHOENIX_QUEUE_LIMIT=1000
```

- collector 支持根 URL 或 `/v1/traces`。只接受回环、Docker 固定内部主机名及 RFC1918 内网 IPv4；拒绝公共云、带用户凭据／查询／片段的 URL。端点只由服务器环境配置，不由请求提交。
- `PHOENIX_API_KEY` 仅用于启用认证后的**本地** Phoenix；默认本机部署不要求云端 Key。不得填入模型供应商密钥。
- 私有 Provider，不注册全局 instrumentation；不读取通用 `OTEL_EXPORTER_OTLP_*` 出口和认证头，不跟随重定向，不向云端回退。
- 所有网络导出异步、有界、带超时、不重试；关闭时有限等待刷新。采样按根任务决定，子调用继承。队列满会丢弃追踪，不重试业务，更不会免费释放未知用量。
- 容器化 API 不能将其容器的 `127.0.0.1` 当作宿主机。可使用同一 Docker 内部网络的 `http://phoenix:6006/v1/traces`，或受控主机的内网入口；不要开放公网追踪端口。本次未重新部署或重启主项目 API。项目提供可选的 `docker-compose.phoenix-api.yml`，在后续正常部署时与主 Compose 合并，仅把 API 接入 Phoenix 内部网络，不修改已有业务数据库：

```sh
# 先启动独立 Phoenix；下面会部署主项目，需在正常上线窗口执行。
docker compose -f docker-compose.yml -f docker-compose.phoenix-api.yml up -d api
```

## 采集范围与脱敏

统一显式埋点覆盖：

- 单 Agent 图与各节点；成员 Agent、隔离 Skill 的父子图。
- 实际模型尝试、重试和备用模型；原生 Tool、HTTP Tool、MCP 与各次工具尝试。
- 问题向量生成、各知识库全文／向量召回、多库融合和兼容回退。
- 请求准备与 Agent 图共用 `agent_request` 父追踪；异步会话摘要使用 `conversation_summary` 子追踪，回答不等待摘要。摘要失败不会把已成功回答的请求改为失败。
- 成功、失败、取消、期限／预算上限；只记录安全错误分类，不记录原始异常堆栈或供应商正文。

默认采取**正文不采集**的脱敏策略，比仅用正则掩码更严格。只有白名单标识、版本、计数、耗时、Token、状态进入属性；没有恢复完整 Prompt、消息、工具参数、工具返回值、文档内容或向量数组的开关。模型调用带 OpenInference LLM Token/模型语义，检索和向量调用带对应类型语义。

错误码也只允许已知平台分类，未知异常的任意 `code` 不直接上传，统一归类为 `execution_failed`。摘要提示词仍由代码管理：记录 `purpose=summary` 与提示词 SHA-256 `codePromptVersion`，不采集正文，也不误用 Agent 业务 Prompt 的版本 ID。模型 Token 语义仅记在 LLM span，父链不重复计入模型 Token。

每次图通过 `app.localRunId` / `app.localTraceId` 与本地记录关联，保留 Agent、Prompt、模型方案、向量方案、工具、MCP、Skill 和实际索引版本 ID。`contextSnapshot.phoenix` 仅保存本次 span/trace ID、项目及已配置链接，不保存 SDK 对象或凭据。

新后台继续展示本地白名单详情；Phoenix 跳转改为 `/api/admin/executions/:id/phoenix`，要求独立 `observability.external.read` 平台权限及当前工作区 `conversations.read`。只从本地配置和已保存映射重建链接，不接受任意存储 URL；旧数据中的外部链接仍被隐藏。界面交互由用户验收。

## 验证

默认后端测试不会启动 Docker 或发送付费模型请求。专门的真实追踪验收要求上述 Compose 已健康启动：

```sh
npm run verify:phoenix --prefix server
```

验收运行真实 LangGraph、执行服务、OpenTelemetry Provider、官方 OTLP 序列化及原生 MCP 协议；模型返回使用确定性替身，不消耗模型账户额度。它把 span 发送到真实本地 Phoenix，然后通过 Phoenix REST API **读回已存储记录**，核对父子树、类型、版本关联、实际重试／异常和敏感正文未入库。仅成功收到 HTTP 200 不算通过。

```sh
npm run build --prefix server
npm test --prefix server
# admin-vben 目录
pnpm typecheck
pnpm build
```

PostgreSQL／HTTP 集成测试需按项目测试约定显式开启并使用独立 schema，不对开发业务数据执行迁移。Phoenix 独立数据库由 Phoenix 自行管理 schema。

付费模型验证可以额外显式开启本地追踪：

```sh
AGENT_ACCEPTANCE_ENV_FILE=/path/to/private/.env AGENT_ACCEPTANCE_PHOENIX=true npm run verify:agent:live --prefix server
```

这项会消耗模型 Token；仅使用已有发布模型方案和临时只读算术工具，不修改 Agent、Prompt、模型或知识库资源，也不执行既有业务写工具。验收 Agent／Prompt 为临时配置，模型方案版本是真实发布版本。

## 实施与验收记录

- 后端编译通过；包含 PostgreSQL / HTTP / 工作区 RLS 在内全量 **423 通过、0 跳过、0 失败**。
- 新后台 `pnpm typecheck`、`pnpm build` 通过，页面由用户测试。
- `verify:phoenix` 从真实 Phoenix REST 接口读回 **9 条执行树、127 个 span**，覆盖 AGENT、CHAIN、LLM、TOOL、RETRIEVER、EMBEDDING；检查了父子关系、版本、重试／错误、原生 MCP、真实 HTTP Tool／远端 MCP 传输、异步摘要及敏感正文未入库。模型使用确定性替身，HTTP／MCP 服务为临时本机夹具，不冒充真实供应商模型验收。
- 真实发布模型方案另外通过两项只读验收：无工具任务 1 次模型调用、5 个已入库 span；原生算术工具任务 2 次模型调用、1 次工具调用、10 个已入库 span。测试 Agent／Prompt 为临时配置，没有修改主项目资源。
- 多轮验收累计入库后，Phoenix 和专用 PostgreSQL 重启前后均为 **592 个 span**，全部 span ID 集合校验一致；本机网关健康检查恢复。这是累积持久化记录，不是单次验收的 span 数量。
- Phoenix 运行时实际确认 telemetry / external resources 为关闭、助手禁用、Phoenix MCP 关闭。入口仅绑定本机，Phoenix / 数据库仍在 internal 网络。
- 主项目 API、Worker、旧后台、网站、新后台仍在线且进程未更换；没有执行主业务数据库迁移。可选 API Compose 附加文件仅做配置验证，未用于部署主服务。

### 本次追踪接入验收对照

| 要求 | 实现与验证 |
| --- | --- |
| 保留 LangGraph，替换追踪实现 | 私有 Phoenix Provider；直接 LangSmith 依赖／配置／调用移除；自动全状态导出隔离测试 |
| 单／多 Agent 与各类能力追踪 | 真实图、Skill／成员、模型尝试、HTTP Tool／MCP、检索／向量／融合和后台摘要；真实 Phoenix 入库读回 |
| 独立本地部署与持久化 | 独立 Compose／PostgreSQL／命名卷／internal 网络；重启前后全部 span ID 一致 |
| 版本与本地业务记录关联 | Run／Trace、Agent／Prompt／模型／Tool／MCP／Skill／索引版本白名单；本地 Trace、审计和用量账本保留 |
| 安全与故障隔离 | 正文不采集、错误码白名单、受控本地出口、无重定向／云端回退；断网／超时／队列满不改变业务结果 |
| 自动化检查与交付 | 423 项后端全量通过，新后台类型检查／构建通过；用户验收页面交互；主项目未切换 |

本表只验收本轮追踪接入，不宣称通用 Agent 平台的全部入口与部署阶段已完成；剩余范围见 [迁移记录](langgraph-migration.md)。


参考：[Phoenix TypeScript SDK](https://arize-ai.github.io/phoenix/modules/_arizeai_phoenix-otel.html)、[Docker 自托管](https://arize.com/docs/phoenix/self-hosting/deployment-options/docker)、[OpenInference](https://github.com/Arize-ai/openinference)。

## 后续 Run HTTP 覆盖

独立 Run 入口已接入同一追踪边界，不采集调用方消息或附件正文。新后台的本机 HTTP Phoenix 链接已修复；受控本地地址、独立权限、正文不采集策略不变。

显式设置测试数据库 `TEST_DATABASE_URL` 并运行 `PHOENIX_ACCEPTANCE_INCLUDE_RUN_API=true npm run verify:phoenix --prefix server` 可额外验收真实 HTTP／隔离 schema 的 Run 执行树。该开关默认关闭，开启但缺少测试数据库会拒绝验证，不静默跳过。数据库测试不修改已有业务记录；本轮扩展读回 21 条执行树、217 个 span，默认原能力验收仍为 9 条执行树／127 个 span。当前全量后端 441 项通过；此前 592 个 span 的重启留存是历史验证记录，不是当前累计入库总数。
