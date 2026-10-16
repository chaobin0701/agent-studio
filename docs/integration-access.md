# 接入管理（第一版）

面向接入开发者的文档：[Agent 接入文档](integration-api.md)。浏览器入口为 `/docs/integration`，可下载同一份 Markdown。本文保留管理、实现及运维说明，不再在接入管理面板内维护示例。

后台入口：`/admin/integrations`。默认只有超级管理员拥有 `integrations.read` / `integrations.manage`；可以通过角色授权。

所有接入复用现有 Agent、工具、记忆和模型配置。第一版不按应用分别配置知识库或人设，不是模型 API 透传，也不是 OpenAI Chat Completions 格式的代理。

## 1. 两种接入方式

| 场景 | 凭证 | 身份 |
| --- | --- | --- |
| 授权网站 / 嵌入式助手 | 公开 appId → 短期访客令牌 | 服务端确定匿名访客身份，不接受 userId |
| 平台服务端 / Agent 转接 | 平台 API Key | 接入平台提供可信的 userId |

域名白名单是浏览器访问控制，不是强身份认证：非浏览器客户端可以伪造 Origin。匿名网站必须配合限流；有登录要求的场景应由网站服务端持有 API Key，通过可信的登录身份调用，不能把永久密钥放在 JS 中。

应用 → 用户 → 会话 → 运行 / 轨迹。相同 userId 在不同应用内是不同用户。密钥轮换不改变应用与用户的会话归属。调用者只可读取、继续或删除自己的会话。

## 2. 管理操作

- 新建应用，开启网站 / 平台通道。
- 网站填写完整 Origin，例如 `https://www.example.com`。精确匹配协议、主机和端口；不接受通配符、路径、查询参数或账号密码。HTTP 仅允许本地回环开发。
- 选择 `chat:write`、`conversations:read`、`conversations:delete`；平台汇总用量查询另需 `usage:read`。这些权限不授予后台或原始调试上下文访问能力。
- 平台密钥的权限必须是应用权限子集。密钥明文仅创建 / 轮换时返回一次，服务端只保存随机高熵密钥的 SHA-256 摘要和脱敏展示。
- 可以指定密钥到期时间，撤销或轮换密钥；轮换原子地撤销旧密钥并签发新密钥。撤销、过期或应用停用会拒绝新请求，已在执行中的请求不强制取消。
- 停用保留历史资源。应用配置变更会使已有网站短期令牌失效；重新换取令牌即可。管理操作写入审计记录，不记录完整密钥。

默认官网应用 ID：`00000000-0000-4000-8000-000000000001`。迁移将既有官网访客、会话和轨迹绑定到它；首次启动用 `ALLOWED_ORIGINS` 初始化域名，之后后台配置优先，不覆盖管理员的修改。

## 3. 平台接口

```http
POST /api/v1/agent/messages
Authorization: Bearer <平台 API Key>
Content-Type: application/json
Idempotency-Key: <每次新请求唯一，重试复用同一个>
```

```json
{
  "userId": "your-trusted-platform-user-id",
  "message": "请介绍当前产品",
  "stream": false
}
```

首个问题被接纳时创建会话；后续消息增加 `conversationId`。输入 2–2000 个字符；不接受客户端构造的 assistant 历史、系统提示词或工具返回值。输出：

```json
{
  "conversationId": "conversation-uuid",
  "runId": "run-uuid",
  "traceId": "trace-uuid",
  "status": "completed",
  "answer": "…",
  "refused": false,
  "citations": [],
  "usage": {
    "inputTokens": 1000,
    "outputTokens": 100,
    "totalTokens": 1100,
    "reservedTokens": 0,
    "unknownModelCalls": 0,
    "accounting": "actual",
    "includesSummary": false
  }
}
```

同一应用、用户、Idempotency-Key 的已完成请求返回同一结果，不再次调用模型或计入应用配额。修改问题或输入 conversationId 后复用同一个 key 返回 409；运行中的请求返回 409；失败 / 过期后使用新的 key 重试。删除会话后原请求不能重放。无 key 时服务端生成随机值，调用方应主动提供 key，尤其是首条消息。

`stream: true` 返回 SSE：`run_started` → 可选的 `commentary_started` / `commentary_delta` / `commentary_completed` 和公开 `progress` → `answer_started` → 原生 `answer_delta` → `answer_completed` → `done`。每个工具批次的模型公开说明在工具开始前按同一 ID 分段发送，例如 `commentary_delta` 的数据为 `{"id":"planner-1-commentary","text":"我先查看"}`，应独立显示，不拼入答案。它不是内部推理，也不是工具执行结果；不要据此判断步骤已成功。原生工具参数、内部调用 ID 和未解析 JSON 不进入客户端。不同决策可能跳过部分事件（例如直接回答或拒答）。`done.progressEvents` 和历史消息保留合并后的公开过程；重放只返回完成结果，不伪造逐字流。流开始后失败发 `error`；`model_protocol_error`（502）表示模型响应协议异常，不是业务拒答。连接断开不表示取消执行，可通过运行接口恢复状态。

