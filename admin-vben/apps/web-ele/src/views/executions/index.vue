<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Page } from "@vben/common-ui";
import { useAccessStore } from "@vben/stores";
import ManagementHeader from "#/components/ManagementHeader.vue";
import { managementApi } from "#/api/management";
import {
  ElAlert,
  ElButton,
  ElInputNumber,
  ElOption,
  ElPagination,
  ElSelect,
  ElTable,
  ElTableColumn,
  ElTag,
} from "element-plus";
import PagePanel from "#/components/PagePanel.vue";
import { executionsApi, type ExecutionRecord } from "#/api/executions";
import { useWorkspaceStore } from "#/store/workspace";

const router = useRouter(),
  route = useRoute(),
  workspace = useWorkspaceStore(),
  access = useAccessStore();
const canReadAgents = computed(
  () =>
    access.accessCodes.includes("agent_config.read") ||
    access.accessCodes.includes("agent_config.manage"),
);
const agents = ref<any[]>([]),
  agentsError = ref("");
let agentGeneration = 0;
async function loadAgents() {
  const request = ++agentGeneration,
    scope = workspace.generation;
  agents.value = [];
  agentsError.value = "";
  if (!canReadAgents.value) return;
  try {
    const result = await managementApi.get("/agent-resources?state=all");
    if (request === agentGeneration && scope === workspace.generation)
      agents.value = result.resources.filter((r: any) => r.kind === "agent");
  } catch {
    if (request === agentGeneration && scope === workspace.generation)
      agentsError.value = "Agent 选项加载失败，仍可查看记录或按 ID 筛选。";
  }
}
const agentName = (id?: string) =>
  id
    ? (agents.value.find((a) => String(a.id) === String(id))?.name ??
      `Agent #${id}`)
    : "历史记录";
const items = ref<ExecutionRecord[]>([]),
  total = ref(0),
  page = ref(1),
  pageSize = ref(20);
const initialAgentId = Number(route.query.agentId);
const agentId = ref<number | undefined>(
  Number.isSafeInteger(initialAgentId) && initialAgentId > 0
    ? initialAgentId
    : undefined,
);
const selectedStatus = () =>
  ["completed", "failed"].includes(String(route.query.status ?? ""))
    ? String(route.query.status)
    : "";
const status = ref(selectedStatus()),
  loading = ref(false),
  error = ref("");
let generation = 0;
async function load() {
  const request = ++generation;
  if (route.name !== "ExecutionList") {
    loading.value = false;
    return;
  }
  loading.value = true;
  error.value = "";
  const query = new URLSearchParams({
    page: String(page.value),
    pageSize: String(pageSize.value),
  });
  if (agentId.value) query.set("agentId", String(agentId.value));
  if (status.value) query.set("status", status.value);
  try {
    const result = await executionsApi.list(query);
    if (request !== generation) return;
    items.value = result.items;
    total.value = result.total;
  } catch {
    if (request === generation) {
      items.value = [];
      total.value = 0;
      error.value = "执行记录加载失败，请检查服务、工作区和读取权限后重试。";
    }
  } finally {
    if (request === generation) loading.value = false;
  }
}
watch(
  () => workspace.generation,
  () => {
    generation++;
    items.value = [];
    total.value = 0;
    page.value = 1;
    agentId.value = undefined;
    status.value = "";
  },
);
watch([agentId, status, pageSize], () => {
  page.value = 1;
});
watch([page, pageSize, agentId, status, () => workspace.generation], load, {
  immediate: true,
});
watch(
  [() => route.name, () => route.query.agentId, () => route.query.status],
  () => {
    if (route.name !== "ExecutionList") {
      generation++;
      loading.value = false;
      return;
    }
    status.value = selectedStatus();
    const selected = Number(route.query.agentId);
    const id =
      Number.isSafeInteger(selected) && selected > 0 ? selected : undefined;
    if (agentId.value !== id) agentId.value = id;
    else void load();
  },
);
watch([() => workspace.generation, canReadAgents], loadAgents, {
  immediate: true,
});
const date = (value: string) => new Date(value).toLocaleString();
</script>

