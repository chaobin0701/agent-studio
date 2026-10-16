<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useAccessStore } from "@vben/stores";
import {
  ElAlert,
  ElButton,
  ElCheckbox,
  ElCheckboxGroup,
  ElDescriptions,
  ElDescriptionsItem,
  ElDialog,
  ElForm,
  ElFormItem,
  ElOption,
  ElSelect,
  ElTag,
} from "element-plus";
import { managementApi as api } from "#/api/management";
import JsonEditor from "#/components/JsonEditor.vue";

type Dependency = {
  key: string;
  name: string;
  versionId: number;
  requiresApproval: boolean;
  readOnly: boolean;
};
type Context = {
  applicationId: string;
  agentId: number;
  agentVersionId: number;
  contextFingerprint: string;
  promptVersionId: number;
  modelPlanVersionId: number | null;
  modelPlanName: string;
  modelPlanVersion: number | null;
  dependencies: Dependency[];
  limits: {
    maxModelCalls: number;
    maxToolCalls: number;
    maxTotalTokens?: number;
  };
};
type Options = {
  workflow: { key: string; version: string };
  requiresApproval: boolean;
  applications: {
    id: string;
    name: string;
    agentId: number;
    agentName: string;
    agentVersionId: number;
    version: number;
  }[];
  selected?: Context;
};
const props = defineProps<{ versionId?: number }>();
const open = defineModel<boolean>({ default: false });
const emit = defineEmits<{ tested: [result: unknown] }>();
const access = useAccessStore(),
  router = useRouter();
const options = ref<Options>(),
  context = ref<Context>(),
  application = ref(""),
  input = ref("{}"),
  valid = ref(true);
const loading = ref(false),
  busy = ref(false),
  error = ref(""),
  result = ref<any>(),
  approved = ref(false),
  approvedTools = ref<number[]>([]);
