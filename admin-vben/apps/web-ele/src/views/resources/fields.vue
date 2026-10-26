<script setup lang="ts">
import { computed, watch } from "vue";
import { LayoutGrid, Settings } from "@vben/icons";
import { selectedMcpServices, selectMcpServices, type McpServiceChoice } from "./mcp-service-selection";
import OutputContractEditor from "./OutputContractEditor.vue";
import SkillFields from "./skill/fields.vue";
import ToolFields from "../tools/ToolFields.vue";
import {
  ElForm,
  ElFormItem,
  ElIcon,
  ElTag,
  ElInput,
  ElInputNumber,
  ElSelect,
  ElSegmented,
  ElOption,
  ElAlert,
  ElButton,
  ElSwitch,
} from "element-plus";
import HelpTip from "#/components/HelpTip.vue";
import OptionalLimit from "#/components/OptionalLimit.vue";
const props = defineProps<{
  kind: string;
  options: any;
  resources: any[];
  resourceId?: number;
  disabled?: boolean;
  creating?: boolean;
  fullWidth?: boolean;
  section?:
    | "all"
    | "basic"
    | "abilities"
    | "output"
    | "runtime"
    | "connection";
}>();
const config = defineModel<any>({ required: true });
const show = (section: string) =>
  !props.section || props.section === "all" || props.section === section;
const executionMode = computed({
  get: () => (config.value.collaboration ? "multi" : "single"),
  set: (mode: string) => {
    config.value.collaboration =
      mode === "multi"
        ? {
            memberVersionIds: [],
            maxDelegations: 3,
            failurePolicy: "continue",
          }
        : null;
  },
});
const taskBudget = computed(() => ({
  maxModelCalls: 32,
  maxToolCalls: 40,
  maxTotalTokens: 120000,
  enabled:
    config.value.executionLimits?.enabled ??
    (config.value.executionLimits || config.value.collaboration
      ? { maxModelCalls: true, maxToolCalls: true, maxTotalTokens: true }
      : { maxModelCalls: false, maxToolCalls: false, maxTotalTokens: false }),
  ...(config.value.collaboration ?? {}),
  ...(config.value.executionLimits ?? {}),
}));
function setTaskBudget(
  field: string,
  value: number | Record<string, boolean> | undefined,
) {
  if (value === undefined) return;
  config.value.executionLimits = {
    maxModelCalls: Math.min(200, taskBudget.value.maxModelCalls ?? 32),
    maxToolCalls: Math.min(200, taskBudget.value.maxToolCalls ?? 40),
    maxTotalTokens: taskBudget.value.maxTotalTokens ?? 120000,
    enabled: taskBudget.value.enabled ?? {
      maxModelCalls: true,
      maxToolCalls: true,
      maxTotalTokens: true,
    },
    [field]: value,
  };
}
function setTaskLimitEnabled(field: string, value: boolean) {
  const enabled = {
    maxModelCalls: true,
    maxToolCalls: true,
    maxTotalTokens: true,
    ...taskBudget.value.enabled,
    [field]: value,
  };
  setTaskBudget("enabled", enabled);
}
const memberChoices = computed(() =>
  (props.options.members ?? []).filter(
    (member: any) => member.resourceId !== props.resourceId,
  ),
);
const fileOutputsEnabled = computed({
  get: () => Boolean(config.value.fileOutputs?.enabled),
  set: (enabled: boolean) => {
    config.value.fileOutputs = { enabled };
  },
});
function memberDisabled(member: any) {
  return memberChoices.value.some(
    (selected: any) =>
      selected.id !== member.id &&
      selected.resourceId === member.resourceId &&
      config.value.collaboration?.memberVersionIds.includes(selected.id),
  );
}
const missingMembers = computed(() =>
  (config.value.collaboration?.memberVersionIds ?? []).filter(
    (id: number) =>
      !memberChoices.value.some((member: any) => member.id === id),
  ),
);
const emit = defineEmits<{
  save: [];
  refreshOptions: [];
  valid: [value: boolean];
}>();
const needsVector = computed(
  () =>
    props.kind === "agent" &&
    ["vector", "hybrid"].includes(config.value.retrieval?.retrievalMode),
);
const selectedEmbedding = computed(() =>
  (props.options.embeddingPlans ?? []).find(
    (p: any) => p.id === config.value.embeddingPlanVersionId,
  ),
);
const selectedKnowledge = computed(() =>
  (props.options.knowledgeBases ?? []).filter((kb: any) =>
    config.value.knowledgeBaseIds?.includes(kb.id),
  ),
);
const compatibleKnowledge = (kb: any) =>
  !!kb.supportsVector &&
  !!selectedEmbedding.value &&
  kb.embeddingFingerprint === selectedEmbedding.value.fingerprint;
