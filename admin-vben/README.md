# Agent Studio 管理后台

唯一管理后台，基于 vue-vben-admin / Element Plus。上游 MIT 许可证保留。

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck
pnpm build
```

默认开发地址 `http://localhost:8085`，API 代理 `http://127.0.0.1:3020`。可通过 `ADMIN_PORT` / `API_PROXY_TARGET` 覆盖；统一启动推荐仓库根目录的 `npm run dev`。

业务请求沿用 Vben RequestClient、权限和工作区隔离。模块包括 Agent、Prompt、Skill、Tool / MCP、模型方案、文档知识库、应用接入、对话、运行记录、工作区及权限管理。不包含旧后台或企业官网。

普通编辑自动保存草稿，发布后生效；历史和回滚位于次级入口。不要在 VITE_* 中配置密钥。