POST SSE 使用 `fetch` / `ReadableStream`，而不是只支持 GET 的浏览器 EventSource。

其他接口（同一 Bearer 凭证）：

```http
GET    /api/v1/agent/conversations?userId=...
GET    /api/v1/agent/conversations/:id/messages?userId=...
GET    /api/v1/agent/conversations/:id/runs?userId=...
DELETE /api/v1/agent/conversations/:id?userId=...
```

平台调用必须提供 userId；网站访客不能提供 userId。404 不披露其他用户 / 应用的会话是否存在。401 表示凭证失效，403 表示权限 / 域名 / 通道不允许，429 表示限额，400 表示请求格式错误。

## 4. 网站访客接口

```http
POST /api/widget/session
Content-Type: application/json
Origin: https://authorized.example
```

```json
{ "appId": "your-application-uuid" }
```

返回 `{appId, accessToken, resumeToken, expiresIn: 900}`。用 `accessToken` 作为 `/api/v1/agent/*` 的 Bearer 凭证。它固定应用、访客、Origin 和授权版本，15 分钟有效，不能替代管理员令牌。浏览器会自动发送 Origin；同源 GET 的 Origin 缺省时服务端同时核对 Fetch Metadata 和页面来源。

刷新 / 令牌过期后重新请求 session，附带之前的 `resumeToken`，即可保持同一访客。恢复凭证有效期 7 天，续接时顺延。它也是私有凭证，应仅保存在该网站浏览器中、不要分享或写入日志；XSS 可窃取浏览器凭证，需做好站点 CSP / 内容转义。第一次获取令牌不创建会话。

旧官网 `/api/chat/conversations/*` 保留 HttpOnly Cookie 和已有会话。默认官网域名、通道、权限与 Agent 调用配额同样生效。旧 `/api/chat` 和 `/api/chat/stream` 现在也走持久化会话和限额；客户端传入的非空 history 不再支持，请使用会话接口续接。平台 API Key 不允许访问旧网站路由。

## 5. 配额与统计

- 应用每分钟请求数、同时执行数、每日请求数在 PostgreSQL 事务内锁定检查，避免并发绕过；每日按 Asia/Shanghai 自然日。
- 单个匿名访客最多 10 次 / 分钟、平台用户最多 30 次 / 分钟，同时受应用和密钥上限约束；创建访客凭证另有每 IP 20 次 / 分钟限制。
- 官网仍受部署的 IP 限流。平台不按共同出口 IP 限流，但与官网共享进程级的昂贵工作并发上限；水平扩容时每实例这一上限独立，应用配额依然由数据库统一限制。
- 失败请求也占已接纳的请求配额；完成、失败释放并发槽，失联请求的 5 分钟租约到期后释放。日配额记录不因会话删除而重置。
- 后台展示今日请求、完成、失败、活跃数、Token 和最近 20 次调用元信息。每日 Token 限制由 `dailyTokenLimit` 设置（正整数，最大 1,000,000,000,000）；`null` 表示不限制，既有应用默认不限制。更新时省略该字段保留已有配置，显式 `null` 才取消限制。
- 第一版只增加每日 Token 配额，不增加每分钟 Token、单请求或月度 Token 配额。单次模型输出继续由模型服务配置控制，不因余额少而偷偷缩短回答。
- 每次模型调用（Planner、最终回答、实际重试、会话摘要）在 PostgreSQL 应用行锁下预留完整输入的保守 UTF-8 估计和模型输出上限，返回后按 Provider usage 结算；输入包括系统提示词、历史、工具参数与结果、工具定义，不只是用户问题。计量表不存储这些内容。Embedding 不计入 LLM 配额。
- 这是资源控制而非答案正确性校验，不改变模型自主选择直接回复或调用工具。预算不足时不启动下一次模型调用，也不生成业务拒答；SSE 开始前返回 HTTP 429，开始后发送 `error`。
- 超时/断流/用量缺失不视为零消耗：未知总量按预留量计入并标为不完整；若只缺输入/输出明细则保留已知总量并提示不完整。过期预留不会丢弃未知成本；迟到的真实用量可幂等结算。明确的认证、限流或参数拒绝不计模型 Token。历史记录仅保留已有已知总量，标记 `legacy`，无法补回未记录的费用。
- 每次模型调用按开始时的北京时间自然日归属配额，跨午夜结算仍归原日；午夜后新调用使用新一天额度。异步摘要归属发起请求的应用，本次响应 usage 是当时快照，统计可随摘要完成更新。此统计不是供应商账单或金额配额；保守输入估计可能提前限制调用。
- 会话管理新增应用筛选和来源显示，仍可复制会话 / 轨迹 ID 交给管理员调试；接入凭证不能读取完整模型请求、系统提示词或原始轨迹。

## 6. 验证

```bash
cd server
npm test
# 指向可创建临时 schema 的测试数据库（不能把密码写入提交文件）
TEST_DATABASE_URL=<database-url> node --test test/integration-access.test.mjs

cd ../chat
npm test
npm run build
```

