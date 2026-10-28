<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useWindowSize } from "@vueuse/core";
import { useRoute, useRouter } from "vue-router";
import { useAccessStore } from "@vben/stores";
import { Page } from "@vben/common-ui";
import {
  ElAlert,
  ElButton,
  ElDescriptions,
  ElDescriptionsItem,
  ElLink,
  ElTable,
  ElTableColumn,
  ElTag,
  ElTabs,
  ElTabPane,
  ElCollapse,
  ElCollapseItem,
} from "element-plus";
import ManagementHeader from "#/components/ManagementHeader.vue";
import PagePanel from "#/components/PagePanel.vue";
import HelpTip from "#/components/HelpTip.vue";
import { executionsApi, type ExecutionDetail } from "#/api/executions";
import { safeLangSmithLink } from "#/api/langsmith-link";
import { useWorkspaceStore } from "#/store/workspace";
import ExecutionTree from "./ExecutionTree.vue";
import FileArtifacts from "./FileArtifacts.vue";
import ConversationHistory from "./ConversationHistory.vue";

const route = useRoute(),
  router = useRouter(),
  workspace = useWorkspaceStore(),
  access = useAccessStore();
const detail = ref<ExecutionDetail>(),
  loading = ref(false),
  error = ref(""),
  externalUrl = ref<string | null>(null),
  externalMessage = ref("");
