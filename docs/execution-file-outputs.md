# 执行文件产物：授权、保存、下载与清理

## 当前实现

独立重构 worktree 已在正式 Run 和已发布 Agent Chat 的共用 Deep Agents 执行服务接入文件产物。继续使用限量 `StateBackend`，不开放宿主机目录、Shell、执行器或默认长期记忆。虚拟工作区的使用边界参考 [Deep Agents Backends](https://docs.langchain.com/oss/javascript/deepagents/backends) 与 [权限](https://docs.langchain.com/oss/javascript/deepagents/permissions)。

临时文件仍随本次运行结束释放。**只有成功完成后明确选择的文件**才进入平台存储；不会保存所有 scratch、工具卸载、历史、Skill、知识库或上下文文件。文件字节存入 PostgreSQL，和本地完成记录一起提交，不增加另一套宿主机文件路径或存储服务。

## 发布配置与运行选择

Agent 版本增加 `fileOutputs: { enabled: false }`，默认关闭。新后台“执行与协作”中使用标准 Switch；查看旧版本不会自动添加或修改配置，修改后需发布。

- 单 Agent 必须获得自己的发布版本授权。
- 多 Agent 的入口与实际生成文件的成员都必须启用；成员只操作自己的虚拟工作区，不继承或复制父文件。
- 读取/写入仍计入共享工具预算。最终选择和存储是宿主操作，不额外调用规划或回答模型。
- 成员只向入口返回经过同一个受控收集器验证的文件元数据；入口可使用 `artifactIds` 明确选择，不接收成员原始文件状态或正文。

生成文件时，Agent 使用已有 `write_file` 写入 `/workspace/outputs/`，最终回答中明确列出 `filePaths`：

```json
{
  "answer": "报告已生成。",
  "filePaths": ["/workspace/outputs/report.md"]
}
```

返回既有 `outputSchema` 时可同时提供 `structured`；标准 LangChain 输出 Schema 也支持文件选择。没有文件的普通任务保持原来的直接回答，不强制创建文件、计划或成员。

只接受实际存在的本次 UTF-8 文本；不接受 caller URL、宿主机路径、编码/回退路径、二进制数据或伪造的工具产物。`execution_file` 为平台保留类型，普通 Tool/MCP 不能声明它来绕过存储权限。ID、摘要、大小和期限由服务器产生/验证，模型不能生成一个任意下载链接。

## 限额和事务

| 范围                     | 上限             |
| ------------------------ | ---------------- |
| 本次入口及成员合计       | 5 文件 / 512 KiB |
| 单文件                   | 128 KiB          |
| 工作区尚未清理的文件字节 | 128 MiB          |
| 保留时间                 | 7 天             |

支持 `.txt`、`.md`、`.json`、`.csv`、`.yaml`、`.yml` 和常见文本源码；脚本、HTML/XML 均仅作为附件下载，不执行、不预览。目录/文件名采用限长 ASCII 安全路径。文本中的常见认证/凭据字段经既有脱敏器处理，哈希与大小以保存后的实际字节为准。

Run 内存收集、存储服务和 PostgreSQL 均检查限额；工作区事务锁阻止并发绕过存储上限，Trace 行锁阻止分批超出单次上限。已发布入口/成员授权、工作区外键、执行归属和不可变文件字段有数据库触发器保护。内容只允许不可恢复清理，不能修改或恢复旧文件。

文件、文件审计与本地 Trace/会话答案在同一个事务提交：校验、超限、过期或提交前取消会回滚，不重跑模型或写工具。独立 Run 的计费完结失败会将 Trace 标为失败并撤回文件；维护任务也会回收失败执行的文件。完成事务后发生的网络断开不重新执行任务，可使用已有记录恢复结果。

不把虚拟文件状态或 Blob 加进 Trace/Phoenix/公开产物属性。**普通用户输入与模型最终答复仍属于原有业务历史**，可能包含用户要求的摘要/引用；清理文件不是删除所有会话文本、数据库备份或 WAL。

## 接口与后台

公开结果继续使用 `artifacts`：

```json
{
  "kind": "execution_file",
  "id": "<server-generated-uuid>",
  "data": {
    "filename": "report.md",
    "mimeType": "application/octet-stream",
    "byteSize": 128,
    "sha256": "<sha256>",
    "expiresAt": "<UTC timestamp>"
  }
}
```

- `GET /api/v1/agent/:agentId/artifacts/:id?userId=...`：平台密钥需 `conversations:read`；按当前应用、Agent 和外部用户对应的访客身份读取。网站访问使用原有访客令牌，不允许指定 `userId`。
- `GET /api/chat/artifacts/:id`：旧同源网站继续使用已有 HttpOnly 访客会话和 LegacyWebsiteGuard，不创建新的身份体系。
- `GET /api/admin/executions/:traceId/artifacts`：当前工作区 `conversations.read`，仅返回元数据和当前可用状态。
- `GET /api/admin/executions/:traceId/artifacts/:id`：同一读取权限，校验摘要后以附件返回。
- `DELETE /api/admin/executions/:traceId/artifacts/:id`：独立 `executions.artifacts.manage` 权限，不可恢复清理，保留文件标识、元数据和审计。

所有下载均重新鉴权，不在 URL 中放令牌或签名密钥，不开放永久公共链接。响应固定 `application/octet-stream`、`attachment`、`no-store`、`nosniff` 和 sandbox CSP。过期、清理、未完成、不属于当前身份的文件不可下载；原 ID 幂等重放不会重新生成文件。

新后台执行详情使用现有 PagePanel 和 Element Plus Table/Tag/Button/MessageBox，显示名称、大小、生成版本、到期、状态及下载/清理。下载通过现有带身份与工作区代次校验的 RequestClient Blob 请求；工作区/记录切换后丢弃旧响应，清理必须确认，不渲染文件正文。原 web 后台保留。

## 维护与迁移

迁移 `0053_execution_file_outputs.sql` 新增文件/事件表、RLS、引用/不可变触发器、清理权限，以及会话消息的产物元数据字段。迁移操作员需 **BYPASSRLS 或 superuser**；运行 HTTP 查询仍使用非所有者 runtime role。

Worker 启动后及每分钟调用受限维护函数：一次最多 200 行，固定 search_path，不接受任意表、路径或目标，只清理到期/失败执行的字节并记录系统事件。即使工作区停用也能回收；读取接口在到期瞬间停止提供文件，不等待维护任务。元数据继续保留，最终业务历史保留策略另行治理。

本次仅在随机隔离 PostgreSQL Schema 验证完整迁移及回退，**未迁移主库或重启主 API/Worker**。最终隔离部署阶段需按顺序迁移，再启动新版服务，不可让新 Worker 消费旧项目队列。

## 验证证据（2026-10-14）

- 后端全量 **502 通过、0 失败、0 跳过**，包含真实 Run HTTP → 原生 Deep Agents 写入/选择 → PostgreSQL 完成记录/文件保存 → 授权下载、重放、清理。后台 HTTP/真实 runtime RLS 验证只读与清理权限、跨工作区、内容不可变、会话历史重放、取消回滚、删除级联、停用工作区到期回收及审计。
- 入口/成员使用实际 SDK 执行，验证原始文件不流入父历史，只传经过验证的元数据；未知/伪造 ID、禁用授权、失效文件与超限不会触发旧内核或额外格式修复/收费重放。
- 新后台业务及编辑器合计 **45 项通过**，类型检查和构建通过；页面真实交互由用户验收，无浏览器自动化。
- 真实发布模型方案 **12**，使用成熟 ChatOpenAI SDK，在临时授权执行配置中完成文件生成：**2 模型 / 1 文件工具 / 4719 Token / 6 个 Phoenix Span 实际读回**。此脚本只读模型配置，不发布资源或写主库；它不等同生产 HTTP 对该模型的完整部署验收。生成/下载的持久链路使用上面的真实协议与 PostgreSQL、确定性模型单独验证。
- Phoenix 全链路确定性读回继续覆盖文件选择与持久化，文件名/正文和隐式云端追踪不导出；实际结果记录在迁移报告。

显式付费复验（先配置本地安全环境，不在终端输出密钥）：

```sh
npm run verify:files:live
```

仍需旧静态入口/重复内核清理、兼容 metadata-only 自动埋点、专项图、完整渠道/业务边缘及隔离部署。文件产物阶段不代表整体重构完成；二进制生成、代码执行沙箱、跨进程恢复和复杂长期记忆不因此被隐式启用。
