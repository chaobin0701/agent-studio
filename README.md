# Agent Studio

**构建、发布并运行通用 Agent 的开源平台。** 在一个工作区管理模型、Prompt、Skill、知识库和工具，让同一套执行能力可以通过后台、聊天端或 API 接入不同应用。

[在线应用体验](https://hexu.7410000.xyz/) · [独立展示站 Demo Hub](https://github.com/chaobin0701/demo-hub) · [部署说明](deploy/showcase/README.md)

Agent Studio 负责资源版本、权限和执行；业务系统继续拥有自己的数据。扫地机器人和户外装备顾问是由独立 Demo Hub 接入的示例应用，不是平台内置业务流程。

## 项目亮点

| 核心亮点 | 说明 |
| --- | --- |
| 通用 Agent 平台 | 在工作区统一管理 Agent、模型方案、业务 Prompt、Skill、Tool 和知识库，并通过聊天或独立任务接口接入不同应用。业务数据由外部服务提供。 |
| ReAct 式执行链 | 基于 Deep Agents / LangChain / LangGraph 完成模型决策、工具调用、结果反馈与继续推理；Chat 和 Run 使用同一执行服务。平台在执行前固定授权和预算，在执行中记录调用过程。 |
| RAG 知识库闭环 | 文档上传后由 Worker 解析、分块并建立索引。支持 PostgreSQL 全文检索、pgvector 向量检索和混合检索，以 RRF 融合召回结果，并保留回答引用及索引版本。 |
| 可复用 Skill | 将已发布的 Skill 指导与辅助资料绑定到 Agent，运行时作为只读虚拟文件按需读取；Skill 版本进入任务快照，不因资料内容获得额外工具权限。 |
| HTTP / MCP 工具接入 | 管理 HTTP Tool 与远程 Streamable HTTP MCP 连接。工具经过契约发现、测试、发布和 Agent 授权；执行时校验参数、凭据、网络边界及调用预算。 |
| 多 Agent 协作 | 入口 Agent 可委派给已授权的成员 Agent。成员使用各自发布的模型、Prompt 和能力，执行次数、Token 与期限受共同预算约束。 |
| 不可变发布快照 | 草稿可持续编辑；发布后固定 Agent 及其依赖版本。每次请求读取生效快照，历史版本、引用和运行记录可追溯。 |
| 接入与运行治理 | 支持后台调试、访客聊天、应用 API 和独立 Run；工作区权限与 PostgreSQL RLS 隔离数据，提供 SSE 流式输出、用量记录及可选的本地 Phoenix 追踪。 |

## 后台预览

![Agent Studio 管理后台首页，展示 Agent、Prompt、Skill、Tool、MCP、知识库等入口及近期执行](docs/images/admin-overview.png)

本地示例工作区的管理首页集中呈现资源入口、最近编辑的 Agent、执行情况和知识库处理状态。

## 从配置到运行

1. **组合能力：**配置模型方案与业务 Prompt，按需关联知识库、Skill、HTTP / MCP Tool 和成员 Agent。无需知识库或工具的 Agent 也能直接运行。
2. **调试发布：**在后台试运行草稿，检查工具调用和回答；发布后形成可追溯的 Agent 版本。
3. **接入执行：**聊天端或应用 API 提交请求，服务端校验身份、工作区、权限和预算，再固定当前生效版本及其依赖。
4. **返回结果：**Deep Agents 在授权范围内调用模型、检索资料或执行工具，通过 JSON / SSE 返回答案、引用、公开进度与用量。

## 架构一览

```mermaid
flowchart LR
    CLIENT["管理后台 · 聊天端 · 外部应用"] --> API["NestJS API"]
    API --> CONTROL["资源管理<br/>工作区 · 权限 · 版本"]
    API --> RUN["Chat / Run<br/>准入 · 快照 · 预算"]
    RUN --> AGENT["Deep Agents"]
    AGENT --> MODEL["模型"]
    AGENT --> RAG["RAG 检索"]
    AGENT --> TOOL["HTTP / MCP 工具"]
    CONTROL --> DB[(PostgreSQL / pgvector)]
    RUN --> DB
    RAG --> DB
```

管理控制面维护资源与版本，执行面处理对话、独立任务和受控能力调用。文档解析与索引由独立的 pg-boss Worker 异步完成；后台在 `admin-vben/`，中性聊天端在 `chat/`，两者复用 `packages/chat-ui/`。详细设计见[平台架构](docs/generic-agent-platform.md)、[知识库管理](docs/knowledge-management.md)和[工具管理](docs/tool-management.md)。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 管理后台与聊天端 | Vue 3、Vben Admin、Element Plus、Vite |
| API 与 Agent 执行 | Node.js、TypeScript、NestJS、Deep Agents、LangChain、LangGraph |
| 知识检索与持久化 | PostgreSQL 全文索引、pgvector、版本化索引 |
| 异步文档任务 | pg-boss、独立 Worker |
| 外部能力与传输 | HTTP Tool、MCP Streamable HTTP、SSE |

仓库按管理后台、聊天端、服务端和共享 UI / 输出规范组织；详细模块位于 `admin-vben/`、`chat/`、`server/` 与 `packages/`。

## 本地启动

需要 Node.js 22.18+ 或 24.12+、pnpm 11+ 和 Docker Compose。模型调用需要自行配置供应商连接及密钥；仓库不提供默认管理员或可用的模型凭据。

```sh
npm run setup                  # 安装依赖；首次生成独立随机密钥的 .env
docker compose up -d postgres
npm run db:migrate
npm --prefix server run build
npm run admin:bootstrap         # 交互创建首个管理员
npm run dev
```

默认地址：管理后台 `http://localhost:8085`、聊天端 `http://localhost:8852`、API `http://localhost:3020`，PostgreSQL 本机端口 `5437`。首次登录后，先配置供应商连接与模型方案，再创建并发布 Prompt 和 Agent；需要对外聊天时，在后台创建接入应用，绑定已发布 Agent 并设置允许的 Origin。

对外聊天地址为 `http://localhost:8852/?app=应用UUID`；生产路径为 `/chat/?app=应用UUID`。应用 ID 是公开标识，浏览器使用服务端签发的短期访客令牌，**不能放入平台 API Key**。测试和启动不会自动启用应用或扩大 Origin。

## 验证与部署

```sh
npm run typecheck
npm run build
npm test
```

PostgreSQL 集成测试需显式配置 `TEST_DATABASE_URL`，使用临时 schema 并在结束后清理，不使用业务数据库。单独生产部署见 `compose.production.yml`；Agent Studio 与 Demo Hub 同机部署、备份和回滚见[展示环境手册](deploy/showcase/README.md)。首次全新生产部署使用 `admin:bootstrap` 创建管理员，不复用开发库账户。

仓库不包含原业务数据库、演示用户、上传文件、供应商密钥或聊天记录。业务系统通过 HTTP / MCP 接入；展示站和平台不共享业务数据库或执行内核。来源与第三方许可见 [SOURCE.md](SOURCE.md)，项目代码采用 [MIT 许可](LICENSE)。
