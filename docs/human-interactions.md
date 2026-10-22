# 补充信息与工具审批

单 Agent 执行过程中可以等待用户回应，再继续原任务。两种卡片共用持久化与传输机制，但含义不同：补充信息提供执行所需的事实或偏好；审批仅授权一次已确定参数的工具调用。

## 配置

### 补充信息

在工具管理中新建内置工具，选择 `ask_user`。工具的代码实现来自平台注册表；显示名称可以自定义。填写测试输入后执行“交互契约测试”，检查通过后按现有流程发布，再将发布版本绑定到单 Agent。

```json
{
  "question": "你希望怎样整理结果？",
  "options": [
    { "id": "brief", "label": "简短摘要" },
    { "id": "detailed", "label": "详细说明" }
  ],
  "allowCustom": true
}
```

问题最多 1000 字、最多 8 个选项，选项 ID 唯一；必须提供选项或允许自由回答。每次可选一项或填写最多 4000 字的回答。Agent 的 Prompt 可指导“当缺少完成任务所需的信息时，先使用补充信息工具；有足够信息时继续处理”。平台不内置预算、商品或行业规则。

管理测试使用服务端生成的样例回答验证参数与适配器，结果明确标注为模拟交互，不等待真实访客。它仍要求原有执行权限、当前版本的测试记录与发布校验。真实对话不会获得样例回答，也不会因为测试成功而自动启用应用。

### 工具审批

在需要确认的 HTTP、MCP 或内置工具上开启“调用前需批准”，测试并发布新版本，再更新 Agent 的绑定版本。只读声明与审批开关独立；审批不扩大工具权限，也不能代替外部服务的鉴权或幂等保障。

运行到该调用时，卡片展示工具名称与说明，不展示调用参数。用户可以批准或拒绝；批准仍仅适用于服务端固定的当前工具版本、原生调用 ID 和完整参数摘要。浏览器不能修改参数或给整个工具永久授权。拒绝后向 Agent 返回本次调用被拒绝，Agent 可以据此调整后续回答；它不能绕过下一次调用的审批。

## 聊天体验

管理后台聊天与 Agent Studio Showcase 均支持这两类卡片。等待时暂停普通输入；切换页面或刷新会读取同一任务的待处理状态。选项每行一项，可在独立输入行补充信息；同时选择和填写时合并为一份文本回答。底部“跳过”会明确告知 Agent 用户未提供答案并继续原任务，不取消任务或编造选项。已处理的提问和审批收进默认折叠的“工具调用过程”，保留只读历史。

等待期不保持 SSE 长连接。提交答复后重新观察原 Run，期间可以再次提问或请求审批。若提交结果不明，先读取状态；重复提交同一答案只返回确认回执，不重放模型或工具。浏览器“停止接收”与取消等待任务不同：前者只停止当前显示，具体执行取消语义沿用各入口。

## 执行与持久化

`Deep Agents → 原生 interrupt → PostgreSQL checkpoint → 用户答复 → Command.resume` 沿用原生图执行机制，没有第二套 Agent 循环。私有检查点采用 LangGraph 的序列化器保存，不通过公开 JSON 或 Trace 返回。

- 原 integration call、Run、Trace、会话归属及模型尝试账本继续使用；恢复不另计一次新请求，不重新插入用户消息。
- 原 Agent、Prompt、Tool、Skill、模型与输入固定；发布新版不会把等待任务切到新版本。恢复前仍校验当前应用、凭据、权限和知识资料的可用性；不符合原快照的资源状态会阻止恢复。
- 保存等待状态与释放执行槽、领取回应与重新准入分别在事务中完成。同一张卡片仅一个提交者能继续执行，答复使用版本号防止旧页面覆盖新状态。
- 等待总期限自任务创建起最多 24 小时；已消耗的调用次数、Token 和实际执行时间继续累计。等待不占活动并发槽，恢复时重新检查并发与 Token 额度。
- 已成功完成的工具不因恢复而重放。进程在外部写入结果不明时崩溃，不自动重启任务；外部写入仍需服务自身提供幂等性。
- 等待过期、完成或取消时清除私有继续执行状态、原生检查点及原始审批参数；历史卡片保留脱敏展示、回应和必要的幂等摘要。

当前仅支持正式单 Agent。管理草稿试运行、成员 Agent 内部交互尚未接入恢复宿主；需要交互时明确阻止执行，不伪造卡片或自动批准。普通多 Agent 执行保持原有行为。

## API

新响应事件 `interaction_required` 包含 `{ runId, interaction }`，本次流随后关闭；它不发送 `done`，也不表示失败。非流式 Run 返回 `202` 与 `status: "waiting"`。公开卡片包含 `id`、`revision`、`kind`、`status`、`expiresAt` 及对应展示字段，不能据此构造或读取私有图状态。

| 入口 | 回应 |
| --- | --- |
| 独立 Run | `POST /api/v1/agent/:agentId/runs/:runId/interactions/:interactionId/respond?userId=...` |
| 管理聊天 | `POST /api/admin/chatbot/sessions/:sessionId/runs/:runId/interactions/:interactionId/respond` |
| Cookie 聊天 | `POST /api/chat/bot/sessions/:sessionId/runs/:runId/interactions/:interactionId/respond` |
| 旧版应用聊天 API | `POST /api/v1/agent/conversations/:conversationId/interactions/:interactionId/respond?userId=...` |

问题答复二选一传 `optionId` 或 `text`：

```json
{
  "kind": "question",
  "interactionId": "服务端卡片 UUID",
  "revision": 1,
  "optionId": "brief"
}
```

审批答复传 `kind: "approval"` 和 `decision: "approve" | "reject"`，保留同样的 ID 与版本号。额外字段会被拒绝。重复的同一答复返回确认回执，调用方应读取状态，不把回执当作最终回答。共享聊天沿用原会话 Run 查询和取消接口；旧版 API 另有 `POST .../interactions/:interactionId/cancel?userId=...`，无请求正文。所有操作仍要求原应用与用户归属，卡片 UUID 不作为访问凭据。

跳过问题发送 `{ "kind": "question", "interactionId": "UUID", "revision": 1, "skip": true }`。`skip`、`optionId`、`text` 三者只能选一；跳过有独立的 `skipped` 状态，重复提交仍保持幂等。`0061_interaction_skip.sql` 扩展这一状态。

## 验证

迁移为 `server/migrations/0060_human_interactions.sql`，包含等待状态、卡片、私有线程、原生检查点及工作区隔离。先执行迁移，再启动新 API。自动化验证使用确定性模型、隔离传输及独立 PostgreSQL 测试 schema，不调用真实供应商，也不自动发布模型、工具或 Agent。

相关测试包括原生运行时、持久化、Run／Legacy HTTP、并发回应／取消、恢复准入与终态清理，以及共享 Vue 聊天卡片、管理工具配置和 Showcase 的代理与恢复测试。PostgreSQL 测试使用显式的 `TEST_DATABASE_URL` 和临时 schema；不设置时跳过数据库部分。运行完整验证使用根目录的 `npm test`、`npm run typecheck` 和 `npm run build`。
