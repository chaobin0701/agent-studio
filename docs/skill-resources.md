# Skill 辅助资料：管理、版本与只读运行

## 已实现范围

在独立 Deep Agents 重构 worktree 内，Skill 可维护 `SKILL.md` 和辅助文本文件。正文、资料一起保存到现有资源版本 JSON，复用草稿修订号、验证、不可变发布、历史分支、工作区 RLS、生命周期和审计；没有新增数据库迁移，不改写历史版本。

新后台详情增加“辅助资料”页签，支持添加、修改、移除、拖放读取 UTF-8 文件，以及只读查看历史资料。读取本地文件不会自动提交，确认添加到草稿后才沿用现有自动保存。完整源码修改保留当前辅助资料；发布审阅包含资料路径及内容变化。

`SKILL.md` 单文件导入/导出保留。新增完整 JSON 包导入与导出，用于携带正文和目录资料；不把它冒充 ZIP 或第三方通用压缩包格式。

## 目录和限制

| 目录          | 内容                       | 当前运行权限             |
| ------------- | -------------------------- | ------------------------ |
| `references/` | 指南、例子、参考文档       | 只读、按需读取           |
| `assets/`     | 文本模板、JSON/CSV/YAML 等 | 只读，不渲染或执行       |
| `scripts/`    | 脚本源码                   | 只读参考，不授予执行能力 |

路径是相对虚拟路径：ASCII 字母/数字/下划线/连字符/扩展名，最多 160 字符、6 段；保留 Skill 目录前缀的空间，确保实际路径能通过文件网关。不支持绝对路径、URL、回退路径、编码路径、隐藏路径、glob、原型字段、大小写重复路径或文件/目录冲突。

- 每个 Skill 最多 16 份资料，单份最多 64 KiB，辅助资料正文合计最多 192 KiB。
- 含辅助资料的版本配置和完整 JSON 包采用序列化 UTF-8 字节限制，最多 384 KiB；原有纯文档历史配置保留既有上限，避免原文与元信息投影重复造成历史读取失效。HTTP JSON 上限仍为 512 KiB，未扩大通用请求上限。
- 只支持有效 UTF-8 文本，拒绝二进制、危险控制字符和不完整 Unicode。草稿正文可为空，但仍不能验证或发布。
- 单 Agent 挂载的 Skill 文件合计最多 64 个、1 MiB；后台验证与运行时均检查，防止发布一个无法挂载的组合。
- 超大 HTTP 请求返回安全的 `413 / payload_too_large`，不返回原请求正文或错误堆栈。

原有不带资料的配置默认 `resources: []`。资料不在 YAML 中另建权限配置，也不能指定下载 URL、宿主机文件或可执行标志。

## Deep Agents 运行

依照框架的渐进式加载模式：启动只加载简介；模型需要时读取 `SKILL.md`，随后按需读取参考文件。原生 `StateBackend` 承载虚拟文件，不使用宿主机 FilesystemBackend。目录组织和按需读取遵循 [Deep Agents Skills](https://docs.langchain.com/oss/javascript/deepagents/skills)。

平台使用不可变 Skill Key 生成标准目录别名，文件均挂载到 `/skills/<alias>/`。引导文件的宿主附录列出实际辅助路径，不预加载辅助正文。管理员可在正文使用 `references/guide.md` 等相对引用，模型根据该目录的完整路径读取。

框架权限规则和后端均禁止改写、删除或覆盖发布文件，直接调用后端也不能绕过。根 Agent 与成员只挂载自己的固定版本；不继承父 Skill、资料、历史、模型或能力。目录内存在脚本或工具声明不等于获授权，没有 Shell/execute/eval。

读取资料计入同一工具预算和期限，并记录 Skill Key / 版本及文件操作状态。Phoenix 只记录白名单元数据，不上传资料路径、正文、指导、脚本、模型输入输出或凭据。单文件导出不是任务产物；Run 文件产物已有独立的授权保存/下载/清理能力，见 [文件产物](execution-file-outputs.md)，不复用管理资源导出。

## 接口与传输

管理权限沿用 `agent_config.read` / `agent_config.manage`，资料只包含在管理员资源接口，不放入公开 SSE。

- `POST /api/admin/agent-resources/skill-bundle`：验证并解析完整包，返回创建/审阅所需配置，不自动创建、发布或授权。
- 既有资源创建和 `PATCH /versions/:id`：配置增加 `resources: [{ path, content }]`，全部随版本保存。
- 既有 `GET /versions/:id/skill-document?format=portable`：同时返回 `document`、`resources`、`bundle` 和诊断，允许只读管理员下载持久版本。
- 既有 `POST /skill-document/export`：验证传入配置并返回同一结果；新后台“导出完整包”保存为 `.skill.json`。“导出 SKILL.md”仅下载正文，有资料时提示使用完整包。

完整包示例：

```json
{
  "format": "agent-skill-bundle",
  "version": 1,
  "document": "---\nname: example-skill\ndescription: Read reference when needed\n---\n\nRead references/guide.md.\n",
  "resources": [
    { "path": "references/guide.md", "content": "Supporting guidance." }
  ]
}
```

使用既有平台格式导出时仍保留兼容声明；标准格式去除本地知识库 ID/内部 Key 等扩展。任何声明都不变成数据库绑定或执行权限。

## 验证（2026-10-14）

- 后端全量 **493 通过、0 失败、0 跳过**。新增真实 loopback HTTP + PostgreSQL 验证导入/下载、草稿更新、发布保护、修订号冲突、只读账号、跨工作区隔离及大小限制。数据库、迁移和资源均位于可清理的测试 Schema；没有启动生产 AppModule 或消费 pg-boss。
- 原生单 Agent 与成员实际运行 Deep Agents 框架，验证简介/正文/资料分级读取、只读保护、成员隔离、共享用量和元数据追踪；模型为确定性测试 Provider，不等同本阶段真实供应商资料读取效果评测。
- Phoenix 最新确定性验收 **56 项通过、28 条执行树 / 173 个 span 实际读回**，两个成员 Skill 文件读取保留版本关联且不泄漏内容。
- 新后台 **26 项测试**，另有编辑器 **14 项**，类型检查和构建通过；页面实际交互由用户验收，不运行浏览器自动化。
- 旧 web / 网站保持保留，主项目服务不切换到 worktree；最终隔离部署仍待完成。SDK 的此前真实供应商证据见 [模型 SDK](model-sdk-adapter.md)。

尚不支持 ZIP 解压、二进制资料、脚本运行、自动生成并发布 Skill。受控沙箱或格式扩展应另行设计权限、存储、限额和执行审计。
