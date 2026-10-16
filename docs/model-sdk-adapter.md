# 模型 SDK 接入与治理边界

## 当前实现

LLM 运行时使用固定版本 `@langchain/openai@1.6.2` 的 `ChatOpenAI`，底层官方 OpenAI SDK 在 lockfile 中固定为 `7.32.0`，共享 `@langchain/core@1.2.17`。不是在旧 HTTP 适配器外面再包一层 SDK：旧手写 HTTP 请求、SSE 帧解析和流式用量参数自动协商已删除，原导入路径仅重导出同一个实现。

调用关系：

```text
Deep Agents / 内部摘要
  → 受治理的 LangChain ChatModel
  → LlmService（唯一重试、主备、额度、预算及账本权威层）
  → LangChainOpenAIProvider（固定配置和标准消息的薄适配）
  → ChatOpenAI / 官方供应商 SDK
```

这不是多层 Agent 循环，也不固定增加规划、修复或最终回答模型调用。`ProviderRegistry`、模型方案路由和管理测试都使用 SDK 实现。管理协议仍叫 `openai-compatible`，已有供应商/部署/方案及历史 ID 不需迁移。

依据：[ChatOpenAI 标准消息、工具、流和自定义地址](https://docs.langchain.com/oss/javascript/integrations/chat/openai)、[官方 SDK 重试/超时配置](https://github.com/openai/openai-node)。实际兼容性仍以所选供应商的三项协议测试为准，不能仅根据 API URL 判断支持所有功能。

## 保留与移除

| 保留                               | 移除／替换                              |
| ---------------------------------- | --------------------------------------- |
| 供应商、部署、方案发布与回滚       | 手写 Chat Completions HTTP/SSE 执行器   |
| 请求固定版本、连接参数及授权       | SDK 默认重试、隐式协议协商              |
| 当前凭据查找与主备顺序             | 根据环境变量替换显式账户/地址           |
| LlmService 尝试账本、预算和取消    | SDK 默认日志及隐式 LangSmith 上传       |
| 统一 Provider 错误与短脱敏诊断     | 原始 SDK 错误、响应正文及认证头公开展示 |
| 模型测试阶段、Token 上限与能力检查 | 结构化失败后去掉约束或自动补调模型      |

LangChain AsyncCaller 与底层 SDK 均为 `maxRetries=0`。一次 Provider 调用对应一次实际请求；由 LlmService 决定是否重试、切换主备和结算。部署超时覆盖等待响应头与流式正文；关闭迭代器先取消请求，再等待 SDK 清理读取器。重定向不跟随，响应字节上限 4 MB。

只投影文本、原生 Tool ID/参数、结束原因及真实用量；推理字段和 typed thought 块不作为公开答案，推理 Token 仍计入实际总用量。参数对象只保留窄兼容归一化，不新增标准 JSON/SSE 解析器；无效/重复调用 ID、错误 JSON 和超大响应直接失败，不能执行工具。

## 流式用量兼容选项

新后台的 LLM 部署表单增加 **流式返回 Token 用量**，复用 Element Plus Switch/Tooltip，不增加基础组件。向量部署不显示这个选项。

- 配置字段：`streamUsage: boolean`，旧配置缺省为 `true`。
- 不支持 `stream_options` 的供应商：测试直接失败并展示脱敏诊断；管理员关闭该选项后重新测试，不自动增发请求。
- 修改部署不会改变已发布方案的快照；构造新方案版本、测试并发布后，才供新任务使用。
- 关闭时，供应商仍返回的合法用量照常记录；缺失用量明确为未知，不能填 0 或用 Tokenizer 估算冒充供应商账单。
- 中断或未知用量保持平台保守预算/额度约束；保守预留是治理数据，不是实际供应商收费数。

内部 LangChain 版本和适配实现版本记录到 Phoenix 的 `modelAdapterVersion`，不只记录模型方案 ID。SDK 参数、消息、原始推理、凭据和响应正文不上传。组织/项目/地址显式配置，不继承 ambient OpenAI 配置；SDK 日志关闭，即使宿主设置 debug。框架自动埋点仍是后续阶段，当前由统一 metadata-only 手动 Span 覆盖实际模型尝试。

## 验证证据（2026-10-14）

- 全量后端 **484 通过、0 失败、0 跳过**，含隔离 PostgreSQL/RLS、模型发布/回滚、主备、凭据轮换、Run/Chat 和共享账本。新增 SDK 测试 11 项；旧模型测试夹具改为真实媒体类型/消息角色和标准 Headers 读取，没有放宽协议断言。
- 新后台类型检查/构建和根后端/旧后台/网站构建通过。`git diff --check` 通过，页面由用户测试。
- 真实模型方案 **12**：无资源任务 1 次模型、2021 Token、3 个已入库 span；只读工具＋标准结构化结果 2 次模型/1 次工具、4759 Token、结果 423、6 个已入库 span。
- 真实供应商结构化、工具和流式测试通过，恰好 3 次请求。真实取消只发起 1 次请求，只预留/结算一次，未知用量未当作零；取消树 2 个 span 从本地 Phoenix 读回。这是只读源配置的供应商验证，不是已上线生产 HTTP 验收。
- 包含 SDK 适配、正式 Run HTTP 和能力链的 Phoenix 确定性验收读回 **27 条树、161 个 span**，确认模型实现版本、父子链、实际 Token、错误和默认无正文。无重复 LLM span。
- 主项目五项服务继续 online、PID 未变化；未迁移主库、重启 API/worker 或消费主队列。依赖 audit 仍为 7 项已知风险（4 high、3 moderate），未因 SDK 接入消失，仍须评估上线门槛。

显式复验（真实模型会消耗 Token，密钥只放本地环境）：

```sh
npm run build --prefix server
node --test server/test/langchain-provider.test.mjs
# 仅使用隔离测试 Schema；显式配置 TEST_DATABASE_URL 等测试开关后执行全量测试。
AGENT_ACCEPTANCE_ENV_FILE=/安全路径/验收.env AGENT_ACCEPTANCE_PHOENIX=true npm run verify:model-sdk:live --prefix server
```

## 整体重构仍在进行

供应商 SDK 这一阶段已落地，不代表整体任务完成。后续 [Skill 辅助资料阶段](skill-resources.md) 已补齐版本化文本资料与只读运行；仍需清理旧静态入口/通用内核和迁移参考、受控文件产物、metadata-only 自动埋点、专项 LangGraph 接口、完整渠道/可选业务边缘以及隔离数据库/队列部署。不能以 SDK 单元测试替代最终端到端和安全验收。
