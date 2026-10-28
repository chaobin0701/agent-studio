# Agent Studio 架构简化重构计划

> 基于 2025-01-28 讨论整理  
> 分支: `refactor/simplify-architecture`

---

## 一、核心问题分析

### 1.1 当前项目定位模糊

**问题**：
- README 定位为"企业级通用智能体编排与运行平台"
- 实际实现像一个"全栈 AI 应用 IDE"
- 后台 16 个功能模块，代码 33,864 行，复杂度过高

**建议定位**：
```
Agent Studio = Agent as a Service (AaaS)

将企业的 AI 能力封装为可版本控制、可审计、可复用的托管服务，
让业务系统像调用微服务一样调用 Agent。
```

**对标**：
- 不是 LangChain（开发框架）→ 我们是托管运行时
- 不是 Dify（低代码平台）→ 我们不提供可视化编程
- 不是 OpenAI API（单一厂商）→ 我们多模型 + 自托管
- 不是 n8n（通用自动化）→ 我们专注 LLM 推理编排

---

### 1.2 版本依赖级联更新问题

**问题**：
```typescript
// agent 完全锁定依赖版本 ID
{
  promptVersionId: 123,
  toolVersionIds: [456, 789],
  skillVersionIds: [101, 102]
}
```

**后果**：
- Tool 修复一个 bug → 10+ 个 Agent 需要重新发布
- Knowledge 更新内容 → Agent 需要重新发布
- 版本爆炸，维护噩梦

**建议**：混合版本策略
| 资源 | 策略 | 理由 |
|------|------|------|
| Prompt | 🔒 强锁定版本 ID | 直接决定行为 |
| Model | 🔒 强锁定版本 ID | 影响成本和输出 |
| Tool | 🔓 软锁定 Key + 可选版本 | 透明升级 |
| Skill | 🔓 软锁定 Key + 可选版本 | 修复不触发级联 |
| Knowledge | 📌 指向 Latest | 内容更新立即生效 |

---

### 1.3 工作区机制过度复杂

**问题**：
- 177 处代码引用 `workspace_id`
- PostgreSQL RLS 行级安全
- AsyncLocalStorage 上下文管理
- 复杂权限（owner/manager/reader/custom + 细粒度权限码）

**建议**：
- 从"多租户 SaaS"简化为"单实例平台"
- 删除工作区机制
- 用户级别的简单权限（admin/user）
- 资源级可见性（public/private）

**效果**：
- 代码量减少 25-30%
- 用户体验更直观
- 部署更简单

---

## 二、需要砍掉的功能

### 2.1 立即删除（无争议）

#### ❌ SystemMcpModule
- **位置**：`server/src/system-mcp/`
- **代码量**：~500 行
- **理由**：系统诊断应该是外部监控工具的职责，不属于平台核心
- **替代方案**：OpenTelemetry + LangSmith

#### ❌ ChatbotModule
- **位置**：`server/src/chatbot/`
- **理由**：独立聊天机器人与 Agent 平台定位不符
- **替代方案**：ChatModule 已经处理对话，Showcase 项目展示 UI

#### ❌ Workflow 编辑器
- **位置**：`admin-vben/.../resources/WorkflowTestDialog.vue`
- **理由**：Agent 本身就是工作流（LangGraph），重复概念
- **替代方案**：外部工具编写，通过 API 导入

#### ❌ OutputContract 树形编辑器
- **位置**：`admin-vben/.../resources/OutputFieldTree.vue`
- **理由**：复杂的 UI 编辑器不属于后台
- **替代方案**：JSON 文本编辑 + IDE 插件

---

### 2.2 需要评估（可选）

#### ⚠️ Artifacts 制品系统
- **位置**：`server/src/artifacts/`
- **评估点**：是否有用户依赖？与 ExecutionModule 重复？

#### ⚠️ 多 Agent 协作（Collaboration）
- **位置**：`agentCollaborationSchema` in resource.types.ts
- **评估点**：使用频率？是否可以简化为外部编排？

---

## 三、需要简化的模块

### 3.1 AI 模块（61 个文件 → 目标 30-35 个）

