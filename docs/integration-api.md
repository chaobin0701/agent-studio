# Agent 接入文档

通过统一接口，把禾序智能客服接入网站或其他平台。支持会话续接、原生 SSE 回答、状态检查和每日用量查询。

接口版本：`v1`。以下地址、应用 ID、密钥和响应数值均为示意，请替换为自己的配置。

## 接入前准备

管理员在「接入管理」创建应用，开启所需通道，配置访问权限、频率、并发及每日配额。

| 场景 | 认证方式 | 用户身份 |
| --- | --- | --- |
| 网站浏览器 | 公开 appId 换取短期访客令牌 | 服务端绑定匿名访客，不传 userId |
| 平台服务端 | 平台 API Key | 从平台登录身份获取可信 userId |

约定 `API_BASE = https://support.example.com/api`，包含 `/api` 前缀；本地开发可通过 `http://localhost:8848/api` 访问代理接口。

- 网站：管理员提供 appId，并登记网站完整 Origin，例如 `https://www.example.com`。协议、主机、端口必须精确匹配，不支持路径或通配符；HTTP 只允许本地回环开发。
- 平台：管理员开启「平台 API」，创建并安全交付密钥。密钥只在创建或轮换时显示一次，应存放在服务端环境变量或密钥管理系统。
- 每个应用绑定所在工作空间的 Agent 与环境；配置、知识库、会话及文件按工作空间隔离，用户及会话另按接入应用归属校验。
- 这不是 OpenAI Chat Completions 代理。不接受客户端指定模型、工具、系统提示词或构造助手历史。

> 永久 API Key 不得放入网页、移动客户端包或公开仓库。域名白名单是浏览器访问控制，不等于登录认证；需要登录身份的业务，应由自有服务端持有密钥并校验用户。

### Agent ID 与发布环境

新接入推荐 `POST /api/v1/agent/:agentId/messages`，请求体及 SSE 事件与旧消息接口一致。`:agentId` 是 Agent 资源 ID，必须与接入应用绑定一致，错误 ID 返回 403。每个接入应用选择 Agent 和 dev / test / prod 环境，环境选择此 Agent 对应的已发布版本。客户端不能通过请求体或管理工作区请求头切换环境、Agent 或工作空间。旧 `/api/v1/agent/messages` 按应用绑定执行，继续兼容。

## 网站浏览器接入

### 1. 获取访客令牌

```http
POST /api/widget/session
Content-Type: application/json
```

```json
{
  "appId": "your-application-uuid"
}
```

```json
{
  "appId": "your-application-uuid",
  "accessToken": "short-lived-visitor-token",
  "resumeToken": "private-visitor-resume-token",
  "expiresIn": 900
}
```

浏览器自动发送 Origin，不要手工伪造。`accessToken` 有效期为 15 分钟；`resumeToken` 有效期为 7 天，成功续接时顺延。刷新页面或令牌过期后，把原 resumeToken 传给同一接口，恢复同一访客和会话归属。

```js
const API_BASE = 'https://support.example.com/api';
const APP_ID = 'your-application-uuid';
const resumeKey = `agent.resume.${APP_ID}`;

async function getVisitorSession() {
  const resumeToken = localStorage.getItem(resumeKey);
  const response = await fetch(`${API_BASE}/widget/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId: APP_ID,
      ...(resumeToken ? { resumeToken } : {}),
    }),
  });
  if (!response.ok) throw await response.json();
  const session = await response.json();
  localStorage.setItem(resumeKey, session.resumeToken);
  return session; // accessToken 保存在内存，勿输出到日志
}
```

恢复凭证也属于私密信息，不要分享。为站点做好 CSP、内容转义和 XSS 防护；存储被浏览器禁止时，可使用内存会话，但刷新后无法保证恢复同一访客。若恢复凭证失效，服务端会签发新访客，原访客的会话不可继续访问。

### 2. 发送首个问题

```js
const session = await getVisitorSession();
const pendingRequest = {
  key: crypto.randomUUID(),
  body: { message: '请介绍当前产品', stream: false },
};
// 发送前持久化 pendingRequest。网络结果不明确时保留原 key 和原 body。
const response = await fetch(`${API_BASE}/v1/agent/messages`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.accessToken}`,
    'Idempotency-Key': pendingRequest.key,
  },
  body: JSON.stringify(pendingRequest.body),
});
if (!response.ok) throw await response.json();
const result = await response.json();
// 保存 result.conversationId；收到明确完成结果后才清除 pendingRequest。
```

