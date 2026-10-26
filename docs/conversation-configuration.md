# 会话配置摘要与展示站额度

应用接入中的“读取用量”配置已移除。已通过应用身份验证的调用方可通过 `GET /api/v1/agent/chat-status` 读取本应用共享额度，不依赖旧 `usage:read` scope。旧 scope 保留协议兼容，其他执行、会话读取和删除权限不变。

额度返回 `quota`，包括 `scope=application-shared`、`checkedAt`、上海时区的 `resetAt`。仅启用的限制包含对应字段：

- `requests`: 每日请求的 `limit/used/remaining`。
- `tokens`: 每日 Token 的 `limit/used/reserved/remaining/unsettled`。
- `minute`: 最近滚动 60 秒的 `limit/used/remaining/windowSeconds/retryAt`。

所有限制关闭时仍返回时间和范围信息，省略三个限额字段；不表示模型上下文无限。服务端请求接入仍执行原来的额度检查。

## 每轮保存与读取

迁移 `0063_conversation_configuration_summary.sql` 为现有调用记录增加 `configuration_summary`。聊天完成应用接入检查后、开始模型执行前，根据同一份已固定的 Agent composition 保存展示摘要；暂停恢复继续复用原记录，幂等重放不覆盖。失败轮次也保留已经记录的配置。历史缺失记录保持 `null`，不拿当前生效配置补填。

访客或 API 宿主使用已有会话权限：

- `GET /api/v1/agent/conversations/:id/configurations?userId=...`
- 网站 Cookie 接入使用 `GET /api/chat/conversations/:id/configurations`。

返回 `{ turns: [{ id, number, status, startedAt, snapshot }] }`，按请求开始顺序排列。校验应用和会话所有者。公开 `snapshot` 仅含 `capturedAt/agent/tools/skills/mcp/knowledge`；资源只含名称和固定版本，MCP 按服务聚合并包含本轮授权能力数量。

管理员使用已有登录及工作区权限 `conversations.debug`：

`GET /api/admin/integrations/:appId/conversations/:conversationId/configurations`

管理员摘要额外包含模型方案、Prompt 版本、知识检索设置、协作成员、输出方式、单轮预算和请求开始时的应用限额。只保存名称、版本标识和有限配置字段，不保存密钥、Prompt 正文、端点、工具参数或结果。

展示站通过自己的服务端适配器转发读取；平台 Key 不进入浏览器。现有聊天界面已改为真实额度和真实会话摘要，“Agent 配置”区域显示当前会话最近实际使用的 Agent 快照、版本、资源数量，并可展开查看资源版本；页面不显示轮次选择。信息入口仍在首句开始后显示。完整策略读取保留在管理员接口，不通过访客页面暴露。