<template>
  <Page>
    <ManagementHeader
      title="运行记录"
      description="查看任务结果与失败原因，按需展开调用过程"
    >
      <ElButton :loading="loading" @click="load">刷新</ElButton>
    </ManagementHeader>
    <div class="space-y-4">
      <ElAlert v-if="error" :title="error" type="error" :closable="false" />
      <PagePanel>
        <ElAlert
          v-if="agentsError"
          :title="agentsError"
          type="warning"
          :closable="false"
          class="mb-4"
        />
        <div class="mb-4 flex flex-wrap items-center gap-3">
          <ElSelect
            v-if="canReadAgents && !agentsError"
            v-model="agentId"
            clearable
            filterable
            placeholder="全部 Agent"
            aria-label="筛选 Agent"
            class="w-full sm:w-64"
          >
            <ElOption
              v-if="agentId && !agents.some((a) => a.id === agentId)"
              :value="agentId"
              :label="`Agent #${agentId}`"
            />
            <ElOption
              v-for="agent in agents"
              :key="agent.id"
              :value="agent.id"
              :label="`${agent.name}${agent.deletedAt ? ' · 已删除' : agent.archivedAt ? ' · 已归档' : ''}`"
            />
          </ElSelect>
          <ElInputNumber
            v-else
            v-model="agentId"
            :min="1"
            :max="Number.MAX_SAFE_INTEGER"
            :controls="false"
            placeholder="Agent ID（可选）"
            aria-label="筛选 Agent ID"
          />
          <ElSelect
            v-model="status"
            class="w-40"
            clearable
            placeholder="全部状态"
            aria-label="筛选执行状态"
          >
            <ElOption label="已完成" value="completed" /><ElOption
              label="失败"
              value="failed"
            />
          </ElSelect>
        </div>
        <ElTable
          v-loading="loading"
          :data="items"
          row-key="id"
          empty-text="当前筛选条件下暂无执行记录"
        >
          <ElTableColumn label="任务" min-width="260" show-overflow-tooltip>
            <template #default="{ row }"
              ><ElButton
                link
                type="primary"
                @click="router.push(`/executions/${row.id}`)"
                >{{ row.question }}</ElButton
              ></template
            >
          </ElTableColumn>
          <ElTableColumn label="Agent" min-width="150" show-overflow-tooltip
            ><template #default="{ row }">{{
              agentName(row.agentId)
            }}</template></ElTableColumn
          >
          <ElTableColumn label="状态" width="100"
            ><template #default="{ row }"
              ><ElTag
                :type="
                  row.status === 'failed'
                    ? 'danger'
                    : row.refused
                      ? 'warning'
                      : 'success'
                "
                >{{
                  row.status === "failed"
                    ? "失败"
                    : row.refused
                      ? "未完成任务"
                      : "已完成"
                }}</ElTag
              ></template
            ></ElTableColumn
          >
          <ElTableColumn label="执行器" width="115"
            ><template #default="{ row }">{{
              ({ deepagents: "Deep Agents", langgraph: "LangGraph" } as any)[
                row.engine
              ] ||
              row.engine ||
              (row.kind === "summary" ? "会话摘要" : "历史记录")
            }}</template></ElTableColumn
          >
          <ElTableColumn prop="totalTokens" label="Token" width="100" />
          <ElTableColumn label="耗时" width="100"
            ><template #default="{ row }">{{
              row.durationMs == null ? "—" : `${row.durationMs} ms`
            }}</template></ElTableColumn
          >
          <ElTableColumn
            prop="errorCode"
            label="错误分类"
            min-width="180"
            show-overflow-tooltip
          />
          <ElTableColumn label="时间" min-width="180"
            ><template #default="{ row }">{{
              date(row.createdAt)
            }}</template></ElTableColumn
          >
        </ElTable>
        <div class="mt-4 flex justify-end">
          <ElPagination
            v-model:current-page="page"
            v-model:page-size="pageSize"
            :total="total"
            :page-sizes="[20, 50, 100]"
            layout="total, sizes, prev, pager, next"
          />
        </div>
      </PagePanel>
    </div>
  </Page>
</template>