隔离数据库测试验证迁移及回滚、权限、跨应用 / 用户、首条消息幂等、SSE、限额、密钥生命周期和审计。`server/scripts/check-integration-access.mjs` 使用内存管理员令牌做真实浏览器验证，创建唯一临时应用，测试真实模型 SSE、复制提示、统计、轮换、撤销和响应式布局，最后只清理该应用的测试资源。不保存完整接入密钥到截图、磁盘或日志。

开发环境 `http://localhost:8848` 热更新，API 3000，Docker 仅运行数据库。生产部署需要应用 SQL 迁移 `0030_integration_access.sql` 和 `0031_integration_token_quota.sql`。

## 7. 健康、可用状态与用量

```http
GET /api/health
GET /api/v1/agent/status
GET /api/v1/agent/usage
Authorization: Bearer <网站访客令牌或平台 API Key>
```

`health` 无需认证，延续基础服务/数据库检查，不调用收费模型。后两个接口需要接入凭证，使用 `Cache-Control: no-store`，不计聊天配额；另有每访客/密钥合计 60 次/分钟的查询保护，超限返回 `inspection_rate_limit`。它是每实例防滥用限制，不是可配置业务配额。

`status` 返回 `service`、`canSend`、`code`、`retryAt`、`checkedAt`、`modelHealth: "not_probed"`。它检查授权与应用请求、并发、每日 Token 可用情况，不返回流量明细或内部配置，也不保证下一问题完整预算一定足够。应用/通道停用和凭证失效仍返回 401/403；数据库异常不伪造 ready。

`usage` 的返回范围：

- 网站：`scope: "visitor"`，仅当前令牌绑定访客的今日请求与模型用量，`tokenLimit` / `remainingTokens` 为 null，不泄露应用汇总；传入 userId/appId 不会改变查询范围。
- 平台：应用和密钥均需 `usage:read`，`scope: "application"`，仅所属应用汇总；无需 userId，不能跨应用查询。
- 两者含 `startAt`、`resetAt`、`timezone`、`requests`、`completed`、`failed`、`running`、`inputTokens`、`outputTokens`、`totalTokens`、`reservedTokens`、`unknownModelCalls`。平台另显示实际 `tokenLimit` 和扣除预留后的 `remainingTokens`。

限额错误码：`daily_request_quota_exceeded`、`daily_token_quota_exceeded`、`daily_token_budget_insufficient`、`token_budget_reserved`、`concurrency_limit`、`request_rate_limit`。预留占用/并发繁忙是临时状态，重试时间不同于每日额度的午夜重置时间。

JSON 沿用统一错误结构，例如：

```json
{ "error": { "code": "daily_token_quota_exceeded", "message": "今日 Token 额度已用完，请明日再试或联系管理员。", "retryAt": "2026-10-08T16:00:00.000Z" }, "requestId": "..." }
```

HTTP 429 同时返回 `Retry-After` 秒数；SSE `error` 为 `{status:429,code,message,retryAt}`。前端初始化时查询 status，在普通结果/SSE done 中读取本次 usage，必要时刷新 usage；不要每个 token 查询一次，也不要在配额不足时自动重发。

## 8. 官网共享额度条

官网完整助手和悬浮窗口使用现有 HttpOnly 访客 Cookie，不重新创建 widget 访客或向浏览器放入平台密钥。为旧会话提供同源适配：

```http
GET /api/chat/status
GET /api/chat/usage
GET /api/chat/quota
```

前两个复用 `publicStatus` / `publicUsage`，`usage` 仍只返回当前访客个人用量，Token 上限保持 `null`，与 `/v1/agent/usage` 的隐私边界一致。`quota` 是按产品需求明确公开的**当前官网接入应用共享预算**：只返回今日请求次数/上限/剩余、Token 已用/预留/上限/剩余、不完整计量数量、北京时间重置时间，不返回其他应用、用户/会话身份、模型上下文、密钥、白名单或权限配置。共用额度仍包含该应用的所有调用，不是每个访客独享。

这三个接口均由 `LegacyWebsiteGuard` 校验网站应用、Origin 和读取权限，再从服务端 Cookie 解析访客归属；平台 API Key 不可使用这些官网接口。采用同一每访客 60 次/分钟查询保护、`Cache-Control: no-store`，不创建空会话或调用模型、不消耗聊天请求配额。

前端标注“官网共享”，提供一个细进度条：Token 上限有限时展示 `(已用 + 预留) / 上限`，未设置 Token 上限时明确显示“不限”并使用次数占比。进度不超过 100%；未知模型用量显示保守估算提示，不等于供应商账单。查询失败不显示零额度、不据此锁死发送。初始化、每轮结束、运行恢复完成时刷新并合并请求；零点和临时状态的重试时间到达时查询，不按 token 轮询或自动重发问题。本轮 SSE/JSON 的 `usage` 另存为当前响应快照，不把多次快照累加成共享总量。