const requestId = ref(crypto.randomUUID());
function failureMessage(value: unknown, fallback: string) {
  const failure = value as {
    response?: { data?: { error?: { message?: unknown }; message?: unknown } };
  };
  const message =
    failure?.response?.data?.error?.message ?? failure?.response?.data?.message;
  return typeof message === "string" ? message.slice(0, 500) : fallback;
}
let generation = 0;
const approvals = computed(
  () => context.value?.dependencies.filter((d) => d.requiresApproval) ?? [],
);
const ready = computed(
  () =>
    !!context.value &&
    valid.value &&
    !loading.value &&
    !busy.value &&
    !result.value &&
    (!options.value?.requiresApproval || approved.value) &&
    approvals.value.every((d) => approvedTools.value.includes(d.versionId)),
);
function reset() {
  requestId.value = crypto.randomUUID();
  result.value = undefined;
  error.value = "";
  approved.value = false;
  approvedTools.value = [];
}
watch(input, reset);
watch(
  () => [open.value, props.versionId],
  async () => {
    const current = ++generation;
    if (!open.value || !props.versionId) return;
    application.value = "";
    options.value = undefined;
    context.value = undefined;
    reset();
    loading.value = true;
    try {
      const data = await api.get<Options>(
        `/agent-resources/versions/${props.versionId}/workflow-test-options`,
      );
      if (current === generation) options.value = data;
    } catch (failure) {
      if (current === generation)
        error.value = failureMessage(
          failure,
          "无法加载流程测试配置，请检查权限和草稿配置。",
        );
    } finally {
      if (current === generation) loading.value = false;
    }
  },
);
async function selectContext() {
  const current = ++generation;
  context.value = undefined;
  reset();
  if (!application.value || !props.versionId) return;
  loading.value = true;
  try {
    const data = await api.get<Options>(
      `/agent-resources/versions/${props.versionId}/workflow-test-options?applicationId=${encodeURIComponent(application.value)}`,
    );
    if (current === generation) {
      options.value = data;
      context.value = data.selected;
    }
  } catch (failure) {
    if (current === generation)
      error.value = failureMessage(
        failure,
        "该 Agent 的配置或依赖不兼容，请确认已发布模型、Prompt 和所需工具授权。",
      );
  } finally {
    if (current === generation) loading.value = false;
  }
}
async function execute() {
  if (!ready.value || !props.versionId || !context.value) return;
  busy.value = true;
  error.value = "";
  try {
    const value = await api.post(
      `/agent-resources/versions/${props.versionId}/workflow-test`,
      {
        applicationId: application.value,
        agentVersionId: context.value.agentVersionId,
        contextFingerprint: context.value.contextFingerprint,
        requestId: requestId.value,
        input: JSON.parse(input.value),
        approved: approved.value,
        approvedToolVersionIds: approvedTools.value,
      },
    );
    result.value = value;
    emit("tested", value);
  } catch {
    error.value =
      "测试请求未完成或配置已变更。再次执行会复用本次请求 ID，不会自动重放已执行的操作；新的测试请点击“重新开始”。";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <ElDialog
    class="management-dialog"
    body-class="management-dialog-body"
    header-class="management-dialog-header"
    footer-class="management-dialog-footer"
    append-to-body
    v-model="open"
    title="专项流程测试"
    width="760"
    :close-on-click-modal="!busy"
    :close-on-press-escape="!busy"
    :show-close="!busy"
  >
    <ElAlert
      title="直接执行已保存的专项流程，不增加 Agent 规划调用。测试使用所选 Agent 的生效配置，计入接入应用额度，可能产生真实副作用。"
      type="warning"
      :closable="false"
    />
    <ElForm label-position="top" class="mt-4" :disabled="busy">
      <ElFormItem label="测试 Agent / 接入应用" required>
        <ElSelect
          v-model="application"
          filterable
          clearable
          :loading="loading"
          class="w-full"
          placeholder="选择已发布 Agent 绑定的应用"
          @change="selectContext"
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
        title="没有可用上下文，请先发布 Agent，并在接入应用中绑定它、启用应用和执行权限。"
        type="info"
        :closable="false"
      />
      <ElDescriptions v-if="context" :column="2" border class="mb-4">
        <ElDescriptionsItem label="Agent 版本"
          >#{{ context.agentVersionId }}</ElDescriptionsItem
        >
        <ElDescriptionsItem label="模型方案">
          {{ context.modelPlanName || `#${context.modelPlanVersionId ?? "—"}`
          }}<template v-if="context.modelPlanVersion">
            · v{{ context.modelPlanVersion }}</template
          >
        </ElDescriptionsItem>
        <ElDescriptionsItem label="Prompt 版本"
          >#{{ context.promptVersionId }}</ElDescriptionsItem
        >
        <ElDescriptionsItem label="模型调用上限">{{
          context.limits.maxModelCalls
        }}</ElDescriptionsItem>
        <ElDescriptionsItem label="工具 / Token 上限"
          >{{ context.limits.maxToolCalls }} /
          {{ context.limits.maxTotalTokens ?? "应用额度" }}</ElDescriptionsItem
        >
      </ElDescriptions>
      <ElFormItem
        v-if="context?.dependencies.length"
        label="流程依赖（仅使用该 Agent 已授权的版本）"
      >
        <div class="flex flex-wrap gap-2">
          <ElTag
            v-for="tool in context.dependencies"
            :key="tool.versionId"
            :type="tool.readOnly ? 'info' : 'warning'"
            >{{ tool.name }} · #{{ tool.versionId }} ·
            {{ tool.readOnly ? "读取" : "可能写入" }}</ElTag
          >
        </div>
      </ElFormItem>
      <ElFormItem
        v-if="approvals.length"
        label="本次批准（仅本次测试有效）"
        required
      >
        <ElCheckboxGroup v-model="approvedTools" class="flex flex-col">
          <ElCheckbox
            v-for="tool in approvals"
            :key="tool.versionId"
            :value="tool.versionId"
            >批准 {{ tool.name }}（#{{ tool.versionId }}）</ElCheckbox
          >
        </ElCheckboxGroup>
      </ElFormItem>
      <ElCheckbox
        v-if="options?.requiresApproval"
        v-model="approved"
        class="mb-4"
        >批准执行当前流程工具，已了解可能的副作用</ElCheckbox
      >
      <JsonEditor
        v-model="input"
        kind="object"
        label="流程测试参数"
        :disabled="busy"
        @valid="valid = $event"
      />
    </ElForm>
    <ElAlert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      class="mt-4"
    />
    <div
      v-if="result"
      class="mt-4 space-y-3"
      role="region"
      aria-label="流程测试结果"
    >
      <ElAlert
        :title="result.ok ? '流程测试通过' : '流程测试失败'"
        :type="result.ok ? 'success' : 'error'"
        :description="`${result.durationMs} ms${result.errorCode ? ` · ${result.errorCode}` : ''}`"
        :closable="false"
      />
      <div v-if="result.usage" class="text-muted-foreground text-sm">
        记录用量：{{ result.usage.totalTokens }} Token ·
        {{
          result.usage.accounting === "actual"
            ? "已结算实际用量"
            : result.usage.accounting === "pending"
              ? "仍有待结算调用"
              : "含无法确认的用量"
        }}
      </div>
      <pre
        class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-sm"
        >{{ result.content }}</pre
      >
      <ElButton
        v-if="
          result.traceId && access.accessCodes.includes('conversations.read')
        "
        link
        type="primary"
        @click="
          router.push(`/executions/${result.traceId}`);
          open = false;
        "
        >查看执行记录</ElButton
      >
    </div>
    <template #footer>
      <ElButton :disabled="busy" @click="open = false">关闭</ElButton>
      <ElButton v-if="result || error" :disabled="busy" @click="reset"
        >重新开始</ElButton
      >
      <ElButton
        type="primary"
        :loading="busy"
        :disabled="!ready"
        @click="execute"
        >确认执行</ElButton
      >
    </template>
  </ElDialog>
</template>
