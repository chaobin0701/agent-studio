# Agent 配置与业务接入优化方案

## 本次已实现的界面调整

- 欢迎标语、描述和建议问题归入基本配置。
- 删除基本配置的“管理 Prompt”和能力页的“管理资源”快捷入口。
- 普通 HTTP、内置工具与 UI Tool 共用“Tools/工具”多选框，MCP 工具保持独立分组。
- UI Tool 的选项和已选标签使用界面图标，普通工具使用设置图标；选项同时显示类型文字。
- 删除独立生成式 UI 开关和选择框。保留既有 `toolVersionIds` 绑定，打开页面不会迁移、清空或自动发布配置。同一工具只能选择一个发布版本。
- 后台工具类型统一显示“生成式UI”，不在类型名称中展示渲染框架。模型使用 `present` 契约、组件说明和参数，不依赖框架名称。

## 扫地机器人业务工具改为 MCP（已实现）

### 源码确认结果

独立项目 `agent-studio-showcase` 已有 Streamable HTTP MCP 端点 `POST /api/mcp`，使用 Bearer Token 认证；管理平台注册 Key 为 `demo_hub_robot` 的接入逻辑已存在于 `scripts/connect-agent.ts`。

迁移前目录从 `lib/robot/tools.ts` 暴露 7 个工具。现已拆分为 6 个 MCP 业务工具：`list_demo_users`、`get_user_id`、`get_user_location`、`get_current_month`、`fetch_external_data`、`fill_context_for_report`；`get_weather` 仅作为独立 HTTP mock Tool 配置。

本地工作空间 4 的机器人 Agent 5 已通过管理 API 完成 MCP 发现、实际工具执行测试和 Agent 配置验证/发布。Agent 当前生效版本为 53；天气原 HTTP 绑定、通用工具和其他配置保留。此结果仅适用于本地，线上环境未执行迁移。

机器人目录里没有订单工具。客户详情和订单查询在另一套 Contoso 业务的 `/api/contoso/mcp` 中。实施前通过当前 Agent 已绑定的资源 Key 确认归属，避免把两个 Demo 的业务数据合并。

### 推荐实施

1. 在 Showcase 中明确导出业务 MCP 工具集，排除 `get_weather`。MCP 路由只注册其余 6 个工具；HTTP 路由继续提供独立的 `get_weather`。天气仍调用固定模拟样本，并在工具描述和结果中明确“模拟、非实时”。业务数据不进入平台代码。
2. 更新连接、发现和验证脚本对 MCP 目录的预期数量和名称；离线测试覆盖 `tools/list` 不含天气、MCP 无法调用天气、HTTP 天气仍可调用、认证与输入契约一致。
3. 通过现有 MCP 管理服务完成发现与测试，在原业务工具资源下创建 `type=mcp` 的受管版本，保留工具 Key，避免改写 Prompt 和 Skill 的工具引用。MCP 是工具的接入协议，仍复用平台已有 Tool 权限、版本与执行治理。
4. 在机器人 Agent 草稿中，用这些 MCP 工具版本替换相应 HTTP 业务工具绑定；只把 `get_weather` 保留在普通 Tools 下。核对 Prompt、Skill 是否引用旧工具名，必要时同步修正草稿。
5. 使用现有草稿试运行检查用户信息、清洁记录和天气组合调用，确认实际调用的协议和名称。先做不调用模型的契约测试；真实模型试运行单独执行。
6. 验证后发布 Agent。六个原 HTTP 业务工具的当前配置已转换为 MCP，不再保留一套并行的活动 HTTP 业务工具配置；历史 HTTP 版本仅供追溯。天气和其他工具保留原绑定。

不直接运行现有 `connect-agent.ts`：它会批量创建、测试及发布资源，且当前逻辑同时建立 HTTP 和 MCP 入口，并不等于本方案的迁移。

## 应用接入（已恢复独立页面）

按用户要求取消接入管理合并，恢复 `/integrations` 应用列表、`/integrations/:id` 应用详情及侧栏“应用接入”入口。Agent 配置使用原本的本地页签；运行设置中的“管理应用接入”按钮跳转到独立页面。

合并产生的组件、路由、权限扩展和接口筛选逻辑已撤回。应用的配置、密钥、配额和调用记录保留原样；机器人 MCP 及独立天气 Tool 的迁移不受此次界面撤回影响。

### 显式迁移脚本

Showcase 的 `scripts/migrate-robot-mcp.ts` 默认只输出计划。指定管理 URL/会话、Token、工作空间与机器人 Agent ID 后，传 `--apply` 才执行。脚本不加载其他项目的环境文件，不变更应用开关、Origin 或模型配置，不调用模型；遇到无关的 Agent 草稿修改时停止。历史版本不物理删除。

## 生成式 UI 的实现边界

本次调整已经让 Agent 通过普通 Tool 选择入口使用生成式 UI，并隐藏类型名称中的框架名。当前渲染目录与历史消息仍使用既有 `adapter: assistant-ui` 协议标识。

如果还要让运行时支持其他渲染框架，应另行演进版本化 UI 协议：组件目录、参数契约和消息产物采用中立的协议标识；不同客户端实现渲染适配；保留旧 `assistant-ui` 目录、消息回放与纯文本回退。不能只替换持久化标识，否则旧目录校验与历史 UI 回放会失效。这不影响本次工具选择方式的调整。
