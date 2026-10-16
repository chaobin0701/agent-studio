<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Page } from "@vben/common-ui";
import {
  ElAlert,
  ElButton,
  ElEmpty,
  ElForm,
  ElFormItem,
  ElInput,
  ElMessage,
  ElMessageBox,
  ElOption,
  ElSelect,
  ElTabPane,
  ElTabs,
  ElTag,
} from "element-plus";
import { managementApi as api } from "#/api/management";
import HelpTip from "#/components/HelpTip.vue";
import ManagementHeader from "#/components/ManagementHeader.vue";
import PagePanel from "#/components/PagePanel.vue";
import { useUnsavedChanges } from "#/composables/use-unsaved-changes";
import { useWorkspaceStore, type Workspace } from "#/store/workspace";
import Members from "./members.vue";
const ws = useWorkspaceStore(),
  route = useRoute(),
  router = useRouter();
const id = computed(() => Number(route.params.id)),
  workspace = ref<Workspace>(),
  tab = ref("general");
const loading = ref(false),
  settingsLoading = ref(false),
  busy = ref(false),
  error = ref(""),
  settingsError = ref("");
const form = reactive({ name: "", description: "" }),
  original = reactive({ name: "", description: "" });
const settings = ref<{
  canManage: boolean;
  embeddingPlans: any[];
  defaultEmbeddingPlanVersionId: number | null;
}>();
const plan = ref<number | null>(null),
  originalPlan = ref<number | null>(null);
