# Channel 边界

Channel 只负责把平台输入转换为统一的 `InboundMessage`，以及把应用结果转换回 HTTP、SSE 或其他平台格式。

它不负责检索、模型调用、会话持久化或工具决策。公开事件必须经过可见性策略，不包含 Token、密码、完整 Prompt、原始 Provider 响应或内部堆栈。
