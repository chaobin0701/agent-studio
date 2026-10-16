<script setup lang="ts">
import { ref } from "vue";
import {
  ElCollapse,
  ElCollapseItem,
  ElEmpty,
  ElDescriptions,
  ElDescriptionsItem,
  ElTable,
  ElTableColumn,
  ElTabPane,
  ElTabs,
  ElTag,
} from "element-plus";
import type { ExecutionView } from "#/api/executions";
import AttemptTable from "./AttemptTable.vue";
import HelpTip from "#/components/HelpTip.vue";
defineProps<{ execution: ExecutionView }>();
const tab = ref("steps");
const labels: Record<string, string> = {
  skill_loaded: "加载 Skill",
  preflight: "预检索",
  llm_call: "模型决策",
  tool_call: "工具执行",
  validation: "结果校验",
  summary: "上下文摘要",
  delegation: "委派成员",
  workflow: "专项流程",
};
const nodeLabels: Record<string, string> = {
  model: "模型执行",
  tools: "工具执行",
  skills: "读取 Skill",
  task: "委派成员",
  finalize: "结果校验",
  initialize_context: "初始化上下文",
  model_decision: "模型决策",
  execute_tools: "工具执行",
  load_skill: "读取 Skill",
  run_skill: "隔离任务",
  delegate_agent: "委派成员",
  finalize_result: "结果校验",
};
const purposeLabels: Record<string, string> = {
  planner: "任务决策",
  summary: "上下文摘要",
  answer: "生成回答",
};
const modes: Record<string, string> = {
  fulltext: "全文",
  vector: "向量",
  hybrid: "混合",
  auto: "自动适配",
};
const fallbackReasons: Record<string, string> = {
  index_has_no_vectors: "未开启向量索引",
  index_model_unavailable: "向量模型不可用",
  model_mismatch: "向量模型不兼容",
  index_not_ready: "索引未就绪",
};
const budgetValue = (used?: number, limit?: number) =>
  `${used ?? "—"} / ${limit ?? "未记录"}`;