const incompatibleKnowledge = computed(() =>
  selectedKnowledge.value.filter((kb: any) => !compatibleKnowledge(kb)),
);
const vectorOnly = computed(
  () => config.value.retrieval?.retrievalMode === "vector",
);
function knowledgeCapability(kb: any) {
  if (!kb.indexVersionId) return "尚未构建索引";
  if (!needsVector.value)
    return config.value.retrieval?.retrievalMode === "fulltext" ||
      !kb.supportsVector
      ? "全文检索"
      : "自动混合检索";
  if (!selectedEmbedding.value) return "请先选择向量模型";
  if (compatibleKnowledge(kb))
    return vectorOnly.value ? "向量检索 · 模型兼容" : "混合检索 · 模型兼容";
  return vectorOnly.value
    ? kb.supportsVector
      ? "模型不兼容"
      : "未开启向量索引"
    : "回退全文检索";
}
function retrievalChanged(mode: string) {
  if (!["vector", "hybrid"].includes(mode))
    config.value.embeddingPlanVersionId = null;
}
const currentModelPlans = computed(() => props.options.modelPlans ?? []);
const selectedModelPlan = computed(() => config.value.modelPlanVersionId);

watch(
  () => config.value,
  (value) => {
    if (props.kind === "agent" && !value.retrieval)
      value.retrieval = {
        retrievalMode: "fulltext",
        topK: 5,
        lexicalThreshold: 0.15,
        vectorThreshold: 0.65,
        contextChars: 12000,
      };
  },
  { immediate: true },
);
// Clear hidden retrieval requirements only when the user removes the last library.
watch(
  () => config.value.knowledgeBaseIds?.length,
  (count, previous) => {
    if (
      props.kind === "agent" &&
      !props.disabled &&
      previous > 0 &&
      count === 0
    ) {
      config.value.retrieval.retrievalMode = "fulltext";
      config.value.embeddingPlanVersionId = null;
    }
  },
);
const choices = (kind: string) =>
  props.resources
    .filter(
      (r) =>
        r.kind === (kind === "mcp" ? "tool" : kind) &&
        r.enabled &&
        !r.archivedAt &&
        !r.deletedAt &&
        (kind === "mcp"
          ? r.toolType === "mcp"
          : kind !== "tool" || r.toolType !== "mcp") &&
        (kind !== "tool" ||
          ![
            "search_knowledge",
            "load_skill",
            "run_skill",
            "delegate_agent",
          ].includes(r.key)),
    )
    .flatMap((r) =>
      r.versions
        .filter((v: any) => v.status === "published")
        .map((v: any) => ({
          ...v,
          name: r.name,
          key: r.key,
          toolType: r.toolType,
        })),
    );
