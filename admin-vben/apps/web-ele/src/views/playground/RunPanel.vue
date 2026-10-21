<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter, onBeforeRouteLeave } from "vue-router";
import { useAccessStore } from "@vben/stores";
import {
  ElAlert,
  ElButton,
  ElDescriptions,
  ElDescriptionsItem,
  ElEmpty,
  ElForm,
  ElFormItem,
  ElInput,
  ElOption,
  ElSelect,
  ElSwitch,
  ElTag,
  ElMessageBox,
  ElCollapse,
  ElCollapseItem,
  ElTimeline,
  ElTimelineItem,
} from "element-plus";
import { managementApi as api } from "#/api/management";
import { requestClient } from "#/api/request";
import { consumeEventStream } from "#/api/event-stream";
import { applyRunEvent, newRunState } from "./run-state";
import { useWorkspaceStore } from "#/store/workspace";
import { normalizeSchema } from "@agent-studio/output-contract";
import JsonEditor from "#/components/JsonEditor.vue";
import { ChatMessage } from "@agent-studio/chat-ui";
import { selectedDraftQuery } from "./target";

type Context = {
  agentId: number;
  agentVersionId: number;
  agentName: string;
  version: number;
  mode: "single" | "multi";
  contextFingerprint: string;
  draft?: { versionId: number; revision: number };
  modelName: string;
  modelVersion: number | null;
  promptVersionId: number;
  knowledgeBases: number;
  fileOutputs: boolean;
  outputContract?: {
    mode: "text" | "json";
    source: "agent" | "legacy" | "request";
    schema?: Record<string, unknown>;
    schemaHash: string | null;
  };
  members: { name: string; version: number; versionId: number }[];
  tools: { key: string; description: string }[];
  skills: { key: string; name: string }[];
  limits: {
    maxModelCalls: number;
    maxToolCalls: number;
    maxTotalTokens?: number;
  };
};
type Options = {
  applications: {
    id: string;
    name: string;
    agentId: number;
    agentName: string;
    version: number;
    mode: string;
  }[];
  selected?: Context;
};
const props = defineProps<{
  embedded?: boolean;
  agentId?: number;
  draftVersionId?: number;
  draftRevision?: number;
  configurationKey?: string;
  prepare?: () => Promise<boolean>;
}>();
const stale = ref(false);
const emit = defineEmits<{ running: [value: boolean] }>();
const route = useRoute(),
  router = useRouter(),
  workspace = useWorkspaceStore(),
  access = useAccessStore();
const options = ref<Options>(),
  context = ref<Context>(),
  application = ref(""),
  task = ref(""),
  structured = ref(false);
const schema = ref(
    '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"],"additionalProperties":false}',
  ),
  schemaValid = ref(true);
const loading = ref(false),
  preparing = ref(false),
  busy = ref(false),
  error = ref(""),
  live = ref(newRunState()),
  elapsed = ref(0),
  requestId = ref(crypto.randomUUID());
let generation = 0,
  controller: AbortController | undefined,
  timer: ReturnType<typeof setInterval> | undefined;