网站请求不传 `userId`。换取令牌和点击「新建会话」不创建服务端会话；发送首个问题被接纳时才创建。新问题使用新的 Idempotency-Key；继续当前会话时加入 conversationId。

应用授权配置变更会使旧网站令牌失效；重新获取访客令牌时仍应携带 resumeToken。不要因为 401 就清空恢复凭证或当前会话 ID。

## 平台服务端接入

在服务端发起请求，`userId` 必须来自经过验证的登录身份，不可直接信任前端提交的任意用户 ID。API Key 已绑定应用，无需另传 appId。

```bash
curl 'https://support.example.com/api/v1/agent/messages' \
  -H "Authorization: Bearer $AGENT_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: platform-user-42-question-001' \
  --data '{"userId":"user-42","message":"请介绍当前产品","stream":false}'
```

`AGENT_API_KEY` 是自有服务端环境变量；请勿把实际值粘贴到文档、日志或浏览器。平台通道拒绝带浏览器 Origin 或 Fetch Metadata 的密钥调用，不能通过浏览器直接请求。

相同 userId 在不同应用中互相隔离。密钥轮换不会改变应用用户或历史会话；旧密钥在轮换后立即失效。

## 发送消息与返回字段

```http
POST /api/v1/agent/messages
Authorization: Bearer <访客令牌或平台 API Key>
Content-Type: application/json
Idempotency-Key: <本次问题的唯一请求标识>
```

| 字段 | 要求 | 含义 |
| --- | --- | --- |
| message | 必填字符串，2–2000 字符 | 当前用户问题 |
| conversationId | 可选，完整 UUID | 继续自己的会话；首个问题省略 |
| userId | 平台必填，1–128 字符；网站不传 | 平台可信用户标识 |
| stream | 可选布尔值，默认 false | false 返回 JSON，true 返回 SSE |

额外字段会被拒绝，不传 `history`、`messages`、`tools` 或 `systemPrompt`。历史和记忆由服务端构建。

### 携带产品上下文

网站和平台消息接口均可增加可选的 `context.productIds`：

```json
{
  "message": "这两款哪个更适合卧室？",
  "context": {
    "productIds": ["midea-hft20zbj", "xiaomi-air-purifier-pro"]
  },
  "stream": true
}
```

- 使用产品接口返回的准确 ID，不是会话 UUID。每个 ID 为 1–80 个字符，去除首尾空格并自动去重，最多 5 个不同产品；超过返回 400。
- 产品 ID 表示本轮关联，不会永久绑定会话。不接受客户端价格、规格、工具结果或提示词。未传或空数组保持普通聊天行为。
- 新的前端应把产品名称保留在 message（Cookie 接口为 question）正文中，并可附加 `productReferences: [{ "productId": "xiaomi-electric-warmer", "offset": 8, "length": 5 }]`。例如正文 `这个产品怎么样\n米家电暖器` 的名称从位置 8 开始、长度 5；前端将该范围的现有文字渲染为标签，不额外插入名称。offset/length 使用完整正文的 UTF-16 单位，从 0 开始，必须为整数，length 为 1–200；范围不可越界或重叠。名称属于提问文字，不是可信产品事实，不必强制换行。
- 每个 productId 必须属于 productIds 且只能引用一次，最多 5 个。历史仅 offset（没有 length）的引用继续采用旧的插入标签语义；仅传 productIds 也兼容。位置和样式不改变产品事实来源；productIds 只作为结构化上下文提供给模型。
- 完成鉴权、额度和幂等检查后，服务端不会根据 productIds 预先查询产品或知识库。模型会自行判断是否调用 get_product_detail；该工具支持 productId，或使用最多 5 个 productIds 一次查询多个产品。
- 幂等比较包含产品 ID 集合及可选引用位置和长度；仅 productIds 的顺序和重复不影响重放，但同一 key 换产品、移动引用位置或改变长度返回 409。刷新或重试须保留原正文与 context；旧的未确认请求不得换成新格式后使用同一 key 重发。
- 历史用户消息的 `context` 返回 productIds、可选 productReferences 和已确认产品的名称，便于还原标签；产品事实必须来自模型实际工具调用或已恢复的有效工具资料。
- 现有 Cookie 聊天接口 `/api/chat` 及其会话消息/SSE 接口使用 `question` 而非 `message`，同样支持此 context。

