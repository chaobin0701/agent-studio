# LangSmith 执行追踪

2026-10-28，开发分支 feat/langsmith-tracing。

## 追踪边界

复用原有业务埋点和请求局部 OpenInference LangChain 回调，改由私有 OpenTelemetry Provider 导出至 LangSmith。没有重写 Agent、Prompt、Skill、Tool/MCP、模型、权限或用量账本。移除 Phoenix 专用 SDK；历史记录和 Phoenix 存储不迁移、不删除。

基础模式仅导出运行/会话 ID、资源版本、模型名称、次数、Token、耗时、状态及安全错误分类。内容追踪通过 `AGENT_STUDIO_LANGSMITH_CONTENT_ENABLED` 独立控制，默认关闭。开启后，用户消息、模型实际输入（含 system/developer Prompt、工具定义及检索上下文）、模型输出、Tool 参数与结果会写入 LangSmith Run 的 `input.value` / `output.value`，不写入 metadata。图片只记录 MIME、尺寸和字节数，不上传图片二进制。

内容模式会遮盖凭证字段（如 `apiKey`、`authorization`、`password`）及常见 Bearer、云凭证、GitHub、LangSmith、OpenAI 等 Token 格式。其余文本按原样保留；每个输入/输出字段最大约 4 MB，以适配 OpenTelemetry 属性限制。脱敏规则不能识别所有自然语言中嵌入的任意秘密，因此该模式应仅对确认可发往 LangSmith 的环境开启。此开关不受本地“允许记录”策略控制。

每次执行独立 Trace；同一会话的所有显式和框架 Span 都携带 thread_id。实际模型尝试唯一统计 LLM/Token，框架回调只记 CHAIN。人工等待不标记模型失败；异步摘要在业务父 Span 结束后仍保留父链和 dotted order。

contextSnapshot.externalTrace 保存 schemaVersion、provider、采样结果、OTLP Trace ID、LangSmith run/root run UUID 和目标摘要，不保存 URL 或 Key。关闭正文但保留 Trace 时仍保存安全映射。旧 phoenix 映射只标识历史来源，不伪造 LangSmith 链接。

## 配置

追踪默认关闭；只读取 AGENT_STUDIO_LANGSMITH_*，不继承 LANGSMITH_TRACING、LANGCHAIN_TRACING_V2 或通用 OTEL endpoint/headers。`CONTENT_ENABLED` 默认 false；设置为 true 才上传内容字段。完整示例见根目录 .env.example。

| 配置后缀 | 用途 |
| --- | --- |
| ENABLED | 显式启用，默认 false |
| API_KEY | 独立追踪 Key，不复用模型凭证 |
| ENDPOINT | 默认 https://api.smith.langchain.com，可填 API 根或完整 /otel/v1/traces |
| PROJECT | Project-based 目标，本轮使用 agent-studio-production |
| WORKSPACE_ID | 可选 LangSmith tenant/workspace UUID，通过 x-tenant-id 传递；不是平台数字工作区 ID |
| PROJECT_ID | 可选项目 UUID，配合 WORKSPACE_ID 生成直达入口；不改变导出项目 |
| AGENT_ID / ENVIRONMENT | Agent-based 目标，必须成对配置并清空 PROJECT；环境为 local/development/staging/production |
| WEB_URL | 自托管必填；官方云按区域推导 |
| SAMPLE_RATE / TIMEOUT_MS / QUEUE_LIMIT | 默认 1 / 2000 / 1000 |

远程仅 HTTPS，协议测试允许 loopback HTTP，不跟随重定向。远端 Agent 需已存在，不自动创建或发布。添加导航项目 ID 或轮换 Key 不使原有目标映射失效。API/worker 使用同一部署配置，Compose 已通过 env_file 传递；按正常流程执行数据库迁移并重建服务，不需要部署 Phoenix 收集器。

有界异步队列、有限超时、不重试、不等待业务响应；导出失败、部分拒收、超时和队列溢出不改变执行或账本。只保留内存计数，不输出远端原文。HTTP 成功仅表示接收，不能当作入库证明。

## 后台入口

