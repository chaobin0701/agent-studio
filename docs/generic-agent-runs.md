# 独立 Agent Run 接口

独立任务入口不创建隐式会话，不依赖浏览器 Cookie、客服、产品或知识库。它与所有 Chat 执行路径复用 `AgentExecutionService → DeepAgentExecutionService → Deep Agents / LangChain / LangGraph`、发布快照、能力授权、模型尝试账本和接入应用准入；不是另一套 Agent 内核。开发位于独立 worktree，主项目尚未切换；静态执行回退、旧运行时注册及全部重复通用内核源码/测试参考已清理，见 [Chat 入口](native-chat-entry.md)。

## 调用与权限

- `POST /api/v1/agent/:agentId/runs`：同步 JSON，或 `stream=true` 的 SSE。
- `GET /api/v1/agent/:agentId/runs/:runId?userId=...`：查询当前身份的执行状态／最终结果。
- 使用已有平台 API Key。Agent ID 必须与接入应用绑定一致；不接受网站访客令牌或管理员登录令牌。
- 执行复用 `chat:write`；查询复用 `conversations:read`，不新增重复权限体系。API Key 和应用权限均需允许。
- `userId` 是平台接入方提供的稳定用户标识，必填。不需要 `conversationId`。现有身份表用于归属隔离，不创建会话或历史消息。
- 工作区由认证应用决定，不由调用者的消息、请求体或工作区 Header 指定。

```http
POST /api/v1/agent/123/runs
Authorization: Bearer <平台 API Key>
Idempotency-Key: report-20261014-001
Content-Type: application/json

{
  "userId": "application-user-42",
  "task": "根据已授权资料整理一份简短报告。",
  "messages": [
    {"role": "user", "content": "这是由接入方明确提供的历史内容。"},
    {"role": "assistant", "content": "此前结果。"}
  ],
  "attachments": [{"kind": "document", "id": "456"}],
  "limits": {"maxModelCalls": 8, "maxToolCalls": 4, "maxDurationMs": 60000},
  "stream": false
}
```

Agent 无知识库时省略 `attachments` 即可执行。新后台的执行详情展示“独立任务”入口和本地 Run ID；会话 ID 显示“无会话”。原有 `/messages`、会话、官网和渠道接口保持兼容。

## 输入与快照

任务 1–2000 字；消息最多 30 条，每条 1–2000 字。允许 `user`／`assistant`，不接受 `system`／`tool`、工具调用声明或伪造工具结果。

- 提供 `task` 时，`messages` 是调用方明确传入的历史。
- 未提供 `task` 时，最后一条必须是用户消息，并作为当前任务；此前消息作为历史。
- 接口不自动持久化为会话记忆、不自动摘要，也不把历史和附件传给成员 Agent／隔离 Skill。
- 服务端固定当前生效 Agent、成员、Prompt、实际模型方案及索引版本。请求体不能替换版本、权限、系统指导、凭据或工具列表。
- 可选 `outputSchema` 描述 `structured` 的 JSON Schema，根类型必须为 object；最多 12000 字符、10 层、1000 节点，禁止外部/递归引用、pattern 编译和原型键。标准 LangChain 输出策略会校验结果，失败不自动补调模型、不重放工具；未提供时可以直接输出原生文本，不强制结构化协议。

## 文档附件

当前支持知识库文档引用，最多 5 项。**不接受外部 URL、本地路径、任意文件下载或客户端提供的文档正文／检索结果。**

文档必须属于入口 Agent 授权的知识库，且包含在请求固定的可用索引中。引用按实际索引分块解析，来源位置保留；兼容既有无发布索引的显式 live 范围。每份最多读取 24 个有序分块，再按 Agent 的知识上下文上限分配内容预算，模型上下文治理还可能压缩。不承诺整份长文档都进入单次模型请求。

执行前、原生文件读取/搜索时再次检查知识库、文档的当前可用状态。切换索引不替换已固定内容；停用、归档或删除仍能阻止读取，回滚不能绕过状态。宿主附件解析不伪造工具事件；模型实际调用 `read_file` / `grep` 等原生工具则计入共享工具预算，不额外调用向量模型，也不改变 Agent 检索策略。

## 执行上限

| 字段             | 约束                                                    |
| ---------------- | ------------------------------------------------------- |
| `maxDecisions`   | 入口图决策轮数，最多为发布配置；可收紧到 1              |
| `maxToolCalls`   | 共享的实际工具尝试上限，包括成员／Skill／重试，可设为 0 |
| `maxModelCalls`  | 共享的实际模型尝试上限，包括重试与备用模型              |
| `maxTotalTokens` | 共享 Token 上限，保守预留后按用量结算                   |
| `maxDurationMs`  | 整体期限，最多 180000 ms                                |

