# Agent 输出规范

- Agent → 输出规范：文本或结构化 JSON。新 Agent 默认文本；旧版本缺少 `output` 时继续兼容调用方 `outputSchema`，不会自动写回旧配置。
- 配置随草稿、发布、差异与回滚保存。只定义 `structured`，不改变回答、ID、用量、引用和产物的现有外层接口。
- Agent Studio Showcase 可在根对象中添加可选的 `suggestedFollowUps` 字符串数组（最多 3 条，每条最多 120 字），前台仅将它显示为追问建议；点击只填入草稿，不会发送。建议与回答一起返回、保存并随历史恢复，不额外调用模型。
- 简单字段使用表格；嵌套、数组、可空类型与额外约束保留源码。复用 CodeMirror、Element Plus、Ajv 和 jsonc-parser，前后端共用 `@agent-studio/output-contract`。
- 支持对象、数组、string/number/integer/boolean/null、单一类型附加 null、基础值枚举、长度与数值边界。默认 `additionalProperties:false`；不支持引用、正则、组合和未知关键字。
- 上限沿用 12000 字符、10 层、1000 节点。导入校验并确认后才替换；示例和 JSON 校验完全在本地进行，不调用模型。
- `/messages`、`/runs`、Chatbot、草稿试运行共用规范解析。固定规范不能被请求覆盖；成员使用自己的规范，入口决定最终结果。回放返回原执行结果。
- 不合规结果失败并保留已发生的调用与用量；不转换类型、不删除额外字段、不补默认值、不自动重跑或降级成功。拒绝结果无需伪造业务字段。
- 流式输出只在完成验证后提交完整结构化结果。Trace 记录版本、来源、Schema 哈希、校验状态和有界错误路径；普通执行页不暴露 Schema、原始模型内容和凭据。

本期不包含输入参数契约和 Chatbot 自定义动作渲染；交互动作模板仅返回通用数据。
