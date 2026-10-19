# Agent Studio

开源的通用 Agent 构建与运行平台。基于 Deep Agents / LangGraph、NestJS、PostgreSQL / pgvector，以及 Vben + Element Plus。配套的独立展示站见 [Demo Hub](https://github.com/chaobin0701/demo-hub)。

## 项目边界

- 管理：工作区、Agent、Prompt、Skill、HTTP Tool / MCP、模型方案、文档知识库。
- 运行：单 Agent / 多 Agent、版本快照、工具权限、会话、文档与图片附件、执行记录。
- 发布：自动保存草稿、发布生效、历史与回滚、归档和回收站。
- 业务系统通过 HTTP / MCP 接入；不包含产品目录、企业官网或特定行业的默认 Agent。

## 目录

| 目录 | 职责 |
| --- | --- |
| `server/` | API、执行内核、文档索引 Worker、数据库迁移 |
| `admin-vben/` | 唯一管理后台；保留上游框架包和 MIT 许可 |
| `chat/` | 中性的对外聊天端；按应用 ID 接入，不包含业务网站 |
| `packages/chat-ui/` | 后台与对外聊天共享的交互和会话状态 |
| `packages/output-contract/` | 共享输出规范校验 |

## 本地启动

需要 Node.js 22.18+ / 24.12+、pnpm 11+、Docker Compose。

```sh
npm run setup                 # 安装依赖；首次生成独立随机密钥的 .env，不覆盖已有配置
docker compose up -d postgres
npm run db:migrate
npm --prefix server run build
npm run admin:bootstrap        # 交互创建首个管理员，没有默认账号或密码
npm run dev
```

默认地址：后台 `http://localhost:8085`，聊天端 `http://localhost:8852`，API `http://localhost:3020`，数据库本机端口 `5437`。均与来源项目隔离，不会连接原数据库或启动原项目的 PM2 服务。

首次使用：创建供应商连接与模型方案 → 创建并发布 Prompt → 创建并发布 Agent → 后台对话或创建接入应用。

对外聊天：在后台创建应用，选择已发布 Agent，开启网站接入，将聊天端 Origin 加入该应用允许来源。打开 `http://localhost:8852/?app=应用UUID`；生产路径为 `/chat/?app=应用UUID`。应用 ID 是公开标识，浏览器使用后端签发的短期访客令牌，**不能填写平台 API Key**。不自动启用默认应用或放宽 Origin。

```sh
npm run typecheck
npm run build
npm test
```

PostgreSQL 集成测试需显式配置 `TEST_DATABASE_URL`，使用临时 schema 并清理；不使用业务数据库做测试。

## 部署

`docker compose -f compose.production.yml up -d --build`。首次部署前生成并审查本地 `.env`，将 `ALLOWED_ORIGINS` 改为实际入口地址、`TRUST_PROXY=1`（仅置于可信反向代理之后）。默认 ingress 仅绑定 `127.0.0.1:8075`，API / Worker / PostgreSQL 不直接对外暴露。

Agent Studio 与独立 Demo Hub 同机部署的生产实例、备份与回滚操作见 [展示环境手册](deploy/showcase/README.md)。

首次生产部署后，使用 `docker compose -f compose.production.yml exec api npm run admin:bootstrap` 创建管理员；不复用开发库的管理员。

新仓库不包含任何原数据库、管理员、供应商密钥、知识库文件或聊天记录。历史 SQL 迁移用于保留约束及迁移顺序，不应逐份重写；业务内置资源已由后续迁移退出运行界面。Phoenix 保留为可选私有追踪，默认关闭，不连接来源项目的实例。

来源和上游许可见 [SOURCE.md](SOURCE.md)。

项目代码采用 [MIT 许可](LICENSE)；`admin-vben/` 等第三方内容保留各自的许可与来源说明。