**当前结构**：
```
server/src/ai/
├── agent/              (13 files)
├── deep-agents/        (12 files)  ← 合并到 agent
├── mcp/                (9 files)
├── providers/          (13 files)
├── runtime/            (8 files)   ← 精简
├── skills/             (6 files)
├── tools/              (16 files)
└── workflows/          (7 files)   ← 考虑删除或简化
```

**简化方案**：
1. 合并 `agent/` 和 `deep-agents/`
2. 将 `workflows/` 作为 agent 的执行模式，而非独立子系统
3. 精简 `runtime/` 层，减少间接调用

---

### 3.2 知识库检索（9 个服务 → 目标 4-5 个）

**当前服务**：
- `document.service.ts`
- `knowledge-index.service.ts`
- `search.service.ts`
- `version-search.service.ts` ← 合并
- `embedding.service.ts` ← 合并到 indexing
- `embedding-profile.service.ts`
- `knowledge-base.service.ts`
- `document-queue.service.ts`

**简化方案**：
1. 合并 `search.service` + `version-search.service`
2. 合并 `embedding.service` + `knowledge-index.service` → `indexing.service`
3. 保留核心：`knowledge-base.service`, `indexing.service`, `search.service`, `document-queue.service`

---

### 3.3 前端模块（16 个页面 → 目标 8-10 个）

**当前页面**：
```
admin-vben/apps/web-ele/src/views/
├── overview/           ✅ 保留
├── resources/          ✅ 保留（Agents）
├── prompts/            ✅ 保留
├── tools/              ✅ 保留
├── knowledge/          ✅ 保留
├── models/             ✅ 保留
├── executions/         ✅ 保留
├── integrations/       ⚠️ 简化
├── mcp/                ⚠️ 合并到 tools
├── system-mcp/         ❌ 删除
├── chatbot/            ❌ 删除
├── playground/         ⚠️ 合并到 executions
├── workspaces/         ❌ 删除
└── system/             ✅ 保留（改为用户管理）
```

---

## 四、推荐的重构顺序

### 🎯 Phase 1: 快速胜利（立即删除冗余模块）

**优先级**：⭐⭐⭐⭐⭐  
**工作量**：1-2 天  
**风险**：极低  

**任务清单**：
- [ ] 1.1 删除 `SystemMcpModule`
  - 删除 `server/src/system-mcp/`
  - 删除 `admin-vben/.../views/system-mcp/`
  - 从 `app.module.ts` 移除导入
  - 更新路由配置
  
- [ ] 1.2 删除 `ChatbotModule`
  - 删除 `server/src/chatbot/`
  - 删除 `admin-vben/.../views/chatbot/`
  - 从 `app.module.ts` 移除导入
  
- [ ] 1.3 删除 Workflow 编辑器前端组件
  - 删除 `WorkflowTestDialog.vue`
  - 保留后端 `workflows/` 暂时不动（评估中）
  
- [ ] 1.4 删除 OutputFieldTree 编辑器
  - 改为简单的 JSON 文本编辑

**验证**：
```bash
npm run typecheck
npm run build
npm test
```

---

### 🎯 Phase 2: Tool 依赖软锁定

**优先级**：⭐⭐⭐⭐⭐  
**工作量**：1-2 周  
**风险**：中等（需要数据迁移）  

**任务清单**：
- [ ] 2.1 设计新的 `toolBindings` 数据结构
  ```typescript
  {
    toolBindings: [
      { key: "order_query", versionConstraint: "latest" },
      { key: "payment_refund", versionConstraint: "breaking-v2" },
      { key: "legacy_api", pinnedVersionId: 123 }
    ]
  }
  ```

- [ ] 2.2 Tool 版本增加 `breakingVersion` 字段
  - 修改 `toolSchema` in `resource.types.ts`
  - 数据库迁移：添加列

- [ ] 2.3 实现运行时版本解析逻辑
  - 在 `runtime-scope.ts` 添加 `resolveToolVersion()`
  - 支持 "latest", "breaking-vX", "pinned" 三种策略

- [ ] 2.4 数据迁移脚本
  - 将现有 `toolVersionIds` 转换为 `toolBindings`
  - 保留旧字段 3 个月用于回滚

- [ ] 2.5 前端 UI 适配
  - Agent 编辑器中的 Tool 选择器
  - 显示版本锁定策略选项