请求只可收紧已发布约束。成员保留自身图／工具约束，并共享父级次数、Token 和期限。未指定时复用现有执行服务的默认预算；发布协作配置的预算更优先。超限不会增加一个“回答模型”调用或自动重开任务。

## 结果、事件与计费

JSON／SSE 最终结果包含：`runId`、`traceId`、`agentId`、`agentVersionId`、`status`（`completed`／`refused`）、`answer`、可选 `structured`、`artifacts`、`references` 和 `usage`。不返回原始图状态、模型请求、系统 Prompt、工具参数、凭据或追踪跳转 URL。

`usage` 来自已有模型尝试账本，而不是把子图用量重复累加作为费用。拒绝回答是已结束的正常结果；异常、取消和超时保存为失败。请求父追踪覆盖结果持久化和计费完成；若计费完成失败，保留已付模型用量并更新失败 Trace，不再次调用模型／工具。未知供应商费用不会因为断流而免费释放。

SSE 使用 `run_started`、`answer_delta`／`answer_reset`、`progress`、公开 commentary、`retry_status`、`done` 或 `error`。`done` 是唯一的最终结果，文本增量仍是临时内容；重放只发送开始及最终结果，不重新生成增量。关闭连接取消同一执行图，不重启任务。

## 幂等与历史

建议始终发送稳定的 `Idempotency-Key`。应用＋用户＋Key 唯一，指纹包括 Agent、任务、消息、附件、限制及可选输出 Schema；SSE／JSON 只是传输方式，不改变指纹。未提供 Schema 的旧指纹保持兼容；Chat 与 Run 使用不同指纹，不能串用缓存。

- 完成请求重复提交：返回原结果，不重新调用模型／工具或计费。
- 相同 Key、不同输入：409。
- 正在处理、失败或过期的 Key：409，不自动恢复／重放写操作。
- 使用新 Key 是一次**新的业务执行**，不保证外部写操作恰好一次；写工具仍需要自身幂等与批准策略。

查询仅返回当前应用、当前用户的 Run；不返回其他应用、用户或会话调用的结果。成功／失败本地 Trace 使用已有表中可空会话字段，业务账本沿用 `integration_calls`／`integration_model_calls`，本次没有新增数据库迁移。

## 追踪与验证

Phoenix 继续只采集版本／运行 ID、计数、耗时与错误分类，不采集调用方消息、附件正文或模型／工具正文；链接仍走独立管理员权限接口。新后台接受受控本地 HTTP／HTTPS Phoenix 地址，拒绝公共云、凭据 URL 和脚本 URL。

自动化测试：`server/test/agent-run.test.mjs` 使用真实 HTTP、LangGraph、平台快照服务、SDK 和隔离 PostgreSQL schema。模型为确定性替身。覆盖单／多 Agent、历史隔离、固定索引、附件生命周期、共享限额、幂等、计费、断流、期限和旧 Chat 准入兼容。

```sh
npm run build --prefix server
# 显式设置 TEST_DATABASE_URL 后；只建立／删除随机测试 schema。
node --test server/test/agent-run.test.mjs server/test/phoenix-admin-link.test.mjs

# Docker Phoenix 已启动；显式包含隔离数据库／Run HTTP 真实追踪读回。
PHOENIX_ACCEPTANCE_INCLUDE_RUN_API=true npm run verify:phoenix --prefix server
```

真实供应商验证脚本现已调用 `runTask`：`AGENT_ACCEPTANCE_ENV_FILE=/安全路径/验收.env AGENT_ACCEPTANCE_PHOENIX=true npm run verify:agent:live --prefix server`。它会消耗模型 Token，只读已有模型配置；无业务依赖与只读算术工具两项已通过。它不是正式 HTTP／生产准入的真实供应商联调，也不代替最终独立部署验收。

页面交互由用户测试；主项目服务未切换、未重启。后续继续完成整体入口清理、能力管理核对和独立部署验收，不把本次 Run 入口交付当作整个重构完成。

最新验收：全量后端 **473 项通过、0 失败、0 跳过**；后端／旧 web／网站构建，以及新后台类型检查／构建通过。包含原生 Chat、Run HTTP、Tool/MCP 与检索的 Phoenix 真实读回为 **26 条执行树、158 个 span**（确定性模型）；真实供应商的两项只读验证另行读回 9 个 span。阶段细节与未完成项见 [Deep Agents 迁移](deep-agents-migration.md)。

上述为原生执行服务接入阶段记录。模型 SDK 替换后最新基线为 **484 后端测试通过、0 跳过**，Phoenix 含 SDK 适配/Run/Chat 验收读回 **27 条树、161 spans**。正式入口仍复用同一安全、版本和账本服务；SDK 协议、流式取消、显式用量开关与真实供应商验收见 [模型 SDK](model-sdk-adapter.md)。
