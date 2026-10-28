# Phoenix → LangSmith 开发计划

核实日期：2026-10-28。开发分支：`feat/langsmith-tracing`。

本文件保留核实后的原计划。当前实现与验收边界见 [LangSmith 追踪](langsmith-tracing.md)。

## 核实结论

- 当前链路为显式业务埋点 → 请求局部 OpenInference 回调 → Phoenix 私有 OpenTelemetry Provider → 有界 OTLP/HTTP Protobuf 队列。无需重写 Agent、Prompt、模型调用或 Tool/MCP 执行逻辑。
- `execution-tracer.ts` 已覆盖执行父子关系、资源版本、重试、Token、错误分类和等待交互；`framework-callbacks.ts` 在回调进入 SDK 前剔除正文，框架 span 不重复统计模型 Token。
- LangSmith 官方 OTLP 文档列出了 OpenInference 类型、模型、Token、metadata 的映射，因此可复用埋点和脱敏回调；新增明确的 LangSmith 类型及会话标识映射，并做协议验收。
- LangSmith 当前区分 project-based 与 agent-based workspace。前者使用 `Langsmith-Project`；后者要求成对的 `Langsmith-Agent-Id` 与 `Langsmith-Agent-Environment`，两种地址不得混用。LangSmith 目标工作区与本平台业务工作区是不同概念。
- 现有配置默认启用本地 Phoenix，认证为 Bearer；LangSmith OTLP 使用 `x-api-key`，需要替换出口、认证及目标路由，不能仅替换 URL。
- 普通运行详情中的外部入口受 `observability.external.read` 和所选业务工作区的 `conversations.read` 双重约束；当前后台没有独立的追踪配置表单。继续使用部署级配置，不另建密钥管理页面。
- `contextSnapshot.phoenix` 写入分散于 Chat、Run、Deep Agents、工作流测试及后台摘要。部分关闭对话正文记录的路径用 `safeTraceMetadata()` 过滤整个快照，可能丢失嵌套追踪映射；迁移需单独保留安全映射。
- 现有目录约定要求本地 Phoenix 并禁止云追踪；用户已经明确要求迁移到 LangSmith。实施时同步调整相关 AGENTS 及文档，仅允许显式配置的脱敏导出，保留禁用框架隐式正文上传的限制。

## 第一阶段：配置与导出适配

主要文件：`server/src/config/tracing-config.ts`、`server/src/observability/execution-tracer.ts`、`phoenix-exporter.ts`、`tracing.module.ts`、`server/package.json`、根 `.env.example`。

1. 使用通用追踪类型及私有 OpenTelemetry Provider 替换 Phoenix 专用注册；复用现有标准 OTLP 序列化与有界队列。保留 OpenInference 脱敏回调依赖，不为改名重写已验证的框架桥接层。
2. 使用平台专属前缀配置启用状态、Key、区域 API 端点、目标工作区、project 或 agent/environment、采样、超时和队列。避免设置可触发 LangChain 自动上传的全局 `LANGSMITH_TRACING`。
3. 默认关闭。显式开启时要求凭证及完整目标；关闭时不要求 Key、不创建导出器。配置错误只报告字段，不输出值。
4. 支持官方区域 HTTPS 端点；自托管地址按部署配置显式校验。不继承通用 OTEL headers、URL 或请求传入的地址，不跟随重定向。
5. 正确处理 OTLP 成功响应及部分拒收；发送失败、超时、队列满不影响执行、权限、配额和计费。

交付：可由本地协议接收器验证的新导出器；此时不需要真实 LangSmith Key。

## 第二阶段：执行映射与多轮会话

主要文件：`execution-tracer.ts`、`framework-callbacks.ts`、`chat/conversation.service.ts`、`executions/agent-run.service.ts`、`executions/workflow-test.service.ts`、`ai/deep-agents/deep-agent-execution.service.ts`。

1. 保留实际模型尝试唯一统计 Token 的原则；显式映射 chain/llm/tool/retriever/embedding 与安全 metadata。
2. 每次执行仍有独立 trace；将已有 `conversationId` 映射为 LangSmith `thread_id`，传递到所有后代 span，便于按会话查看多轮执行。无会话 Run 不创建隐式会话。
3. 新增带 schema 版本及 provider 标识的通用外部追踪映射，保存目标与安全 ID；禁止保存 Key 和任意可点击 URL。
4. 对话正文关闭时，若允许保存本地 Trace，则仍保留安全外部映射。现有记录开关不自动变成云端正文采集授权。
5. 不修改历史消息、请求体、幂等指纹或执行数据；旧 Phoenix 映射不冒充 LangSmith 追踪。