- [ ] 2.6 同样逻辑应用到 `skillBindings`

**验证**：
- 旧 Agent 仍能正常运行
- 新创建的 Agent 使用 toolBindings
- Tool 更新后 Agent 自动使用新版本

---

### 🎯 Phase 3: Knowledge Base 解绑版本

**优先级**：⭐⭐⭐⭐  
**工作量**：3-5 天  
**风险**：低  

**任务清单**：
- [ ] 3.1 移除 Agent 对 `indexVersionId` 的锁定
- [ ] 3.2 运行时自动使用 `active_index_version_id`
- [ ] 3.3 前端简化为"启用的知识库列表"

**效果**：
- 知识库更新内容，Agent 立即生效
- 无需重新发布 Agent

---

### 🎯 Phase 4: AI 模块精简

**优先级**：⭐⭐⭐  
**工作量**：1-2 周  
**风险**：中等（核心逻辑调整）  

**任务清单**：
- [ ] 4.1 合并 `agent/` 和 `deep-agents/`
  - 评估两者差异
  - 统一接口
  - 测试覆盖

- [ ] 4.2 精简 `runtime/` 层
  - 减少服务间跳转
  - 合并相似职责的类

- [ ] 4.3 评估 `workflows/` 是否保留
  - 如果使用率低，考虑删除
  - 否则简化为 agent 的一个执行模式

---

### 🎯 Phase 5: 知识库检索链路简化

**优先级**：⭐⭐⭐  
**工作量**：1 周  
**风险**：低  

**任务清单**：
- [ ] 5.1 合并 `search.service` + `version-search.service`
- [ ] 5.2 合并 `embedding.service` + `knowledge-index.service` → `indexing.service`
- [ ] 5.3 更新导入和依赖注入

---

### 🎯 Phase 6: 权限系统简化

**优先级**：⭐⭐⭐⭐  
**工作量**：1 周  
**风险**：中等（需要数据迁移）  

**任务清单**：
- [ ] 6.1 简化角色模型
  ```typescript
  // 从：owner | manager | reader | custom
  // 到：admin | user
  ```

- [ ] 6.2 删除细粒度权限码
  - 移除 `permission_codes` 字段
  - 简化权限检查逻辑

- [ ] 6.3 数据迁移
  ```sql
  UPDATE workspace_members
  SET role = CASE
    WHEN role IN ('owner', 'manager') THEN 'admin'
    ELSE 'user'
  END;
  ```

- [ ] 6.4 前端移除权限配置 UI

---

### 🎯 Phase 7: 工作区移除准备

**优先级**：⭐⭐⭐⭐⭐  
**工作量**：1 周  
**风险**：低（准备阶段）  

**任务清单**：
- [ ] 7.1 为所有资源表添加字段
  ```sql
  ALTER TABLE agent_resources 
  ADD COLUMN owner_id bigint REFERENCES users(id),
  ADD COLUMN visibility text DEFAULT 'private' 
    CHECK (visibility IN ('public', 'private'));
  ```

- [ ] 7.2 编写数据迁移脚本
  ```typescript
  // scripts/migrate-remove-workspaces.ts
  // 将 workspace 数据映射到 owner_id
  ```

- [ ] 7.3 在测试环境验证迁移脚本
  - 正向迁移
  - 回滚脚本
  - 数据完整性检查

- [ ] 7.4 **不执行迁移**，等待 Phase 8

---

### 🎯 Phase 8: 工作区完全移除（最大改动）

**优先级**：⭐⭐⭐⭐⭐  
**工作量**：2-3 周  
**风险**：高（架构级变更）  

**前置条件**：
- Phase 6 (权限简化) 已完成
- Phase 7 (迁移准备) 已完成并验证

**任务清单**：
- [ ] 8.1 执行数据迁移
  ```bash
  npm run migrate:remove-workspaces
  ```

- [ ] 8.2 删除后端工作区模块
  - 删除 `server/src/workspaces/`
  - 从所有 service 移除 `workspaceId` 参数
  - 删除 `workspace-context.ts` 的 AsyncLocalStorage
  - 移除 RLS 策略

- [ ] 8.3 更新查询逻辑
  ```typescript
  // 从：WHERE workspace_id = $1
  // 到：WHERE (visibility = 'public' OR owner_id = $1)
  ```