复用原运行详情与 Element Plus ElLink，接口为 GET /admin/executions/:id/external-trace。要求平台 observability.external.read 和所选业务工作区 conversations.read 双权限，沿用工作区隔离。迁移 0065 仅更新权限说明，不新增授权。

链接由匹配目标的安全 ID 重建，或管理员读取时向 LangSmith 查询可信 app_path，不信任已存 URL。查询在业务执行之外并短时缓存。配置 UUID 的链接标记 ingestion: unverified，读回 run 后才标记 confirmed。普通运行/聊天/公开接口隐藏外部映射。Agent-based 新 UI 路径未验证时提示入口不可用，不猜测链接。

区分历史 Phoenix、未采样、关闭、目标变化、未入库、读权限不足和入口不可用。
管理员链接查询单独使用 10 秒超时，不复用导出的 2 秒预算；成功链接缓存 5 分钟，失败结果仅缓存 2 秒。前端区分凭证失效、限流、超时和链接解析失败，避免统一提示掩盖原因。

## 验收

本地：npm run build --prefix server，再运行 server/test 下的 execution-tracing、framework-tracing、tracing-capabilities、langsmith-migration、execution-view、langsmith-admin-link 测试。

合成云端验收：设置 AGENT_ACCEPTANCE_ENV_FILE 为绝对路径的专用测试 env 文件，执行 npm run verify:langsmith --prefix server。文件只保存在本机、权限 0600、不提交。

脚本发送同一会话两轮，覆盖失败/重试、Tool/MCP、检索和向量 Span，不调用付费模型、不修改业务数据库。读回检查树、线程、Token 和敏感哨兵。只有写权限时输出 ingestion: unverified / read_permission_required，不声称入库成功。

真实模型验收沿用 verify:agent:live、verify:deep-agent:live、verify:model-sdk:live，追踪开关改为 AGENT_ACCEPTANCE_LANGSMITH=true。这些脚本消耗 Token，仅专门授权后运行，要求读取权限完成持久化验证。

本轮已替换本机测试 Key，读取 agent-studio-production 项目成功（HTTP 200）。项目 UUID 为 ed0fc0aa-c29e-40c8-a260-73a3c9be37c6。合成验收两轮共 13 个 Span 全部读回，确认同一 thread、独立 trace、完整父子树与 dotted order、每轮 12 个模拟 Token、第一轮一次安全错误分类及重试；未包含敏感哨兵。无付费模型调用。早先 tracing-only Key 的 403 限制已解除。本分支不自动合并、部署生产、发布 Agent 或删除旧 Phoenix 数据。

云端验收同时发现并修正三处协议差异：runs/query 每页上限为 100；失败状态需发送仅含安全分类的 exception 事件；真实 app_path 带 trace_id/start_time 导航参数，后端校验后移除参数，返回固定 run 链接。

已用实际存储的 run 验证后台链接解析成功（ingestion: confirmed）；验收轮询等待云端异步索引的节点、Token 和错误字段齐全后再核对。

重复运行合成验收时目标 API 返回过 429；该次复验受远端限流影响，不推翻前一轮 13 个节点的完整成功读回。验收读取脚本遇到 429 按 Retry-After 作有界等待，业务导出仍不重试。

## 官方依据

- https://docs.langchain.com/langsmith/trace-with-opentelemetry
- https://docs.langchain.com/langsmith/log-traces-to-agent
- https://docs.langchain.com/langsmith/threads
- https://docs.langchain.com/langsmith/run-data-format

使用官方 Markdown 文档及已安装 SDK 的查询和链接实现核实协议；不启用 LangSmith SDK 全状态捕获。

## 最终本地检查

- 后端构建通过；全量默认套件 581 通过、0 失败，25 项需显式数据库开关的测试跳过。
- 另外使用隔离随机 schema 执行 Chat/Run/人工交互及追踪权限的真实 PostgreSQL/HTTP 集成测试：54 通过、0 失败、0 跳过。
- 管理后台 typecheck 和 production build 通过；按用户约定未做页面回访验收。
- 测试 Key 只在被 Git 忽略的本机专用 env 中，权限 0600；未提交、未部署。