const canExecute = computed(() =>
  ["agent_config.manage", "agent_tools.execute"].every((code) =>
    access.accessCodes.includes(code),
  ),
);
const agentId = computed(() => {
  const id = props.agentId ?? Number(route.query.agentId);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
});
const routeDraft = computed(() => selectedDraftQuery(route.query));
const draftTarget = computed(() =>
  props.draftVersionId && props.draftRevision
    ? { versionId: props.draftVersionId, revision: props.draftRevision }
    : routeDraft.value.versionId && routeDraft.value.revision
      ? { versionId: routeDraft.value.versionId, revision: routeDraft.value.revision }
      : undefined,
);
const invalidTarget = computed(
  () => !props.embedded && (!routeDraft.value.valid || (!!draftTarget.value && !agentId.value)),
);
const optionUrl = computed(() => {
  const path = agentId.value
    ? `/agent-preview/agents/${agentId.value}/options`
    : "/agent-preview/options";
  const draft =
    draftTarget.value
      ? `?draftVersionId=${draftTarget.value.versionId}&draftRevision=${draftTarget.value.revision}`
      : "";
  return path + draft;
});
const result = computed(() => live.value.result);
const configuredOutput = computed(
  () => context.value?.outputContract?.source === "agent",
);
const needsManualSchema = computed(
  () => !configuredOutput.value && structured.value,
);
const schemaMessage = (value: unknown) => {
  try {
    normalizeSchema(value);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : "规范无效";
  }
};
const ready = computed(
  () =>
    canExecute.value &&
    !invalidTarget.value &&
    context.value &&
    task.value.trim() &&
    !loading.value &&
    !preparing.value &&
    !busy.value &&
    !result.value &&
    !live.value.runId &&
    (!needsManualSchema.value || schemaValid.value),
);
function reset() {
  requestId.value = crypto.randomUUID();
  live.value = newRunState();
  error.value = "";
  elapsed.value = 0;
}
function message(failure: unknown, fallback: string) {
  const value = failure as {
    response?: { data?: { error?: { message?: unknown } } };
  };
  const text = value?.response?.data?.error?.message;
  return typeof text === "string" ? text.slice(0, 500) : fallback;
}
function stop() {
  controller?.abort();
}
async function load() {
  const current = ++generation;
  stop();
  application.value = "";
  options.value = undefined;
  context.value = undefined;
  reset();
  if (
    (!props.embedded && route.name !== "AgentPlayground") ||
    invalidTarget.value ||
    !canExecute.value
  ) {
    if (invalidTarget.value)
      error.value = "草稿试运行链接缺少有效版本或修订号，请从 Agent 管理重新进入。";
    return;
  }
  loading.value = true;
  try {
    const data = await api.get<Options>(optionUrl.value);
    if (current === generation) {
      options.value = data;
      if (data.applications.length === 1) {
        application.value = data.applications[0]!.id;
        await select();
      }
    }
  } catch (failure) {
    if (current === generation)
      error.value = message(
        failure,
        "无法加载试运行配置，请检查服务和工作区权限。",
      );
  } finally {
    if (current === generation) loading.value = false;
  }
}
async function select() {
  const current = ++generation;
  context.value = undefined;
  reset();
  if (!application.value) return;
  if (invalidTarget.value) return;
  loading.value = true;
  try {
    const data = await api.get<Options>(
      `${optionUrl.value}${optionUrl.value.includes("?") ? "&" : "?"}applicationId=${encodeURIComponent(application.value)}`,
    );
    if (current === generation) {
      options.value = data;
      context.value = data.selected;
      stale.value = false;
    }
  } catch (failure) {
    if (current === generation)
      error.value = message(
        failure,
        "当前 Agent 配置不可用，请检查发布版本与关联资源。",
      );
  } finally {
    if (current === generation) loading.value = false;
  }
}
async function execute() {
  if (!ready.value || !context.value) return;
  preparing.value = true;
  try {
    if (props.prepare && !(await props.prepare())) return;
    // Flush edits before loading a fixed revision. Selecting does not execute or publish.
    await select();
    if (
      !context.value ||
      !task.value.trim() ||
      (needsManualSchema.value && !schemaValid.value)
    )
      return;
  } finally {
    preparing.value = false;
  }
  const current = generation;
  busy.value = true;
  error.value = "";
  controller = new AbortController();
  const signal = controller.signal,
    started = Date.now();
  timer = setInterval(() => {
    elapsed.value = Math.floor((Date.now() - started) / 1000);
  }, 1000);
  try {
    const stream = await requestClient.post<ReadableStream<Uint8Array>>(
      "/agent-preview/runs",
      {
        applicationId: application.value,
        contextFingerprint: context.value.contextFingerprint,
        requestId: requestId.value,
        ...(context.value.draft ? { draft: context.value.draft } : {}),
        stream: true,
        input: {
          task: task.value,
          ...(needsManualSchema.value
            ? { outputSchema: JSON.parse(schema.value) }
            : {}),
        },
      },
      {
        signal,
        timeout: 190000,
        adapter: "fetch",
        responseType: "stream",
        headers: { Accept: "text/event-stream" },
      },
    );
    await consumeEventStream(
      stream,
      (event) => {
        if (current !== generation || signal.aborted) return;
        applyRunEvent(live.value, event);
        if (live.value.error) error.value = live.value.error;
      },
      signal,
    );
    if (current === generation && !live.value.terminal)
      error.value =
        "连接已中断，尚未收到最终结果；临时回答不代表任务完成。请查看执行记录，不会自动重连或重放任务。";
  } catch (failure) {
    if (current === generation)
      error.value = signal.aborted
        ? "已请求停止执行。已发出的外部操作不能撤销，最终状态及已产生用量请查看执行记录。"
        : message(
            failure,
            failure instanceof Error
              ? failure.message.slice(0, 500)
              : "执行未完成，请查看执行记录；不会自动重放失败任务。",
          );
  } finally {
    clearInterval(timer);
    timer = undefined;
    controller = undefined;
    busy.value = false;
  }
}
watch([busy, preparing], () => emit("running", busy.value || preparing.value), {
  flush: "sync",
});
watch(
  () => props.configurationKey,
  () => {
    stale.value = true;
  },
);
watch(
  () => props.draftRevision,
  () => {
    stale.value = true;
    if (!context.value && !busy.value && !loading.value && !preparing.value)
      void load();
  },
);
watch([task, structured, schema], () => {
  if (!busy.value) reset();
});
watch(
  [
    () => workspace.generation,
    () => route.name,
    agentId,
    optionUrl,
    invalidTarget,
    canExecute,
  ],
  () => {
    task.value = "";
    void load();
  },
  { immediate: true },
);
onBeforeRouteLeave(async () => {
  if (!busy.value) return true;
  try {
    await ElMessageBox.confirm(
      "离开将停止当前请求；已发出的外部操作不能撤销。继续离开？",
      "任务执行中",
      { type: "warning" },
    );
    stop();
    return true;
  } catch {
    return false;
  }
});
onBeforeUnmount(() => {
  generation++;
  stop();
  clearInterval(timer);
});
</script>