- [ ] 8.4 前端大幅简化
  - 删除 `admin-vben/.../views/workspaces/`
  - 删除顶部工作区选择器
  - 简化导航结构（16 页面 → 8 页面）

- [ ] 8.5 更新所有测试
  - 单元测试
  - 集成测试
  - E2E 测试

- [ ] 8.6 更新文档
  - README.md
  - 部署文档
  - API 文档

**验证**：
- 所有功能测试通过
- 性能测试（查询性能应该更好，因为去掉了 RLS）
- 安全测试（确保 visibility 逻辑正确）

---

### 🎯 Phase 9: 前端模块整合

**优先级**：⭐⭐⭐  
**工作量**：1 周  
**风险**：低  

**任务清单**：
- [ ] 9.1 合并 `playground/` 和 `chatbot/` 到 `executions/`
- [ ] 9.2 合并 `mcp/` 到 `tools/`
- [ ] 9.3 简化 `integrations/` 页面
- [ ] 9.4 扁平化前端结构
  - 去掉 `apps/` 层级（只有一个 web-ele）
  - 如果可行，移动到 `admin-vben/src/`

---

## 五、成功指标

### 5.1 代码量目标

| 模块 | 当前 | 目标 | 减少 |
|------|------|------|------|
| 后端总计 | 33,864 行 | ~18,000 行 | -47% |
| AI 模块 | 61 文件 | 30-35 文件 | -43% |
| 前端页面 | 16 个 | 8-10 个 | -40% |

### 5.2 功能指标

- ✅ Tool 更新不触发 Agent 级联发布
- ✅ Knowledge 更新立即生效
- ✅ 用户注册后直接创建 Agent（无工作区概念）
- ✅ 部署简化（无需配置 RLS）
- ✅ 查询性能提升（去掉 RLS 开销）

### 5.3 保留的核心价值

- ✅ 不可变版本快照（Agent 级别）
- ✅ MCP 原生支持
- ✅ Human-in-the-Loop
- ✅ 混合 RAG 检索
- ✅ LangSmith 追踪

---

## 六、风险控制

### 6.1 回滚策略

每个 Phase 完成后：
1. 打 tag：`refactor/phase-N-complete`
2. 在生产环境灰度发布
3. 观察 1 周无问题再进入下一 Phase
4. 如有问题，`git revert` 到上一个 tag

### 6.2 数据备份

在执行 Phase 7/8（工作区移除）前：
```bash
# 备份生产数据库
pg_dump agent_studio_prod > backup_$(date +%Y%m%d).sql

# 在测试环境完整验证迁移脚本
npm run migrate:remove-workspaces -- --dry-run
```

### 6.3 功能开关

对于大的改动（如 Tool 软锁定），使用 feature flag：
```typescript
const USE_TOOL_BINDINGS = process.env.FEATURE_TOOL_BINDINGS === 'true';

if (USE_TOOL_BINDINGS) {
  // 新逻辑
} else {
  // 旧逻辑（兜底）
}
```

---

## 七、时间线（总计 10-14 周）

```
Week 1-2:   Phase 1 (删除冗余) + Phase 2 开始 (Tool 软锁定)
Week 3-4:   Phase 2 完成 + Phase 3 (Knowledge 解绑)
Week 5-6:   Phase 4 (AI 模块精简) + Phase 5 (知识库简化)
Week 7:     Phase 6 (权限简化)
Week 8:     Phase 7 (工作区移除准备)
Week 9-11:  Phase 8 (工作区完全移除) ← 最大改动
Week 12:    Phase 9 (前端整合)
Week 13-14: 全量测试 + 文档更新 + 灰度发布
```

---

## 八、下一步行动

请从以下 Phase 中选择：

1. **Phase 1 (快速胜利)** - 删除冗余模块，立即见效
2. **Phase 2 (Tool 软锁定)** - 解决版本级联问题
3. **Phase 3 (Knowledge 解绑)** - 简单且独立
4. 或者你有其他优先级？

告诉我：
- ✅ 哪些要做
- ❌ 哪些不做
- 🔄 是否调整顺序

我会根据你的选择给出下一步的详细实施计划。