</script>
<template>
  <div class="min-w-0 space-y-3">
    <ElDescriptions
      v-if="Object.keys(execution.budget ?? {}).length"
      :column="1"
      size="small"
      border
    >
      <template #title>
        <span class="inline-flex items-center gap-1">
          任务总预算
          <HelpTip
            long
            text="显示已用量／本次生效上限，包含入口、成员、摘要和实际重试。请求限制更低时使用较低值。计入预算的 Token 包含失败或未知用量的保守估算，不等于账单用量；费用以模型调用账本为准。历史记录未保存上限时显示未记录。"
          />
        </span>
      </template>
      <ElDescriptionsItem label="模型调用">
        {{
          budgetValue(
            execution.budget.modelCalls,
            execution.budget.maxModelCalls,
          )
        }}
      </ElDescriptionsItem>
      <ElDescriptionsItem label="工具调用">
        {{
          budgetValue(execution.budget.toolCalls, execution.budget.maxToolCalls)
        }}
      </ElDescriptionsItem>
      <ElDescriptionsItem label="计入预算的 Token">
        {{
          budgetValue(
            execution.budget.totalTokens,
            execution.budget.maxTotalTokens,
          )
        }}
      </ElDescriptionsItem>
    </ElDescriptions>
    <div v-if="execution.graphNodes.length" class="flex flex-wrap gap-2">
      <ElTag
        v-for="(node, index) in execution.graphNodes"
        :key="index"
        type="info"
        >{{ index + 1 }} · {{ nodeLabels[node] || node }}</ElTag
      >
    </div>
    <ElTabs v-model="tab">
      <ElTabPane label="执行步骤" name="steps">
        <ElTable :data="execution.steps" empty-text="此历史记录未保存步骤信息">
          <ElTableColumn type="expand"
            ><template #default="{ row }"
              ><AttemptTable :attempts="row.attemptsTrail" /></template
          ></ElTableColumn>
          <ElTableColumn label="步骤" min-width="150"
            ><template #default="{ row }"
              >{{ labels[row.type] || row.type
              }}{{
                row.plannerRound ? ` · 第 ${row.plannerRound} 轮` : ""
              }}</template
            ></ElTableColumn
          >
          <ElTableColumn label="能力" min-width="160"
            ><template #default="{ row }">{{
              row.name || row.skillId || row.model || "—"
            }}</template></ElTableColumn
          >
          <ElTableColumn label="状态" width="110"
            ><template #default="{ row }"
              ><ElTag
                :type="row.deferred ? 'info' : row.ok ? 'success' : 'danger'"
                >{{
                  row.deferred
                    ? "等待重规划"
                    : row.reused
                      ? "复用结果"
                      : row.ok
                        ? "成功"
                        : "失败"
                }}</ElTag
              ></template
            ></ElTableColumn
          >
          <ElTableColumn
            prop="durationMs"
            label="耗时 ms"
            width="110"
          /><ElTableColumn prop="totalTokens" label="Token" width="100" />
          <ElTableColumn prop="errorCode" label="错误分类" min-width="180" />
        </ElTable>
      </ElTabPane>
      <ElTabPane label="模型与重试" name="models">
        <ElTable :data="execution.models" empty-text="无模型调用记录">
          <ElTableColumn label="状态" width="130"
            ><template #default="{ row }"
              ><ElTag
                :type="
                  row.ok === false ? 'danger' : row.ok ? 'success' : 'info'
                "
                >{{
                  row.ok === false
                    ? row.retryExhausted
                      ? "重试耗尽"
                      : "失败"
                    : row.ok
                      ? "成功"
                      : "历史记录"
                }}</ElTag
              ></template
            ></ElTableColumn
          >
          <ElTableColumn label="用途" min-width="130"
            ><template #default="{ row }">{{
              purposeLabels[row.purpose] || row.purpose || "—"
            }}</template></ElTableColumn
          >
          <ElTableColumn type="expand"
            ><template #default="{ row }"
              ><AttemptTable :attempts="row.attemptsTrail" /></template
          ></ElTableColumn>
          <ElTableColumn
            prop="model"
            label="模型"
            min-width="200"
          /><ElTableColumn prop="plannerRound" label="轮次" width="80" />
          <ElTableColumn
            prop="attempts"
            label="尝试次数"
            width="100"
          /><ElTableColumn prop="durationMs" label="耗时 ms" width="110" />
          <ElTableColumn
            prop="inputTokens"
            label="输入 Token"
            width="110"
          /><ElTableColumn
            prop="outputTokens"
            label="输出 Token"
            width="110"
          /><ElTableColumn prop="totalTokens" label="总 Token" width="110" />
          <ElTableColumn prop="errorCode" label="错误分类" min-width="180" />
          <ElTableColumn prop="finishReason" label="结束原因" min-width="140" />
        </ElTable>
      </ElTabPane>
      <ElTabPane label="工具与检索" name="tools">
        <ElTable :data="execution.tools" empty-text="此次执行未调用工具">
          <ElTableColumn type="expand"
            ><template #default="{ row }">
              <div class="space-y-3 p-3">
                <AttemptTable :attempts="row.attemptsTrail" />
                <template v-if="row.retrieval.libraries.length"
                  ><p class="text-sm">
                    问题向量生成：{{ row.retrieval.embeddingCalls ?? 0 }} 次 ·
                    向量方案版本
                    {{ row.retrieval.embeddingPlanVersionId ?? "—" }}
                  </p>
                  <ElTable :data="row.retrieval.libraries" size="small"
                    ><ElTableColumn
                      prop="knowledgeBaseId"
                      label="知识库 ID"
                    /><ElTableColumn
                      prop="indexVersionId"
                      label="索引版本 ID"
                    />
                    <ElTableColumn label="实际检索"
                      ><template #default="{ row: kb }">{{
                        modes[kb.retrievalMode] || kb.retrievalMode
                      }}</template></ElTableColumn
                    >
                    <ElTableColumn label="兼容回退" min-width="160"
                      ><template #default="{ row: kb }">{{
                        fallbackReasons[kb.fallbackReason] ||
                        kb.fallbackReason ||
                        "无"
                      }}</template></ElTableColumn
                    >
                  </ElTable>
                </template>
              </div>
            </template></ElTableColumn
          >
          <ElTableColumn
            prop="name"
            label="工具"
            min-width="200"
          /><ElTableColumn label="状态" width="115"
            ><template #default="{ row }"
              ><ElTag
                :type="row.deferred ? 'info' : row.ok ? 'success' : 'danger'"
                >{{
                  row.deferred
                    ? "未执行"
                    : row.reused
                      ? "复用"
                      : row.ok
                        ? "成功"
                        : "失败"
                }}</ElTag
              ></template
            ></ElTableColumn
          >
          <ElTableColumn
            prop="attempts"
            label="尝试次数"
            width="110"
          /><ElTableColumn
            prop="durationMs"
            label="耗时 ms"
            width="110"
          /><ElTableColumn prop="errorCode" label="错误分类" min-width="180" />
        </ElTable>
      </ElTabPane>
      <ElTabPane
        v-if="execution.specializedFlows?.length"
        label="专项流程"
        name="workflows"
      >
        <ElTable :data="execution.specializedFlows">
          <ElTableColumn
            prop="key"
            label="流程"
            min-width="200"
            show-overflow-tooltip
          />
          <ElTableColumn prop="version" label="代码版本" width="110" />
          <ElTableColumn label="状态" width="100"
            ><template #default="{ row }"
              ><ElTag :type="row.ok ? 'success' : 'danger'">{{
                row.ok ? "完成" : "未完成"
              }}</ElTag></template
            ></ElTableColumn
          >
          <ElTableColumn prop="nodes" label="节点数" width="100" />
          <ElTableColumn prop="modelCalls" label="模型步骤" width="110" />
          <ElTableColumn prop="toolCalls" label="工具步骤" width="110" />
          <ElTableColumn prop="durationMs" label="耗时 ms" width="110" />
          <ElTableColumn prop="errorCode" label="错误分类" min-width="180" />
        </ElTable>
      </ElTabPane>
      <ElTabPane :label="`子任务 (${execution.tasks.length})`" name="tasks">
        <ElEmpty
          v-if="!execution.tasks.length"
          description="此次执行未创建子任务"
        />
        <ElCollapse v-else
          ><ElCollapseItem
            v-for="(task, index) in execution.tasks"
            :key="index"
            :name="index"
          >
            <template #title
              ><div class="flex flex-wrap items-center gap-3">
                <span
                  >{{ task.type === "run_skill" ? "Skill" : "成员 Agent" }} ·
                  {{ task.key }}</span
                ><ElTag :type="task.ok ? 'success' : 'danger'">{{
                  task.ok ? "完成" : task.errorCode || "未完成"
                }}</ElTag
                ><span class="text-muted-foreground"
                  >版本 ID {{ task.agentVersionId }} · Token
                  {{ task.totalTokens ?? "—" }}</span
                >
              </div></template
            >
            <ExecutionTree :execution="task.execution" /> </ElCollapseItem
        ></ElCollapse>
      </ElTabPane>
    </ElTabs>
  </div>
</template>