function isUiTool(versionId: number) {
  return choices("tool").some(
    (tool) => tool.id === versionId && tool.toolType === "ui",
  );
}
function resourceDisabled(kind: string, option: any) {
  const field = kind === "skill" ? "skillVersionIds" : "toolVersionIds";
  return choices(kind).some(
    (other) =>
      other.id !== option.id &&
      other.key === option.key &&
      config.value[field]?.includes(other.id),
  );
}
const selectedSkills = computed(() =>
  choices("skill").filter((s) => config.value.skillVersionIds?.includes(s.id)),
);
const selectedTools = computed(() =>
  choices("tool").filter((t) =>
    config.value.toolVersionIds?.includes(t.id),
  ),
);
const mcpServices = computed<McpServiceChoice[]>(() => props.options.mcpServices ?? []);
const selectedServices = computed({
  get: () => selectedMcpServices(config.value.toolVersionIds ?? [], mcpServices.value),
  set: (selected:number[]) => { config.value.toolVersionIds = selectMcpServices(config.value.toolVersionIds ?? [], selected, mcpServices.value); },
});
function serviceDisabled(option:McpServiceChoice) {
  return (!option.ready && !selectedServices.value.includes(option.id)) || mcpServices.value.some(other=>other.id!==option.id&&other.serverId===option.serverId&&selectedServices.value.includes(other.id));
}
function selectedResources(kind: string, field: string) {
  if (field !== "toolVersionIds") return config.value[field];
  const ids = new Set(choices(kind).map((resource: any) => resource.id));
  return (config.value[field] ?? []).filter((id: number) => ids.has(id));
}
function updateResources(kind: string, field: string, selected: number[]) {
  if (field !== "toolVersionIds") {
    config.value[field] = selected;
    return;
  }
  const ids = new Set(choices(kind).map((resource: any) => resource.id));
  config.value[field] = [
    ...(config.value[field] ?? []).filter((id: number) => !ids.has(id)),
    ...selected,
  ];
}
</script>
<template>
  <ElForm
    label-position="top"
    :disabled="disabled && section !== 'output'"
    class="w-full"
    :class="{ 'max-w-4xl': !fullWidth && kind !== 'agent' }"
  >
    <template v-if="kind === 'agent'">
      <div class="space-y-6">
        <section v-if="show('basic')" class="space-y-4">
          <h3 class="mb-4 text-base font-semibold">业务与模型</h3>
          <div class="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            <slot name="identity" />
            <ElFormItem label="模型方案" required
              ><ElSelect
                :model-value="selectedModelPlan"
                @update:model-value="
                  (value) => (config.modelPlanVersionId = value)
                "
                filterable
                class="w-full"
                ><ElOption
                  v-for="p in currentModelPlans"
                  :key="p.id"
                  :value="p.id"
                  :label="`${p.name} · v${p.version}`" /></ElSelect
            ></ElFormItem>
            <ElFormItem
              label="Prompt"
              required
              :class="{ 'sm:col-span-2': !!$slots.identity }"
              ><ElSelect
                v-model="config.promptVersionId"
                filterable
                class="w-full"
                ><ElOption
                  v-for="p in options.prompts"
                  :key="p.id"
                  :value="p.id"
                  :label="`${p.name} · v${p.version}`" /></ElSelect
            ></ElFormItem>
          </div>
          <ElFormItem label="职责" required
            ><ElInput v-model="config.responsibility" type="textarea" :rows="3"
          /></ElFormItem>
          <div>
            <h3 class="mb-4 text-base font-semibold">欢迎标语与建议问题</h3>
            <div class="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
              <ElFormItem label="标题"
                ><ElInput v-model="config.welcome.title" /></ElFormItem
              ><ElFormItem label="描述"
                ><ElInput v-model="config.welcome.description"
              /></ElFormItem>
            </div>
            <ElFormItem label="建议问题"
              ><ElSelect
                v-model="config.welcome.suggestedQuestions"
                multiple
                filterable
                allow-create
                default-first-option
                class="w-full"
            /></ElFormItem>
          </div>
        </section>
        <section v-if="show('abilities')" class="space-y-6">
          <h3 class="mb-4 text-base font-semibold">能力资源</h3>
          <ElFormItem
            v-for="pair in [
              { kind: 'skill', field: 'skillVersionIds', label: 'Skills' },
              {
                kind: 'tool',
                field: 'toolVersionIds',
                label: 'Tools/工具',
              },
            ]"
            :key="pair.kind"
            :label="pair.label"
            ><ElSelect
              :aria-label="pair.label"
              :model-value="selectedResources(pair.kind, pair.field)"
              @update:model-value="
                updateResources(pair.kind, pair.field, $event)
              "
              multiple
              filterable
              class="w-full"
              >
              <template v-if="pair.kind === 'tool'" #label="{ label, value }">
                <span class="inline-flex items-center gap-1">
                  <ElIcon :aria-label="isUiTool(value) ? '生成式UI' : '工具'">
                    <LayoutGrid v-if="isUiTool(value)" /><Settings v-else />
                  </ElIcon>
                  {{ label }}
                </span>
              </template>
              <ElOption
                v-for="r in choices(pair.kind)"
                :key="r.id"
                :value="r.id"
                :label="`${r.name} · v${r.version}`"
                :disabled="resourceDisabled(pair.kind, r)"
              >
                <span class="flex items-center gap-2">
                  <ElIcon v-if="pair.kind === 'tool'" aria-hidden="true">
                    <LayoutGrid v-if="r.toolType === 'ui'" /><Settings v-else />
                  </ElIcon>
                  <span>{{ r.name }} · v{{ r.version }}</span>
                  <span v-if="pair.kind === 'tool'" class="ml-auto text-xs text-muted-foreground">
                    {{ r.toolType === 'ui' ? '生成式UI' : '工具' }}
                  </span>
                </span>
              </ElOption></ElSelect
          ></ElFormItem>
          <ElFormItem label="MCP 服务">
            <ElSelect v-model="selectedServices" aria-label="MCP 服务" multiple filterable class="w-full" placeholder="选择整个 MCP 服务及目录版本">
              <ElOption v-for="service in mcpServices" :key="service.id" :value="service.id" :label="`${service.name} · v${service.version} · ${service.capabilityCount} 项能力`" :disabled="serviceDisabled(service)">
                <span>{{ service.name }} · v{{ service.version }}</span><span class="float-right ml-4 text-xs text-muted-foreground">{{ service.enabled === false ? '服务不可用' : service.ready ? `${service.capabilityCount} 项能力` : '目录待发布' }}</span>
              </ElOption>
            </ElSelect>
            <p class="mt-2 text-xs text-muted-foreground">按整个服务接入并固定目录版本；服务内能力在 MCP 管理中统一维护。</p>
          </ElFormItem>
          <div class="flex flex-wrap gap-2" aria-label="Agent 能力概览">
            <ElTag type="info">{{ selectedSkills.length }} 项指导资料</ElTag>
            <ElTag type="info">{{ selectedTools.length }} 项授权工具</ElTag>
            <ElTag type="info">{{ selectedServices.length }} 个 MCP 服务</ElTag>
            <HelpTip
              text="Skill 是按需读取的指导资料，不是独立执行者。所有工具和知识库权限只由此 Agent 的配置决定；需要独立模型和能力范围时，请创建成员 Agent。"
              long
            />
          </div>
          <h3 class="mb-4 text-base font-semibold">知识检索</h3>
          <ElFormItem label="知识库"
            ><ElSelect
              v-model="config.knowledgeBaseIds"
              multiple
              filterable
              class="w-full"
              ><ElOption
                v-for="k in options.knowledgeBases"
                :key="k.id"
                :value="k.id"
                :label="k.name"
                :disabled="
                  (!k.enabled || (vectorOnly && !compatibleKnowledge(k))) &&
                  !config.knowledgeBaseIds.includes(k.id)
                "
                ><div class="flex items-center justify-between gap-3">
                  <span>{{ k.name }}</span
                  ><span class="text-xs text-muted-foreground">{{
                    knowledgeCapability(k)
                  }}</span>
                </div></ElOption
              ></ElSelect
            ></ElFormItem
          >
          <template v-if="config.knowledgeBaseIds?.length">
            <ElAlert
              v-if="!disabled && config.retrieval.retrievalMode === 'auto'"
              class="mb-4"
              type="info"
              :closable="false"
              title="此草稿保留历史自动适配策略；可明确选择下面三种检索方式，打开页面不会自动替换配置。"
            />
            <ElFormItem
              ><template #label
                >检索方式
                <HelpTip
                  text="默认全文检索，兼容所有知识库。混合检索不兼容时回退全文；向量检索只允许已开启向量索引且与所选模型兼容的知识库。"
                  long
              /></template>
              <span
                v-if="disabled && config.retrieval.retrievalMode === 'auto'"
                class="text-muted-foreground"
                >历史版本：自动适配</span
              >
              <ElSegmented
                v-else
                v-model="config.retrieval.retrievalMode"
                :disabled="disabled"
                :options="[
                  { label: '全文检索', value: 'fulltext' },
                  { label: '混合检索', value: 'hybrid' },
                  { label: '向量检索', value: 'vector' },
                ]"
                @change="retrievalChanged"
              />
            </ElFormItem>
            <ElFormItem
              v-if="needsVector"
              label="向量模型方案"
              required
              :error="
                !selectedEmbedding
                  ? '请选择可用的已发布向量模型方案'
                  : undefined
              "
            >
              <ElSelect
                v-model="config.embeddingPlanVersionId"
                filterable
                class="w-full"
                placeholder="选择已发布的向量模型方案"
                no-data-text="暂无可用的已发布向量模型方案"
              >
                <ElOption
                  v-for="plan in options.embeddingPlans"
                  :key="plan.id"
                  :value="plan.id"
                  :label="`${plan.name} · v${plan.version} · ${plan.model}`"
                />
              </ElSelect>
            </ElFormItem>
            <ElAlert
              v-if="
                needsVector && selectedEmbedding && incompatibleKnowledge.length
              "
              :type="vectorOnly ? 'error' : 'warning'"
              :closable="false"
              class="mb-4"
              :title="
                vectorOnly
                  ? '这些知识库不能用于当前向量检索'
                  : '以下知识库将回退全文检索'
              "
            >
              <p>
                {{
                  incompatibleKnowledge
                    .map(
                      (kb: any) =>
                        `${kb.name}（${kb.indexVersionId ? (kb.supportsVector ? "模型不兼容" : "未开启向量索引") : "尚未构建索引"}）`,
                    )
                    .join("、")
                }}
              </p>
              <p class="mt-2">
                {{
                  vectorOnly
                    ? "请移除不兼容知识库、选择兼容模型，或明确重建知识库索引；纯向量检索不会自动回退全文。"
                    : "不会混用不同模型的向量，也不会自动重建或更换知识库索引。尚无生效索引的知识库暂不参与检索。"
                }}
              </p>
            </ElAlert>
            <div
              v-if="needsVector"
              class="mb-4 flex flex-wrap items-center gap-3 text-sm text-muted-foreground"
            >
              <span>{{
                vectorOnly
                  ? "仅可关联模型兼容的向量知识库"
                  : "允许关联所有已启用知识库，不兼容时使用全文检索"
              }}</span>
              <ElButton link type="primary" @click="emit('refreshOptions')"
                >刷新模型与知识库选项</ElButton
              >
            </div>
          </template>
        </section>
        <section v-if="show('abilities')" class="space-y-4">
          <h3 class="mb-4 text-base font-semibold">协作能力</h3>
          <ElFormItem label="执行方式">
            <ElSegmented
              v-model="executionMode"
              :options="[
                { label: '单 Agent', value: 'single' },
                { label: '多 Agent', value: 'multi' },
              ]"
            />
          </ElFormItem>
          <template v-if="config.collaboration">
            <ElFormItem required>
              <template #label
                ><span class="inline-flex items-center gap-1"
                  >授权成员
                  <HelpTip
                    text="选择已发布的单 Agent 版本。入口发布后固定成员版本，不随成员的新版本自动切换。成员使用自己的模型、Prompt 和授权能力，只接收明确委派的任务，不继承入口历史；不支持嵌套协作。"
                    long
                  /> </span
              ></template>
              <ElSelect
                v-model="config.collaboration.memberVersionIds"
                multiple
                filterable
                class="w-full"
                placeholder="选择成员 Agent 的发布版本（最多 8 个）"
                :multiple-limit="8"
              >
                <ElOption
                  v-for="member in memberChoices"
                  :key="member.id"
                  :value="member.id"
                  :label="`${member.name} · v${member.version}`"
                  :disabled="memberDisabled(member)"
                />
              </ElSelect>
            </ElFormItem>
            <ElAlert
              v-if="missingMembers.length"
              type="warning"
              :closable="false"
              class="mb-4"
              :title="`成员版本 ${missingMembers.join('、')} 已不可选，请刷新资源并替换后发布。`"
            />
            <div
              v-if="config.collaboration.memberVersionIds?.length"
              class="grid grid-cols-1 gap-x-4 sm:grid-cols-2"
            >
              <ElFormItem label="专项任务次数"
                ><ElInputNumber
                  v-model="config.collaboration.maxDelegations"
                  :min="1"
                  :max="10"
                  controls-position="right"
                  class="w-full"
              /></ElFormItem>
              <ElFormItem label="成员失败策略"
                ><ElSelect
                  v-model="config.collaboration.failurePolicy"
                  class="w-full"
                >
                  <ElOption
                    value="continue"
                    label="继续，说明未完成部分"
                  /><ElOption value="fail" label="终止整个任务" /> </ElSelect
              ></ElFormItem>
            </div>
          </template>
        </section>
        <OutputContractEditor
          v-show="show('output')"
          v-model="config.output"
          :disabled="disabled"
          @valid="emit('valid', $event)"
        />
        <section v-if="show('runtime')" class="space-y-6">
          <div>
            <ElFormItem>
              <template #label
                ><span class="inline-flex items-center gap-1"
                  >允许文件产物<HelpTip
                    long
                    text="允许明确选中的 UTF-8 文件随完成结果保存和下载。最多 5 份、单份 128 KiB、总计 512 KiB，保存 7 天；临时文件不自动保存，不开放宿主机目录或脚本执行。多 Agent 的入口和实际生成文件的成员都必须启用。修改后需要发布才生效。" /></span
              ></template>
              <ElSwitch
                v-model="fileOutputsEnabled"
                aria-label="允许文件产物"
              />
            </ElFormItem>
            <h4 class="my-4 flex items-center gap-1 text-sm font-semibold">
              单轮对话预算限制
              <HelpTip
                text="限制一轮用户请求中累计的模型调用、工具调用和 Token 用量，多 Agent 协作共用本轮预算。关闭后仍受平台防循环、超时等安全保护。模型调用前保守预留 Token，实际用量返回后结算；应用每日额度独立累计并同时生效。"
                long
              />
            </h4>
            <ElAlert
              v-if="!config.executionLimits && !config.collaboration"
              class="mb-4"
              type="info"
              :closable="false"
              title="历史版本沿用原预算。以下为建议值，修改并发布后才启用任务总预算。"
            />
            <div class="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
              <ElFormItem
                v-for="limit in [
                  {
                    key: 'maxModelCalls',
                    label: '总模型调用上限',
                    min: 1,
                    max: 200,
                  },
                  {
                    key: 'maxToolCalls',
                    label: '总工具调用上限',
                    min: 1,
                    max: 200,
                  },
                  {
                    key: 'maxTotalTokens',
                    label: '总 Token 上限',
                    min: 1000,
                    max: 2000000,
                  },
                ]"
                :key="limit.key"
                :label="limit.label"
              >
                <OptionalLimit
                  :model-value="taskBudget[limit.key]"
                  :enabled="taskBudget.enabled?.[limit.key] !== false"
                  :label="limit.label"
                  :min="limit.min"
                  :max="limit.max"
                  :step="limit.key === 'maxTotalTokens' ? 1000 : 1"
                  @update:enabled="setTaskLimitEnabled(limit.key, $event)"
                  @update:model-value="setTaskBudget(limit.key, $event)"
                />
              </ElFormItem>
            </div>
          </div>
          <div v-if="config.knowledgeBaseIds?.length">
            <h3 class="mb-4 text-base font-semibold">检索效果</h3>
            <div class="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
              <ElFormItem
                ><template #label
                  >最终返回数量
                  <HelpTip
                    text="多个知识库的候选会统一融合排序后截取，默认 5 条，最多 8 条。" /></template
                ><ElInputNumber
                  v-model="config.retrieval.topK"
                  :min="1"
                  :max="8"
                  controls-position="right"
                  class="w-full"
              /></ElFormItem>
              <ElFormItem v-if="!vectorOnly"
                ><template #label
                  >全文匹配阈值
                  <HelpTip
                    text="提高阈值可减少弱匹配结果，初始建议 0.15。" /></template
                ><ElInputNumber
                  v-model="config.retrieval.lexicalThreshold"
                  :min="0"
                  :max="1"
                  :step="0.05"
                  controls-position="right"
                  class="w-full"
              /></ElFormItem>
              <ElFormItem v-if="needsVector"
                ><template #label
                  >向量相似度阈值
                  <HelpTip
                    text="初始建议 0.65，结合实际召回测试调整。不同模型的相似度分数不直接比较。"
                    long /></template
                ><ElInputNumber
                  v-model="config.retrieval.vectorThreshold"
                  :min="-1"
                  :max="1"
                  :step="0.05"
                  controls-position="right"
                  class="w-full"
              /></ElFormItem>
              <ElFormItem
                ><template #label
                  >知识上下文上限（字）
                  <HelpTip
                    text="限制统一检索结果进入上下文的总字符数，默认 12000；超过上限会截取内容。" /></template
                ><ElInputNumber
                  v-model="config.retrieval.contextChars"
                  :min="1000"
                  :max="50000"
                  controls-position="right"
                  class="w-full"
              /></ElFormItem>
            </div>
          </div>
        </section>
      </div>
    </template>
    <SkillFields
      v-else-if="kind === 'skill'"
      v-model="config"
      :options="options"
      :resources="resources"
      :disabled="disabled"
      @valid="emit('valid', $event)"
      @save="emit('save')"
    />
    <ToolFields
      v-else
      v-model="config"
      :options="options"
      :disabled="disabled"
      :creating="creating"
      :section="section === 'connection' ? 'connection' : 'all'"
      @valid="emit('valid', $event)"
    />
  </ElForm>
</template>