const owner = computed(() => workspace.value?.role === "owner");
const infoDirty = computed(
  () =>
    !!workspace.value &&
    (form.name !== original.name || form.description !== original.description),
);
const modelDirty = computed(
  () => !!settings.value && plan.value !== originalPlan.value,
);
const dirty = computed(() => infoDirty.value || modelDirty.value);
const discard = useUnsavedChanges(dirty, async () => !busy.value);
let generation = 0;
function message(e: any) {
  const text = e.response?.data?.error?.message ?? e.response?.data?.message;
  return typeof text === "string" ? text : "工作区设置加载或保存失败，请重试。";
}
async function loadSettings(request: number, target: number) {
  if (!workspace.value?.enabled) return;
  settingsLoading.value = true;
  settingsError.value = "";
  try {
    const result = await api.get(`/workspaces/${target}/settings`);
    if (request !== generation || target !== id.value) return;
    settings.value = result;
    plan.value = originalPlan.value = result.defaultEmbeddingPlanVersionId;
  } catch (e) {
    if (request === generation) settingsError.value = message(e);
  } finally {
    if (request === generation) settingsLoading.value = false;
  }
}
async function load() {
  const request = ++generation,
    target = id.value;
  loading.value = true;
  error.value = "";
  workspace.value = undefined;
  settings.value = undefined;
  settingsError.value = "";
  try {
    await ws.refresh();
    if (request !== generation || target !== id.value) return;
    const item = ws.items.find((w) => w.id === target);
    if (!item) {
      error.value = "工作区不存在，或你已没有访问权限。";
      return;
    }
    workspace.value = { ...item };
    Object.assign(form, { name: item.name, description: item.description });
    Object.assign(original, form);
    const requested = String(route.query.tab ?? "general");
    tab.value =
      ["general", "models", "members"].includes(requested) &&
      (requested !== "members" || item.role === "owner")
        ? requested
        : "general";
    await loadSettings(request, target);
  } catch (e) {
    if (request === generation) error.value = message(e);
  } finally {
    if (request === generation) loading.value = false;
  }
}
async function refresh() {
  if (busy.value || !(await discard())) return;
  await load();
}
async function saveInfo() {
  if (!owner.value || busy.value || !form.name.trim()) return;
  const request = generation,
    target = id.value,
    body = {
      name: form.name.trim(),
      description: form.description,
      expected: { ...original },
    };
  busy.value = true;
  error.value = "";
  try {
    const result = await api.patch(`/workspaces/${target}`, body);
    if (request !== generation) return;
    Object.assign(form, { name: result.name, description: result.description });
    Object.assign(original, form);
    Object.assign(workspace.value!, form);
    const cached = ws.items.find((w) => w.id === target);
    if (cached) Object.assign(cached, form);
    ElMessage.success("工作区信息已保存");
  } catch (e) {
    if (request === generation) error.value = message(e);
  } finally {
    if (request === generation) busy.value = false;
  }
}
async function saveModel() {
  if (!settings.value?.canManage || busy.value) return;
  const request = generation,
    target = id.value,
    selected = plan.value;
  busy.value = true;
  settingsError.value = "";
  try {
    await api.patch(`/workspaces/${target}/settings`, {
      defaultEmbeddingPlanVersionId: selected,
      expectedDefaultEmbeddingPlanVersionId: originalPlan.value,
    });
    if (request !== generation) return;
    originalPlan.value = selected;
    settings.value.defaultEmbeddingPlanVersionId = selected;
    ElMessage.success("默认向量模型已保存");
  } catch (e) {
    if (request === generation) settingsError.value = message(e);
  } finally {
    if (request === generation) busy.value = false;
  }
}
async function toggle() {
  if (!owner.value || busy.value || !(await discard())) return;
  const target = id.value,
    request = generation,
    enabled = !workspace.value!.enabled;
  try {
    await ElMessageBox.confirm(
      enabled
        ? "恢复工作区访问？"
        : "停用后将阻止该工作区的新请求，配置和历史仍保留。",
      "工作区状态",
      { type: "warning" },
    );
  } catch {
    return;
  }
  if (request !== generation) return;
  busy.value = true;
  error.value = "";
  try {
    await api.patch(`/workspaces/${target}/status`, { enabled });
    if (request !== generation) return;
    if (ws.id === target && !enabled) {
      location.reload();
      return;
    }
    await load();
  } catch (e) {
    if (request === generation) error.value = message(e);
  } finally {
    busy.value = false;
  }
}
watch(
  id,
  () => {
    busy.value = false;
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => generation++);
</script>
<template>
  <Page>
    <ManagementHeader
      :title="workspace?.name ?? '工作区设置'"
      description="工作区级默认配置与成员授权。"
    >
      <ElButton :disabled="busy" @click="router.push('/workspaces')"
        >返回列表</ElButton
      >
      <ElButton :disabled="busy" :loading="loading" @click="refresh"
        >刷新</ElButton
      >
      <ElButton
        v-if="tab === 'general' && owner"
        type="primary"
        :disabled="loading || !infoDirty || !form.name.trim()"
        :loading="busy"
        @click="saveInfo"
        >保存信息</ElButton
      >
      <ElButton
        v-if="tab === 'models' && settings?.canManage"
        type="primary"
        :disabled="loading || !modelDirty"
        :loading="busy"
        @click="saveModel"
        >保存默认模型</ElButton
      >
    </ManagementHeader>
    <ElAlert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      class="mb-4"
    />
    <PagePanel v-loading="loading">
      <template v-if="workspace">
        <div class="mb-4 flex flex-wrap items-center gap-2">
          <ElTag :type="workspace.enabled ? 'success' : 'info'">{{
            workspace.enabled ? "使用中" : "已停用"
          }}</ElTag
          ><span v-if="dirty" class="text-sm text-muted-foreground"
            >有未保存修改</span
          >
        </div>
        <ElTabs v-model="tab">
          <ElTabPane label="基本信息" name="general">
            <ElForm
              label-position="top"
              :disabled="busy || !owner"
              class="max-w-3xl"
              @submit.prevent="saveInfo"
            >
              <ElFormItem label="工作区名称" required
                ><ElInput v-model="form.name" maxlength="120"
              /></ElFormItem>
              <ElFormItem label="描述"
                ><ElInput
                  v-model="form.description"
                  type="textarea"
                  :rows="4"
                  maxlength="2000"
              /></ElFormItem>
            </ElForm>
            <div
              v-if="owner"
              class="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4"
            >
              <div>
                <h2 class="text-sm font-medium">工作区状态</h2>
                <p class="mt-1 text-sm text-muted-foreground">
                  停用不会删除资源或历史记录。
                </p>
              </div>
              <ElButton
                :type="workspace.enabled ? 'danger' : 'primary'"
                plain
                :disabled="busy"
                @click="toggle"
                >{{ workspace.enabled ? "停用工作区" : "恢复工作区" }}</ElButton
              >
            </div>
          </ElTabPane>
          <ElTabPane label="默认模型" name="models">
            <ElAlert
              v-if="settingsError"
              :title="settingsError"
              type="error"
              :closable="false"
              class="mb-4"
            />
            <ElAlert
              v-if="!workspace.enabled"
              title="工作区已停用，恢复后可管理默认模型。"
              type="info"
              :closable="false"
            />
            <div v-else v-loading="settingsLoading" class="max-w-3xl">
              <ElForm
                v-if="settings"
                label-position="top"
                :disabled="busy || !settings.canManage"
                @submit.prevent="saveModel"
              >
                <ElFormItem
                  ><template #label
                    >默认向量模型
                    <HelpTip
                      text="用于新建知识库时预填，不会自动替换已有知识库的模型。只能选择本工作区已发布且可用的方案。" /></template
                  ><ElSelect
                    v-model="plan"
                    clearable
                    filterable
                    class="w-full"
                    placeholder="不设置默认模型"
                    @clear="plan = null"
                    ><ElOption
                      v-if="
                        plan &&
                        !settings.embeddingPlans.some((p) => p.id === plan)
                      "
                      :value="plan"
                      :label="`原方案 #${plan}（当前不可选，可清除）`"
                      disabled /><ElOption
                      v-for="p in settings.embeddingPlans"
                      :key="p.id"
                      :value="p.id"
                      :label="`${p.name} · v${p.version}`" /></ElSelect
                ></ElFormItem>
              </ElForm>
              <ElButton
                v-if="settingsError"
                :disabled="busy"
                @click="loadSettings(generation, id)"
                >重新加载默认模型</ElButton
              >
            </div>
          </ElTabPane>
          <ElTabPane v-if="owner" label="成员" name="members" lazy>
            <Members v-if="workspace.enabled" :workspace-id="id" />
            <ElAlert
              v-else
              title="工作区已停用，恢复后可管理成员授权。"
              type="info"
              :closable="false"
            />
          </ElTabPane>
        </ElTabs>
      </template>
      <ElEmpty v-else-if="!loading" description="无法查看此工作区" />
    </PagePanel>
  </Page>
</template>
