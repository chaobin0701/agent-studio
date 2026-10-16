# AI Tools 目录说明

这里存放平台通用基础工具、显式专项流程，以及统一的 `ToolRegistry`。业务能力在独立服务中实现，通过版本化 HTTP／MCP 配置接入，不在平台注册行业服务。

## 文件职责

- `agent-tool.ts`：定义工具的名称、描述、输入校验和执行接口。
- `tool-context.ts`：定义一次 Agent 运行传给工具的上下文与临时状态。
- `tool-result.ts`：统一工具成功、失败、数据和错误码的返回结构。
- `tool-errors.ts`：处理重复注册和未知工具等 Registry 错误。
- `tool-registry.ts`：注册、查找和列出工具；不负责模型调用或 Agent 决策。
- `tool-policy.ts`：定义单轮调用次数、重复调用、输入校验、超时和结果大小等执行策略。
- `tool-execution.ts`：提供统一工具执行入口，负责调用 Registry、执行策略、异常转换和执行轨迹。
- `tools.module.ts`：只注册通用基础工具与明确的专项流程，不安装业务默认工具。
- `knowledge-search.tool.ts`：把知识库检索封装为 `search_knowledge` 工具。
- `load-skill.tool.ts`：按注册 ID 读取专项指导，不读取任意文件、不切换 Agent，也不改变权限或运行预算。

## 设计边界

工具只执行能力并返回结构化结果，不生成最终答案；最终回答目前只做基础格式校验。模型调用由 Provider 负责，调用循环与节点路由由 Deep Agents / LangChain 原生执行器负责；工具执行的通用限制由 Tool Runtime 负责，配置来源为请求固定的 Agent / Tool 版本及 runtime 参数。图节点不能额外重试工具，以免重放写操作；模型、工具实际尝试通过统一 metadata-only 追踪接口记录，不能导出参数和返回正文。Skill 仅为已授权的只读指导，不创建隔离执行 Agent；成员委派由原生子 Agent 中间件负责，不能通过工具上下文注入递归执行函数。

`search_knowledge` 和 `load_skill` 是代码维护的基础能力，不出现在管理工具列表和选择项中，不允许通过资源配置创建、替换或停用。每个 Agent 请求自动装配代码实现；历史 Tool 绑定只保留引用，不再控制这两个实现。工具可调用不代表资源授权：知识检索只访问 Agent 授权的知识库，Skill 加载只访问请求已授权的 Skill。原生 Skill 目录按需读取；历史 `run_skill` / `delegate_agent` 名称继续保留，但不注册工具或执行回调，不进入新快照。

MCP 适配器位于 `../mcp/`，只将静态、进程内插件转换为 `AgentTool`；业务工具和 Orchestrator 不应依赖 MCP 协议细节。管理层可绑定已注册适配器或版本化 REST 工具；运行时 Registry 在存在请求范围时只能查询该范围，不得回退到全局注册表。