<template>
  <div class="min-w-0">
    <ElAlert
      v-if="!canExecute"
      title="试运行需要 Agent 配置管理与工具执行权限。"
      type="warning"
      :closable="false"
    />
    <ElAlert
      v-else-if="invalidTarget"
      title="草稿试运行链接无效，请从 Agent 管理重新进入。"
      type="error"
      :closable="false"
    />
    <div
      v-else
      :class="embedded ? 'space-y-6' : 'grid min-w-0 gap-4 lg:grid-cols-5'"
    >
      <section
        class="space-y-4"
        :class="
          embedded
            ? ''
            : 'rounded-md border border-border bg-card p-6 lg:col-span-2'
        "
      >
        <div class="flex items-center justify-between gap-2">
          <h2 class="font-semibold">试运行</h2>
          <ElTag v-if="draftTarget" type="warning">草稿</ElTag>
        </div>
        <ElAlert
          v-if="stale && (result || live.runId)"
          title="配置已修改，原结果不再代表当前配置"
          type="warning"
          :closable="false"
        />
        <ElForm label-position="top" :disabled="busy">
          <ElFormItem label="Agent / 接入应用" required>
            <ElSelect
              v-model="application"
              class="w-full"
              filterable
              clearable
              :loading="loading"
              placeholder="选择接入应用"
              @change="select"
            >
              <ElOption
                v-for="app in options?.applications ?? []"
                :key="app.id"
                :value="app.id"
                :label="`${app.agentName} · v${app.version} · ${app.name}`"
              />
            </ElSelect>
          </ElFormItem>
          <ElAlert
            v-if="options && !options.applications.length"
            title="没有可用应用；请创建仅供后台试运行的应用，或选择已有启用应用。"
            type="info"
            :closable="false"
            class="mb-4"
            ><ElButton
              v-if="access.accessCodes.includes('integrations.manage')"
              link
              type="primary"
              @click="
                router.push({
                  path: '/integrations',
                  query: agentId
                    ? { agentId: String(agentId) }
                    : {},
                })
              "
              >管理应用接入</ElButton
            ></ElAlert
          >
          <ElCollapse v-if="context"
            ><ElCollapseItem title="本次执行配置" name="context"
              ><ElDescriptions :column="1" size="small" class="mb-4">
                <ElDescriptionsItem label="执行模式">{{
                  context.mode === "multi" ? "多 Agent" : "单 Agent"
                }}</ElDescriptionsItem>
                <ElDescriptionsItem label="模型"
                  >{{ context.modelName }} · v{{
                    context.modelVersion
                  }}</ElDescriptionsItem
                >
                <ElDescriptionsItem label="资源"
                  >{{ context.skills.length }} 个 Skill ·
                  {{ context.tools.length }} 个 Tool ·
                  {{ context.knowledgeBases }} 个知识库</ElDescriptionsItem
                >
                <ElDescriptionsItem label="调用上限"
                  >模型 {{ context.limits.maxModelCalls }} / 工具
                  {{ context.limits.maxToolCalls }} / Token
                  {{
                    context.limits.maxTotalTokens ?? "应用额度"
                  }}</ElDescriptionsItem
                >
                <ElDescriptionsItem
                  v-if="context.members.length"
                  label="固定成员"
                  ><div class="flex flex-wrap gap-2">
                    <ElTag
                      v-for="member in context.members"
                      :key="member.versionId"
                      type="info"
                      >{{ member.name }} · v{{ member.version }}</ElTag
                    >
                  </div></ElDescriptionsItem
                >
              </ElDescriptions></ElCollapseItem
            ></ElCollapse
          >
          <ElFormItem label="任务" required>
            <ElInput
              v-model="task"
              type="textarea"
              :autosize="{ minRows: embedded ? 4 : 8, maxRows: 12 }"
              maxlength="2000"
              show-word-limit
              placeholder="描述希望 Agent 完成的任务。不要填写密钥或密码。"
            />
          </ElFormItem>
          <ElAlert
            v-if="configuredOutput"
            type="info"
            :closable="false"
            :title="
              context?.outputContract?.mode === 'json'
                ? '使用当前 Agent 版本的 JSON 输出规范'
                : '使用当前 Agent 版本的文本输出方式'
            "
          />
          <ElFormItem v-else label="结构化结果"
            ><ElSwitch v-model="structured"
          /></ElFormItem>
          <JsonEditor
            v-if="needsManualSchema"
            v-model="schema"
            kind="object"
            label="结果 JSON Schema"
            :readonly="busy"
            :validate-value="schemaMessage"
            @valid="schemaValid = $event"
          />
        </ElForm>
        <div class="text-muted-foreground text-sm">
          试运行计入所选应用额度，不创建会话、不修改发布配置，也不自动批准写工具。
        </div>
        <div class="flex flex-wrap gap-2">
          <ElButton
            type="primary"
            :loading="busy"
            :disabled="!ready"
            @click="execute"
            >执行任务</ElButton
          >
          <ElButton v-if="busy" type="danger" plain @click="stop"
            >停止执行</ElButton
          >
          <ElButton v-if="result || error" :disabled="busy" @click="reset"
            >重新开始</ElButton
          >
          <ElButton :disabled="busy || loading" @click="load"
            >刷新配置</ElButton
          >
        </div>
      </section>
      <section
        class="min-w-0 space-y-4"
        :class="
          embedded
            ? 'border-t border-border pt-6'
            : 'rounded-md border border-border bg-card p-6 lg:col-span-3'
        "
      >
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="font-semibold">执行结果</h2>
          <ElButton
            v-if="access.accessCodes.includes('conversations.read')"
            link
            type="primary"
            @click="
              router.push(
                result?.traceId
                  ? `/executions/${result.traceId}`
                  : {
                      path: '/executions',
                      query: { agentId: context?.agentId ?? agentId },
                    },
              )
            "
            >{{
              result?.traceId ? "查看本次执行详情" : "查看执行记录"
            }}</ElButton
          >
        </div>
        <ElAlert v-if="error" :title="error" type="error" :closable="false">
          <ul v-if="live.outputIssues?.length" class="mt-2 text-sm">
            <li v-for="(issue, i) in live.outputIssues" :key="i">
              {{ issue.path }}：{{ issue.message }}
            </li>
          </ul>
        </ElAlert>
        <ElAlert
          v-if="busy"
          :title="`任务执行中 · ${elapsed} 秒`"
          description="由正式 Deep Agents 内核执行，耗时与任务复杂度、模型和工具调用有关。"
          type="info"
          :closable="false"
        />
        <ElEmpty
          v-if="!busy && !result && !error"
          description="选择 Agent 并执行任务后，这里实时显示回答"
        />
        <ElAlert
          v-if="live.retry"
          :title="live.retry.message"
          :description="`尝试 ${live.retry.attempt} / ${live.retry.maxAttempts}`"
          :type="
            live.retry.state === 'recovered'
              ? 'success'
              : live.retry.state === 'exhausted'
                ? 'error'
                : 'warning'
          "
          :closable="false"
        />
        <div v-if="live.replayed" class="text-sm text-muted-foreground">
          已读取原请求结果，本次没有重新执行。
        </div>
        <ElCollapse
          v-if="live.activities.length"
          :model-value="busy ? ['progress'] : []"
        >
          <ElCollapseItem
            name="progress"
            :title="`执行进度 · ${live.activities.length} 项`"
          >
            <ElTimeline class="max-h-64 overflow-auto pr-3 pt-2">
              <ElTimelineItem
                v-for="item in live.activities"
                :key="item.id"
                :type="
                  item.ok === false
                    ? 'danger'
                    : item.status === 'completed'
                      ? 'success'
                      : 'primary'
                "
                :hollow="item.status === 'running'"
              >
                <span>{{ item.text }}</span>
                <span
                  v-if="item.durationMs !== undefined"
                  class="ml-2 text-xs text-muted-foreground"
                  >{{ (item.durationMs / 1000).toFixed(1) }} 秒</span
                >
              </ElTimelineItem>
            </ElTimeline>
          </ElCollapseItem>
        </ElCollapse>
        <div v-if="live.answer && !result" class="space-y-2">
          <div class="text-xs text-muted-foreground">
            {{
              busy
                ? "临时回答 · 最终结果到达后替换"
                : "临时回答 · 任务尚未确认完成"
            }}
          </div>
          <div
            class="whitespace-pre-wrap break-words text-sm leading-7"
            role="region"
            aria-label="Agent 实时回答"
          >
            <ChatMessage
              :message="{
                id: 'live',
                role: 'assistant',
                content: live.answer,
                status: busy ? 'running' : 'failed',
              }"
            />
          </div>
        </div>
        <template v-if="result">
          <ElTag
            :type="result.status === 'completed' ? 'success' : 'warning'"
            >{{
              result.status === "completed"
                ? "执行完成"
                : result.status === "refused"
                  ? "拒绝执行"
                  : result.status
            }}</ElTag
          >
          <ElDescriptions v-if="result.usage" :column="2" size="small">
            <ElDescriptionsItem label="输入 / 输出 Token"
              >{{ result.usage.inputTokens }} /
              {{ result.usage.outputTokens }}</ElDescriptionsItem
            >
            <ElDescriptionsItem label="总用量">{{
              result.usage.totalTokens
            }}</ElDescriptionsItem>
            <ElDescriptionsItem label="计费状态">{{
              result.usage.accounting === "actual"
                ? "已结算实际用量"
                : result.usage.accounting === "pending"
                  ? "仍有待结算调用"
                  : "含无法确认的用量"
            }}</ElDescriptionsItem>
          </ElDescriptions>
          <div
            class="whitespace-pre-wrap break-words text-sm leading-7"
            role="region"
            aria-label="Agent 最终结果"
          >
            <ChatMessage
              :message="{
                id: 'final',
                role: 'assistant',
                content: result.answer,
                status: 'completed',
              }"
            />
          </div>
          <ElAlert
            v-if="result.structured !== undefined"
            :type="
              context?.outputContract?.mode === 'json' || needsManualSchema
                ? 'success'
                : 'info'
            "
            :closable="false"
            :title="
              context?.outputContract?.mode === 'json' || needsManualSchema
                ? '结构化结果校验通过'
                : '已返回结构化数据（未配置 Schema 校验）'
            "
          />
          <JsonEditor
            v-if="result.structured !== undefined"
            :model-value="JSON.stringify(result.structured, null, 2)"
            label="structured · 结构化 JSON"
            readonly
          />
          <div
            v-if="result.artifacts?.length || result.references?.length"
            class="text-muted-foreground text-sm"
          >
            包含 {{ result.artifacts.length }} 项产物、{{
              result.references.length
            }}
            项引用，详情和文件下载请打开本次执行记录。
          </div>
          <div class="break-all text-xs text-muted-foreground">
            Run ID：{{ result.runId }}
          </div>
        </template>
        <div
          v-if="live.runId && !result"
          class="break-all text-xs text-muted-foreground"
        >
          Run ID：{{ live.runId }} · 最终状态和已产生用量请查看执行记录
        </div>
      </section>
    </div>
  </div>
</template>