const collectorPermission = computed(() =>
  access.accessCodes.includes("observability.external.read"),
);
const engineLabels: Record<string, string> = {
  deepagents: "Deep Agents",
  langgraph: "LangGraph",
};
let generation = 0;
async function load() {
  const request = ++generation,
    id = String(route.params.id);
  if (route.name !== "ExecutionDetail") {
    loading.value = false;
    return;
  }
  loading.value = true;
  detail.value = undefined;
  error.value = "";
  externalUrl.value = null;
  externalMessage.value = "";
  try {
    const result = await executionsApi.detail(id);
    if (request !== generation) return;
    detail.value = result;
    if (!result.execution.externalTrace.sampled)
      externalMessage.value =
        result.execution.externalTrace.provider === "phoenix"
          ? "此记录来自历史 Phoenix 追踪，本地详情仍可查看。"
          : "此执行未启用或未采样 LangSmith 追踪，本地记录仍可查看。";
    else if (!collectorPermission.value)
      externalMessage.value = "查看 LangSmith 需要独立的平台追踪访问权限。";
    else {
      try {
        const link = await executionsApi.external(id);
        if (request !== generation) return;
        const url = safeLangSmithLink(link.url);
        if (link.available && url) externalUrl.value = url;
        else {
          const reasons: Record<string, string> = {
            invalid_credentials: "LangSmith 凭证无效或已过期，请检查服务端追踪配置。",
            rate_limited: "LangSmith 查询触发限流，请稍后刷新；不代表追踪丢失。",
            lookup_timeout: "连接 LangSmith 超时，请稍后刷新；本地记录仍可查看。",
            lookup_failed: "暂时无法连接 LangSmith 或读取追踪，请稍后刷新。",
            link_unavailable: "已读取 LangSmith 追踪，但无法解析详情链接，请检查目标配置。",
            not_sampled: "此执行未采样 LangSmith 追踪，本地记录仍可查看。",
            read_permission_required: "追踪 Key 仅允许写入。请配置目标工作区与项目 ID 以生成入口，或使用有读取权限的凭证解析入口。",
            not_ingested: "LangSmith 暂未读到此执行，可能仍在入库；可稍后刷新。",
            destination_changed: "此执行所属追踪目标与当前部署配置不同。",
            disabled: "LangSmith 追踪当前已关闭。",
            historical_or_missing: "此历史记录没有 LangSmith 追踪映射，本地详情仍可查看。",
          };
          externalMessage.value = reasons[link.reason || ""] || "LangSmith 入口暂时不可用，本地记录仍可查看。";
        }
      } catch {
        if (request === generation)
          externalMessage.value =
            "LangSmith 链接加载失败；不影响查看本地执行记录。";
      }
    }
  } catch {
    if (request === generation)
      error.value = "执行详情加载失败，记录可能不存在，或不在当前工作区内。";
  } finally {
    if (request === generation) loading.value = false;
  }
}
watch(
  [() => route.name, () => route.params.id, () => workspace.generation],
  load,
  {
    immediate: true,
  },
);
const { width } = useWindowSize();
const columns = computed(() => (width.value < 768 ? 1 : 3));
const entryAgentName = computed(() => {
  const record = detail.value;
  if (!record) return "—";
  return (
    record.execution.composition.agents.find(
      (a) => a.agentId === record.execution.composition.agentId,
    )?.name ||
    record.execution.composition.agentId ||
    "历史记录"
  );
});
const value = (item: number | null | undefined) => item ?? "—";
const activeView = computed({
  get: () =>
    route.query.view === "conversation" && detail.value?.conversationId
      ? "conversation"
      : "execution",
  set: (view: string) => {
    void router.replace({ query: { ...route.query, view } });
  },
});
</script>
<template>
  <Page>
    <ManagementHeader title="运行详情">
      <div v-if="externalUrl && collectorPermission" class="flex items-center gap-2">
        <ElLink
          :href="externalUrl"
          target="_blank"
          rel="noopener noreferrer"
          type="primary"
          >在 LangSmith 查看执行树</ElLink
        >
        <HelpTip
          long
          text="LangSmith 接收显式配置的脱敏执行元数据，包括版本、耗时、用量、重试及错误分类；不上传对话正文、完整提示词、工具参数或文档。外部入口不代表已经确认入库，本地 Trace 和审计仍是业务依据。"
        />
      </div>
      <ElButton @click="router.push('/executions')">返回列表</ElButton
      ><ElButton :loading="loading" @click="load">刷新</ElButton>
    </ManagementHeader>
    <div v-loading="loading" class="space-y-4">
      <ElAlert v-if="error" :title="error" type="error" :closable="false" />
      <template v-if="detail">
        <ElAlert
          v-if="detail.status === 'failed' || detail.refused"
          :title="detail.status === 'failed' ? '任务执行失败' : '任务未完成'"
          :type="detail.status === 'failed' ? 'error' : 'warning'"
          :closable="false"
          :description="`错误分类：${detail.errorCode || detail.execution.error.errorCode || '未记录'}${detail.execution.error.phase ? ' · 阶段：' + detail.execution.error.phase : ''}。可在执行过程中查看失败与重试记录。`"
        />
        <ElAlert
          v-if="detail.execution.outputIssues?.length"
          title="输出规范校验失败"
          type="error"
          :closable="false"
          ><ul>
            <li v-for="(issue, i) in detail.execution.outputIssues" :key="i">
              {{ issue.path }}：{{ issue.message }}
            </li>
          </ul></ElAlert
        >
        <PagePanel>
          <ElDescriptions :column="columns" border direction="vertical">
            <ElDescriptionsItem label="执行状态"
              ><ElTag
                :type="
                  detail.status === 'failed'
                    ? 'danger'
                    : detail.refused
                      ? 'warning'
                      : 'success'
                "
                >{{
                  detail.status === "failed"
                    ? "失败"
                    : detail.refused
                      ? "未完成任务"
                      : "已完成"
                }}</ElTag
              ></ElDescriptionsItem
            >
            <ElDescriptionsItem label="总耗时"
              >{{ value(detail.durationMs) }} ms</ElDescriptionsItem
            >
            <ElDescriptionsItem label="输入 / 输出 / 总 Token"
              >{{ value(detail.inputTokens) }} /
              {{ value(detail.outputTokens) }} /
              {{ value(detail.totalTokens) }}</ElDescriptionsItem
            >
            <ElDescriptionsItem label="Agent">{{
              entryAgentName
            }}</ElDescriptionsItem>
          </ElDescriptions>
        </PagePanel>
        <ElTabs v-model="activeView">
          <ElTabPane label="本次执行" name="execution">
            <div class="space-y-4">
              <div class="grid gap-4 lg:grid-cols-2">
                <PagePanel
                  ><h2 class="mb-3 font-medium">任务输入</h2>
                  <p class="whitespace-pre-wrap break-words text-sm">
                    {{ detail.question }}
                  </p></PagePanel
                ><PagePanel
                  ><h2 class="mb-3 font-medium">最终结果</h2>
                  <p class="whitespace-pre-wrap break-words text-sm">
                    {{ detail.finalAnswer || "此执行未生成最终结果。" }}
                  </p></PagePanel
                >
              </div>
              <PagePanel><FileArtifacts :trace-id="detail.id" /></PagePanel>
              <PagePanel
                ><h2 class="mb-3 font-medium">执行过程</h2>
                <ExecutionTree :execution="detail.execution"
              /></PagePanel>
              <PagePanel>
                <ElCollapse>
                  <ElCollapseItem name="metadata" title="版本与技术信息">
                    <div class="space-y-4 pt-2">
                      <ElAlert
                        v-if="externalMessage"
                        :title="externalMessage"
                        type="info"
                        :closable="false"
                      />
                      <ElDescriptions :column="columns" border direction="vertical">
                        <ElDescriptionsItem label="执行器"
                          >{{
                            engineLabels[detail.execution.executionEngine || ""] ||
                            detail.execution.executionEngine ||
                            "历史记录"
                          }}
                          ·
                          {{
                            detail.execution.graphVersion || "—"
                          }}</ElDescriptionsItem
                        >
                        <ElDescriptionsItem label="Agent / 生效版本 ID"
                          >{{ detail.execution.composition.agentId || "—" }} /
                          {{
                            detail.execution.composition.entryVersionId || "—"
                          }}</ElDescriptionsItem
                        >
                        <ElDescriptionsItem label="错误分类">{{
                          detail.errorCode || detail.execution.error.errorCode || "无"
                        }}</ElDescriptionsItem>
                        <ElDescriptionsItem
                          v-if="detail.execution.outputContract?.mode"
                          label="输出规范"
                        >
                          {{
                            detail.execution.outputContract.mode === "json"
                              ? "结构化 JSON"
                              : "文本"
                          }}
                          ·
                          {{
                            detail.execution.outputContract.source === "agent"
                              ? "Agent 版本配置"
                              : detail.execution.outputContract.source === "request"
                                ? "调用方配置"
                                : "历史兼容"
                          }}
                          <div
                            v-if="detail.execution.outputContract.schemaHash"
                            class="break-all text-xs text-muted-foreground"
                          >
                            {{ detail.execution.outputContract.schemaHash }}
                          </div>
                        </ElDescriptionsItem>
                        <ElDescriptionsItem label="本地 Trace ID">{{
                          detail.id
                        }}</ElDescriptionsItem
                        ><ElDescriptionsItem label="执行入口 / Run ID"
                          >{{
                            detail.execution.entryPoint === "generic_run"
                              ? "独立任务"
                              : detail.execution.entryPoint === "agent_preview"
                                ? "后台试运行"
                                : detail.execution.entryPoint === "workflow_test"
                                  ? "专项流程测试"
                                  : "会话 / 渠道"
                          }}
                          / {{ detail.execution.runId || "—" }}</ElDescriptionsItem
                        ><ElDescriptionsItem label="会话 ID">{{
                          detail.conversationId || "无会话"
                        }}</ElDescriptionsItem
                        ><ElDescriptionsItem label="时间">{{
                          new Date(detail.createdAt).toLocaleString()
                        }}</ElDescriptionsItem>
                      </ElDescriptions>
                      <div>
                        <h2 class="mb-3 font-medium">资源版本快照</h2>
                        <ElTable
                          :data="detail.execution.composition.agents"
                          empty-text="此历史记录未保存 Agent 组合快照"
                          ><ElTableColumn
                            prop="name"
                            label="Agent"
                            min-width="160"
                          /><ElTableColumn
                            prop="versionId"
                            label="版本 ID"
                            width="100"
                          /><ElTableColumn
                            prop="promptVersionId"
                            label="Prompt 版本"
                            width="120"
                          /><ElTableColumn
                            prop="modelPlanVersionId"
                            label="模型方案版本"
                            width="130"
                          /><ElTableColumn
                            prop="embeddingPlanVersionId"
                            label="向量方案版本"
                            width="130"
                          /><ElTableColumn label="知识库索引" min-width="180"
                            ><template #default="{ row }">{{
                              row.knowledge
                                .map(
                                  (kb: { id: number; indexVersionId: number }) =>
                                    `${kb.id} / ${kb.indexVersionId ?? "未就绪"}`,
                                )
                                .join("、") || "无"
                            }}</template></ElTableColumn
                          ></ElTable
                        >
                      </div>
                    </div>
                  </ElCollapseItem>
                </ElCollapse>
              </PagePanel>
            </div>
          </ElTabPane>
          <ElTabPane v-if="detail.conversationId" label="会话对话" name="conversation" lazy>
            <PagePanel>
              <ConversationHistory v-if="activeView === 'conversation'" :trace-id="detail.id" />
            </PagePanel>
          </ElTabPane>
        </ElTabs>
      </template>
    </div>
  </Page>
</template>