```json
{
  "conversationId": "conversation-uuid",
  "runId": "run-uuid",
  "traceId": "trace-uuid",
  "status": "completed",
  "answer": "产品介绍……",
  "refused": false,
  "citations": [],
  "context": {
    "contextWindowTokens": 32000,
    "inputBudgetTokens": 29200,
    "estimatedInputTokens": 14500,
    "remainingInputTokens": 14700,
    "usagePercent": 49.7,
    "pressure": "normal",
    "measurementSource": "heuristic"
  },
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

- `status: completed` 表示请求执行完成，不代表答案正确性评分；`refused` 才表示业务拒答。
- `traceId`、`runId` 可能为 null。排查时可把完整 conversationId / traceId 交给有调试权限的管理员。
- `citations` 为资料来源数组，可能为空。知识库来源可包含 chunkId、documentId、documentTitle、originalFilename、sourceStartLine、sourceEndLine。
- `usage` 是本次响应时的用量快照，摘要异步完成后可能更新；不要把同一请求的多个快照重复累加。
- `context` 是本轮最终上下文的近似估算，不等同于供应商 Token 账单；可使用 `estimatedInputTokens / inputBudgetTokens` 展示当前占用。
- `accounting` 为 actual（已知实际用量）、pending（尚有预留）或 incomplete（用量不完整）；includesSummary 标识当前统计是否已包含摘要调用。

## SSE 流式回答

发送同一消息接口，设置 `stream: true`。使用 POST fetch + ReadableStream，不使用只支持 GET 的浏览器 EventSource。

| 事件 | 内容与处理 |
| --- | --- |
| run_started | conversationId、clientRequestId、replayed；立即保存会话 ID 和请求标识 |
| progress | 公开的阶段、状态、简短说明；仅作为过程提示，不拼进答案 |
| commentary_started | `{ "id": "planner-1-commentary" }`；说明开始，初始化同一 ID 的缓冲区 |
| commentary_delta | `{ "id": "planner-1-commentary", "text": "我先查看" }`；模型生成的公开说明增量，按 ID 追加，不拼进答案 |
| commentary_completed | `{ "id": "planner-1-commentary", "text": "我先查看产品目录。" }`；说明完整内容，前端可用它校准增量文本 |
| commentary | 兼容旧客户端的完整公开说明事件；新客户端优先处理 `commentary_*` 事件 |
| answer_started | 回答开始；生成期间引用可能为空，以 answer_completed / done 为准 |
| answer_delta | `{ "text": "增量文本" }`；模型生成时逐段追加到回答，不等待整段生成完成 |
| answer_reset | `{ "text": "替换正文" }`；替换整个临时正文，不可追加；用于工具决策撤回或最终正文规范化 |
| answer_completed | 回答文本生成结束及引用信息；仍等待 done |
| done | 完整结果，结构同 JSON 响应；以 answer 校准最终文本并完成本轮 |
| error | status、message，可附 code、retryAt；标记未完成并停止本轮 UI 加载状态 |

生成中的正文是临时结果；只有 `done` 表示本轮已完成，并以其 `answer` 覆盖临时正文。`error` 或断线时应保留已接收正文并标为“未完成”，不能当成成功回答，不能自动重发来重新生成。服务只提取同一次模型响应的顶层 `answer`，不会为流式输出再调用回答模型。

根据模型决策，部分中间事件可能缺省。`commentary_*` 不代表步骤已成功，不是内部推理；说明缺失不影响执行。原生工具参数、内部调用 ID 和未解析 JSON 不会进入客户端 SSE。`done.progressEvents` 与历史消息保留合并后的公开过程。`model_protocol_error`（502）表示模型响应协议异常，与模型主动拒答不同。幂等重放可以直接返回 done，不伪造 answer_delta。不能把一次网络读取当作一个事件，也不能把 TCP 分块当作一个完整汉字。

下面的读取函数处理 UTF-8 拆包、跨块事件、多行 data 和 LF / CRLF 分隔；不依赖人为延时。

```js
async function readAgentEvents(response, onEvent) {
  if (!response.ok) throw await response.json();
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('服务未返回 SSE');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;

  function dispatch(block) {
    let event = 'message';
    const lines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      let value = separator < 0 ? '' : line.slice(separator + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      if (field === 'data') lines.push(value);
    }
    if (!lines.length) return;
    const data = JSON.parse(lines.join('\n'));
    if (event === 'error') {
      onEvent(event, data);
      throw Object.assign(new Error(data.message || '回答未完成'), data);
    }
    onEvent(event, data);
    if (event === 'done') completed = true;
  }

  function drain() {
    let separator;
    while ((separator = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      dispatch(block);
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      drain();
    }
    buffer += decoder.decode();
    drain();
    if (buffer.trim()) dispatch(buffer);
    if (!completed) throw new Error('连接已结束，尚未收到 done，请查询运行状态');
  } finally {
    reader.releaseLock();
  }
}
```

调用时，增量和最终值分别处理：

```js
let answer = '';
await readAgentEvents(response, (event, data) => {
  if (event === 'run_started') {
    // 保存 data.conversationId，便于断线后恢复
  }
  if (event === 'answer_delta') answer += data.text;
  if (event === 'answer_reset') answer = data.text;
  if (event === 'done') answer = data.answer; // 不要再次追加整段答案
  // 用 textContent 或经过安全转义的 Markdown 更新 UI，不用未经转义的 innerHTML。
});
```

反向代理需关闭 SSE 缓冲，保留流式 Content-Type，并设置足够的连接超时。流开始前可能返回普通 HTTP 错误；开始后可能发送 error，即使 HTTP 状态仍为 200。两类情况都要处理。

## 会话与断线恢复

以下接口返回当前凭证所属用户的数据。平台追加 `?userId=user-42`；网站不传 userId。含特殊字符的 userId 应通过 URLSearchParams 编码。

| 接口 | 用途 | 返回 |
| --- | --- | --- |
| GET /api/v1/agent/conversations | 会话列表 | 数组，最多 100 条，最近更新优先 |
| GET /api/v1/agent/conversations/:id/messages | 历史消息 | 按时间排序的数组，含 role、content、refused、citations、createdAt |
| GET /api/v1/agent/conversations/:id/runs | 最近运行 | 数组，最近 20 次，含 clientRequestId、status、errorCode、时间 |
| DELETE /api/v1/agent/conversations/:id | 删除自己的会话 | 204，无响应体；不要调用 response.json() |

运行状态为 `running`、`completed`、`failed` 或 `expired`。请求断流、超时或浏览器 AbortController 终止连接，**不代表服务端取消执行**。

恢复顺序：

1. 保存 run_started 中的 conversationId 和原请求的 Idempotency-Key。
2. 用 runs 按 clientRequestId 定位本轮；running 时适度延迟查询，不新建同一问题的请求。
3. completed 后读取 messages，或以原 key、原 body 重放，获得完成结果。
4. 明确 failed / expired 后，让用户决定是否以新 key 重试；不要自动无限重发。
5. 首轮断线且未拿到 conversationId 时，可用原 key、原 body 再请求；409 可能表示仍在执行，不等于允许换 key 重发。

当前接口没有取消执行 API，也不允许读取其他用户的会话或完整内部调试上下文。

## 幂等与重试

`Idempotency-Key` 为 1–120 个安全 ASCII 字符，支持字母、数字、下划线、点、冒号、斜线和短横线；推荐 UUID。虽然省略时服务端会生成标识，接入方应主动生成并保存，尤其是首轮。

| 情况 | 行为 |
| --- | --- |
| 同一应用、用户、key，原请求已完成 | 返回原结果，不再次调用模型或扣请求配额 |
| 同一 key，原请求执行中 | 409；等待或查询运行，不换 key 重发 |
| 同一 key，但 message / 输入 conversationId 改变 | 409；属于不同请求 |
| 原请求明确失败或过期 | 原 key 不可重新执行；确认后用新 key 重试 |
| 会话已删除 | 原结果不能继续重放 |

stream 可以在重放时改为 false；message 和原输入 conversationId 必须保持不变。尤其首轮重放时，原 body 未传 conversationId，就不能补上传回的 ID。

网站令牌过期可续接令牌，但保留同一个 key 和原 body；不要把网络异常当成业务拒答。业务拒答是正常 completed 结果，不应自动重试。

## 健康、状态与用量

| 接口 | 认证 | 含义 |
| --- | --- | --- |
| GET /api/health | 无 | 基础服务、数据库健康；不调用模型 |
| GET /api/v1/agent/status | 网站令牌或平台密钥 | 当前是否可发送、限制原因及重试时间 |
| GET /api/v1/agent/usage | 网站令牌；平台另需 usage:read | 今日用量；网站仅个人，平台仅所属应用汇总 |

```json
{
  "service": "ready",
  "canSend": true,
  "code": "ready",
  "retryAt": null,
  "checkedAt": "2026-10-08T06:00:00.000Z",
  "modelHealth": "not_probed"
}
```

`canSend` 是状态快照，不是容量预占，也不保证下一问题的完整模型预算足够。`modelHealth: not_probed` 明确表示未探测供应商模型服务；health / status 成功不等于所有模型请求一定成功。

usage 字段包括：`scope`、`startAt`、`resetAt`、`timezone`、`requests`、`completed`、`failed`、`running`、`inputTokens`、`outputTokens`、`totalTokens`、`reservedTokens`、`unknownModelCalls`、`tokenLimit`、`remainingTokens`。

- 网站 scope 为 visitor：仅当前访客数据，tokenLimit / remainingTokens 为 null，不披露应用汇总。
- 平台 scope 为 application：需应用与密钥同时授予 usage:read，无需 userId；不能查询其他应用。
- status / usage 不消耗聊天配额，响应不缓存；每访客或密钥合计最多 60 次/分钟查询（每实例）。
- 建议页面初始化、每轮完成或恢复后刷新。不要每个 token 轮询；等待重试时间到达后查询状态，而非自动重发问题。

## 每日配额与错误处理

应用限制：每分钟请求、同时执行、每日请求、可选每日 Token。每日按 `Asia/Shanghai` 自然日重置，时间字段使用 ISO 8601，通常以 UTC 返回；显示时转换为用户时区，不要把 UTC 的 16:00 误认作本地重置时间。

- Token 累计 Planner、最终回答、重试、摘要的输入和输出，Embedding 不在本配额中。
- 已接纳的失败请求也计入请求数；完成或失败后释放并发槽。
- 模型调用前预留完整输入的保守估算和输出上限，随后用实际 usage 结算。余额不足时可能无法启动下一模型调用，而非缩短回答来凑额度。
- 未知用量不会当作零：按预留量保守计入，并标记 incomplete。此处是资源用量，不是供应商账单或金额结算。
- 单次消息的用量可能包含多次模型调用；上下文、工具结果也消耗输入 Token。

普通 HTTP 错误结构：

```json
{
  "error": {
    "code": "daily_token_quota_exceeded",
    "message": "今日 Token 额度已用完，请明日再试或联系管理员。",
    "retryAt": "2026-10-08T16:00:00.000Z"
  },
  "requestId": "request-id"
}
```

retryAt 不是所有错误都有。HTTP 429 的配额错误同时返回 `Retry-After` 秒数。SSE error 使用扁平结构 `{status, code?, message, retryAt?}`，不是上面的 error 包装。

| HTTP / 错误码 | 建议处理 |
| --- | --- |
| 400 | 检查字段、UUID、问题长度；网站不传 userId、平台必传 userId |
| 401 | 凭证过期或失效；网站续接令牌，平台检查密钥 |
| 403 | 权限、域名或通道不允许；联系管理员，勿循环重试 |
| 404 | 会话不存在或不属于当前用户 / 应用；不泄露他人的资源存在性 |
| 409 | 幂等冲突或会话正在执行；先检查原请求状态 |
| daily_request_quota_exceeded | 今日请求已用完，等待 retryAt 或调整配额 |
| daily_token_quota_exceeded | 今日 Token 已用完，等待重置或调整配额 |
| daily_token_budget_insufficient | 剩余额度不足以预留本次完整模型调用 |
| token_budget_reserved | 额度被进行中的调用暂时占用；稍后检查状态 |
| concurrency_limit | 执行槽已满；稍后检查状态 |
| request_rate_limit | 请求频率超限；等待 Retry-After / retryAt |
| inspection_rate_limit | 状态、用量查询过于频繁；降低查询频率 |
| 429 无具体配额码 | 可能触发访客、IP 或全局保护；稍后重试，不按固定日额度解释 |
| 5xx / 断线 | 展示暂时不可用；按断线恢复流程确认结果，不盲目生成新 key |

## 权限与安全边界

| Scope | 权限 |
| --- | --- |
| chat:write | 发送问题、继续会话 |
| conversations:read | 读取自己的会话、消息和运行 |
| conversations:delete | 删除自己的会话 |
| usage:read | 平台服务端获取所属应用汇总用量；网站个人用量不需要此项 |

平台密钥的权限是应用权限的子集；应用停用、通道关闭、密钥撤销或过期都会阻止新访问。网站匿名身份仅用于咨询，不替代订单、账户等敏感业务认证。

凭证不能访问管理员接口、系统提示词、模型完整请求或工具原始参数。公开 progress 是安全状态播报，不是模型隐藏推理。记录问题时只提供完整会话 / 轨迹 ID 和 requestId，不提交 API Key、accessToken、resumeToken。

## 旧官网兼容与验收

现有官网使用 HttpOnly Cookie 的 `/api/chat/*` 会话接口，继续保留。外部新接入以本文 `/api/widget/session` 和 `/api/v1/agent/*` 为准，**不要混用两套访客身份或把平台密钥传给旧官网接口**。

旧官网额外提供 `/api/chat/status`、`/api/chat/usage`、`/api/chat/quota`。前两者是状态和个人用量；quota 是明确公开的当前官网共享配额，scope 为 website-shared，仍受域名和权限校验。它不是外部应用汇总用量查询接口。

交付前检查：

- 网站域名授权成功；未授权域名被拒绝；浏览器中没有永久密钥。
- 首轮才创建会话；刷新后通过 resumeToken 恢复同一访客，能继续 conversationId。
- 平台不同 userId 不能读取或继续彼此会话。
- JSON 成功、SSE 增量、done 校准、HTTP 错误和 SSE error 都有 UI 状态。
- 首轮与后续轮的原 key / 原 body 可幂等重放，不重复执行；断线不盲目重发。
- 每日额度不足或并发繁忙时显示明确提示，而不是“AI 拒绝回答”。
- 状态与用量刷新频率合理；无限额显示“不限制”，查询失败不显示虚假的零余额。
- 密钥轮换、撤销、到期和应用停用的错误都已处理；调试日志不含凭证。
