# Agent Studio + Showcase 展示环境

此目录是两个独立开源项目在同一服务器上的部署入口。`Agent Studio` 提供管理后台、后台聊天、API 和 Worker；[Agent Studio Showcase](https://github.com/chaobin0701/agent-studio-showcase) 提供官网、两个体验和模拟业务数据。业务数据仅通过 Showcase 的 HTTP / MCP 工具接入平台。

## 当前生产环境

| 入口 | 路由 |
| --- | --- |
| `https://hexu.7410000.xyz/` | Showcase 官网、项目介绍、两个 Demo 聊天与工具 |
| `https://hexu-admin.7410000.xyz/` | Agent Studio 管理后台 |
| `https://hexu-admin.7410000.xyz/api/` | Agent Studio API |

服务器工作目录为 `/opt/agent-studio`，Compose 项目名为 `agent-studio-showcase`。生产镜像分别为 `agent-studio-server`、`agent-studio-edge`、`demo-hub`，版本由私有 `.env` 的 `RELEASE_TAG` 固定。PostgreSQL、上传文件、Hub SQLite 数据库和 Caddy 证书均放在该目录的 `data/` 下；API 和 Hub 容器端口只绑定服务器回环地址，Caddy 占用公网 80/443。Worker 通过 `--profile worker` 启动。

部署凭据仅保存在服务器私有环境文件中，不能写入仓库。两个站点的 HTTPS 域名、工具白名单和浏览器 Origin 必须保持一致；工具在 Docker 网络内通过域名指向新 Caddy。业务工具改址应通过 Agent Studio 的现有草稿、测试、发布和 MCP 发现 API 完成，不直接修改数据库。

本次替换保留了旧系统 `/opt/hexu-support`，旧容器已停止，旧 `hexu-backup.timer` 已关闭；切换时的停机归档保存在 `/opt/agent-studio/backups/hexu-cold-*.tar.gz`。归档含旧系统配置和数据，只可由服务器管理员读取。当前生产使用 Agent Studio 自身的独立数据库快照，未连接或导入旧禾序业务数据库。部署时已为管理员重新设置随机密码；密码只在本地私有交接文件和服务器私有文件中，仓库不保存。

## 操作与验证

在服务器上执行：

```sh
cd /opt/agent-studio
docker compose --profile worker ps
systemctl status agent-studio-backup.timer
systemctl start agent-studio-backup.service
latest="$(find backups -mindepth 1 -maxdepth 1 -type d -name '20*' | sort | tail -1)"
( cd "$latest" && sha256sum -c manifest.sha256 )
```

`backup.sh` 每次在线导出 PostgreSQL，使用 SQLite 在线备份 API 复制 Hub 数据库，再归档上传文件、Caddy 状态、Compose 与私有环境配置；生成 `manifest.sha256` 后才将临时目录移入 `backups/`。`agent-studio-backup.timer` 每天按上海时间 03:45 运行。备份含密钥，必须维持私有目录权限并交由管理员设置异地留存和保留周期。

公网检查：访问官网、两个 Demo 和后台；检查 `/api/health`。在携带生产工具令牌的受控环境中，可以运行 Showcase 的 `scripts/verify-production.mjs --tools-only` 对照 HTTP/MCP；完整验证还会发起真实 Agent 对话。运行前必须显式设置 `SITE_ORIGIN` 与必要令牌。常规测试、构建不会启动这个脚本，也不会自动启用应用或扩大 Origin。

## 回滚

如新服务发生故障，服务器管理员可运行：

```sh
/opt/agent-studio/rollback.sh
```

脚本会停用新备份定时器、停止新服务，再启动保留在本机的旧 PostgreSQL、API、Worker、Caddy，确认旧数据库与 API 健康后恢复旧备份定时器。脚本不删除新数据或旧停机归档。回滚完成后应重新检查两个 HTTPS 域名。再次切回新服务前，先确认两边数据变更和备份状态。