交付：Chat、Run、工作流、协作成员、Tool/MCP、检索/向量及异步摘要共用同一映射契约。

## 第三阶段：后台入口与权限

主要文件：`observability/admin-execution.controller.ts`、`execution-view.ts`、`phoenix-link.ts`、`chat/admin-chat-trace.controller.ts`、后台 `api/executions.ts`、`api/phoenix-link.ts`、`views/executions/detail.vue`。

1. 在现有运行详情内替换 LangSmith 入口及说明；不新增一套执行管理页面。
2. 使用 provider 中立的读取端点，沿用平台级及业务工作区双重权限。
3. 只根据受信部署目标与已保存 ID 构造链接；先核实 OTLP ID 到 LangSmith run ID 的映射。必要的目标/链接查询异步执行并缓存，不进入业务请求关键路径。
4. 区分关闭、未采样、目标已变更、尚未确认入库及入口不可用；不把 HTTP 接收成功显示成已入库。
5. 保留历史本地详情。旧 Phoenix 记录提示原追踪来源，不生成错误的 LangSmith 链接；普通和公开接口继续隐藏外部映射。

## 第四阶段：测试、文档和清理

1. 延续现有用例，替换 Phoenix 接收夹具；覆盖 headers、目标路由、Protobuf、空响应、部分拒收、超时、重定向和队列上限。
2. 覆盖真实 LangGraph/Deep Agents 回调、并发父子关系、MCP/HTTP Tool、模型重试、检索/向量、暂停恢复及后台摘要。
3. 注入敏感哨兵验证 Prompt、消息、工具参数/结果、文档及凭证均不进入 SDK 存储、导出载荷或日志；恶意 ambient LangSmith/OTEL 配置不能绕过显式出口。
4. 覆盖多轮同一 thread、无会话 Run、记录正文关闭后的追踪映射、跨工作区拒绝、历史映射兼容。
5. 运行后端相关/全量测试与构建；后台运行 `pnpm typecheck` 和 `pnpm build`。数据库集成测试沿用隔离 schema，不改开发业务记录。
6. 更新 AGENTS、追踪说明、验收脚本、环境示例及锁文件；移除 Phoenix 专用注册依赖和失效脚本，不删除原功能测试或追踪历史数据。

## 第五阶段：真实云端验收与部署准备

- 使用显式配置的 LangSmith 测试目标；agent-based workspace 的远端 Agent 需已存在，不由脚本自动创建或发布。
- 确定性模型替身执行一条包含模型、工具、错误/重试的链路，再执行同一会话第二轮；不消耗付费模型额度。
- 发送后轮询读取已存储记录，检查完整父子树、线程归属、Token、版本标识及敏感哨兵缺失。官方 OTLP 文档说明接收为异步处理，只看到 HTTP 200 不足以验收。
- 没有测试凭证时完成全部本地开发及验证，明确将云端读回列为未验收；不宣称迁移部署成功。
- 准备服务端配置和发布步骤；本阶段不自动部署生产、不停用或删除既有 Phoenix 数据，也不操作其他站点/反向代理。

## 核实基线

- 现有编译产物执行四组追踪相关测试：`execution-tracing`、`framework-tracing`、`phoenix-capabilities`、`phoenix-admin-link`，19 项通过、0 失败。
- 以上是本地回归测试，不是 Phoenix/LangSmith 真实服务入库验证。

## 官方依据

- [LangSmith OpenTelemetry 接入及属性映射](https://docs.langchain.com/langsmith/trace-with-opentelemetry)
- [LangSmith Agent 目标与环境](https://docs.langchain.com/langsmith/log-traces-to-agent)
- [LangSmith 多轮会话 Threads](https://docs.langchain.com/langsmith/threads)

本轮通过官方 Markdown 文档核实协议。更换用户提供的测试 Key 后，指定项目读取成功；同一会话两轮共 13 个合成 Span 已完成云端存储读回验收，包括父子关系、线程、Token、安全错误分类和隐私过滤。

## 实施结果

- 完成独立 OTEL Provider、专属配置、认证、互斥目标路由和有界导出器。
- 完成所有入口及异步摘要映射，关闭正文时保留安全关联；会话 thread 传递到后代。
- 完成后台入口、双权限、历史来源提示和只读链接解析。
- 保留原能力测试，新增迁移验证；移除 Phoenix 专用依赖和旧验收脚本。
- 已使用新测试 Key 完成项目访问及 13 个合成 Span 云端读回；修正查询页大小、错误事件和真实导航参数处理。未部署生产或删除历史数据。
