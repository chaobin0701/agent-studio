<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Page } from "@vben/common-ui";
import { useAccessStore } from "@vben/stores";
import {
  ElAlert, ElButton, ElCheckbox, ElCheckboxGroup, ElDialog, ElForm,
  ElFormItem, ElInput, ElInputNumber, ElMessage, ElMessageBox,
  ElSwitch, ElTable, ElTableColumn, ElSelect, ElOption, ElTooltip, ElTag,
} from "element-plus";
import { managementApi as api } from "#/api/management";
import PagePanel from "#/components/PagePanel.vue";
import { useWorkspaceStore } from "#/store/workspace";

type Credential = {
  id: number;
  name: string;
  workspaceIds: (number | string)[];
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
};
type RecordingPolicy = {
  auditEnabled: boolean;
  conversationContentEnabled: boolean;
  traceEnabled: boolean;
  usageEnabled: boolean;
};
const access = useAccessStore();
const workspace = useWorkspaceStore();
const canManage = computed(() => access.accessCodes.includes("agent_config.manage"));
const rows = ref<Credential[]>([]);
const loading = ref(false), error = ref(""), formDialog = ref(false), tokenDialog = ref(false);
const saving = ref(false), savingPolicy = ref(false), token = ref("");
const editing = ref<Credential>();
const editingContext = computed(() => editing.value ? `${editing.value.name} · ${workspaceNames(editing.value.workspaceIds)} · ${formatExpiry(editing.value.expiresAt)}` : "");
const ALL_WORKSPACES = 0;
const form = ref({ name: "", workspaceIds: [] as number[], scopes: ["agents.read"] as string[], expiresDays: 90, permanent: false });
const policy = ref<RecordingPolicy>({ auditEnabled: true, conversationContentEnabled: false, traceEnabled: true, usageEnabled: true });
const scopeGroups = [
  { name: "Agent", options: [{ label: "读取", value: "agents.read" }, { label: "管理", value: "agents.manage" }] },
  { name: "Prompt", options: [{ label: "读取", value: "prompts.read" }, { label: "管理", value: "prompts.manage" }] },
  { name: "大语言模型", options: [{ label: "读取", value: "models.read" }, { label: "管理", value: "models.manage" }] },
  { name: "向量模型", options: [{ label: "读取", value: "embeddings.read" }, { label: "管理", value: "embeddings.manage" }] },
  { name: "知识库", options: [{ label: "读取", value: "knowledge.read" }, { label: "管理", value: "knowledge.manage" }] },
  { name: "记录策略", options: [{ label: "读取", value: "recording.read" }, { label: "管理", value: "recording.manage" }] },
  { name: "审计记录", options: [{ label: "读取", value: "audit.read" }] },
  { name: "工作区", options: [{ label: "读取", value: "workspaces.read" }] },
];
const scopeOptions = scopeGroups.flatMap((group) => group.options.map((option) => ({ value: option.value, label: `${group.name} ${option.label}` })));
const allScopesSelected = computed(() => form.value.scopes.includes("*"));
async function load() {
  loading.value = true; error.value = "";
  try {
    [rows.value, policy.value] = await Promise.all([
      api.get<Credential[]>("/system-mcp/credentials"),
      api.get<RecordingPolicy>("/system-mcp/recording-policy"),
    ]);
  } catch (e: any) { error.value = e.response?.data?.message ?? "系统 MCP 配置读取失败"; }
  finally { loading.value = false; }
}
function openCreate() {
  editing.value = undefined;
  form.value = { name: "", workspaceIds: workspace.id ? [workspace.id] : [], scopes: ["agents.read"], expiresDays: 90, permanent: false };
  formDialog.value = true;
}
function openEdit(row: Credential) {
  editing.value = row;
  form.value = { name: row.name, workspaceIds: row.workspaceIds.map(Number), scopes: [...row.scopes], expiresDays: 90, permanent: !row.expiresAt };
  formDialog.value = true;
}
async function saveCredential() {
  if (saving.value) return;
  saving.value = true;
  try {
    if (editing.value) {
      await api.patch(`/system-mcp/credentials/${editing.value.id}/scopes`, { scopes: form.value.scopes, workspaceIds: form.value.workspaceIds });
      ElMessage.success("工作区和访问范围已更新，后续请求立即生效");
    } else {
      const expiresAt = form.value.permanent ? undefined : new Date(Date.now() + form.value.expiresDays * 86400000).toISOString();
      const result = await api.post<{ token: string }>("/system-mcp/credentials", {
        name: form.value.name, workspaceIds: form.value.workspaceIds, scopes: form.value.scopes,
        ...(expiresAt ? { expiresAt } : {}),
      });
      token.value = result.token;
      tokenDialog.value = true;
    }
    formDialog.value = false;
    await load();
  } catch (e: any) { ElMessage.error(e.response?.data?.message ?? "凭证保存失败，请检查账号对工作区的权限"); }
  finally { saving.value = false; }
}
function selectAllScopes() { form.value.scopes = ["*"]; }
function invertScopes() {
  if (form.value.scopes.includes("*")) { form.value.scopes = []; return; }
  const selected = new Set(form.value.scopes);
  form.value.scopes = scopeOptions.filter((scope) => !selected.has(scope.value)).map((scope) => scope.value);
}
function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "未使用";
}
function formatExpiry(value: string | null) { return value ? formatDate(value) : "永久有效"; }
function scopeSummary(scopes: string[]) { return scopes.includes("*") ? "全部权限（含未来新增工具）" : scopes.map((value) => scopeOptions.find((scope) => scope.value === value)?.label ?? value).join("、"); }
function workspaceNames(ids: (number | string)[]) { return ids.some((id) => Number(id) === ALL_WORKSPACES) ? "全部工作区（动态）" : ids.map((id) => workspace.items.find((item) => item.id === Number(id))?.name ?? `工作区 ${id}`).join("、"); }
function updateWorkspaceSelection(ids: number[]) { form.value.workspaceIds = ids.includes(ALL_WORKSPACES) ? [ALL_WORKSPACES] : ids; }
function status(row: Credential) {
  if (row.revokedAt) return { label: "已撤销", type: "info" as const };
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return { label: "已过期", type: "warning" as const };
  return { label: "有效", type: "success" as const };
}
async function revoke(row: Credential) {
  try { await ElMessageBox.confirm(`撤销后，使用「${row.name}」的客户端将无法继续连接。`, "撤销凭证", { type: "warning", confirmButtonText: "撤销", cancelButtonText: "取消" }); }
  catch { return; }
  try { await api.post(`/system-mcp/credentials/${row.id}/revoke`); await load(); }
  catch (e: any) { ElMessage.error(e.response?.data?.message ?? "撤销失败"); }
}
async function savePolicy() {
  savingPolicy.value = true;
  try {
    const { conversationContentEnabled, traceEnabled, usageEnabled } = policy.value;
    policy.value = await api.post("/system-mcp/recording-policy", { auditEnabled: true, conversationContentEnabled, traceEnabled, usageEnabled });
    ElMessage.success("记录策略已保存");
  } catch (e: any) { ElMessage.error(e.response?.data?.message ?? "保存失败"); }
  finally { savingPolicy.value = false; }
}
async function copyToken() { await navigator.clipboard.writeText(token.value); ElMessage.success("令牌已复制"); }
onMounted(async () => { await workspace.initialize(); await load(); });
</script>

<template>
  <Page title="系统 MCP">
    <div class="system-mcp-page">
      <PagePanel>
        <header class="panel-header">
          <div><h2>账号级 MCP 凭证</h2><p>连接地址：<code>/api/mcp/system</code> · 使用当前账号权限，并受工作区和访问范围限制。</p></div>
          <ElButton type="primary" :disabled="!canManage" @click="openCreate">创建凭证</ElButton>
        </header>
        <ElAlert v-if="error" :title="error" type="error" :closable="false" />
        <ElTable :data="rows" v-loading="loading" stripe>
          <ElTableColumn prop="name" label="名称" min-width="160" />
          <ElTableColumn label="工作区" min-width="130"><template #default="{ row }">{{ workspaceNames(row.workspaceIds) }}</template></ElTableColumn>
          <ElTableColumn label="访问范围" min-width="270">
            <template #default="{ row }">
              <div class="scope-cell">
                <ElTooltip :content="scopeSummary(row.scopes)" placement="top" :show-after="200" :popper-style="{ maxWidth: '420px' }"><span class="scope-summary">{{ scopeSummary(row.scopes) }}</span></ElTooltip>
                <span class="scope-count" :aria-label="`共 ${row.scopes.length} 项访问范围`">({{ row.scopes.length }})</span>
              </div>
            </template>
          </ElTableColumn>
          <ElTableColumn label="过期时间" min-width="180"><template #default="{ row }">{{ formatExpiry(row.expiresAt) }}</template></ElTableColumn>
          <ElTableColumn label="最近使用" min-width="180"><template #default="{ row }">{{ formatDate(row.lastUsedAt) }}</template></ElTableColumn>
          <ElTableColumn label="状态" width="90"><template #default="{ row }"><ElTag :type="status(row as Credential).type" effect="plain">{{ status(row as Credential).label }}</ElTag></template></ElTableColumn>
          <ElTableColumn label="操作" width="160" fixed="right">
            <template #default="{ row }">
              <template v-if="!row.revokedAt">
                <ElButton link :disabled="!canManage" @click="openEdit(row as Credential)">调整范围</ElButton>
                <ElButton link type="danger" :disabled="!canManage" @click="revoke(row as Credential)">撤销</ElButton>
              </template>
            </template>
          </ElTableColumn>
        </ElTable>
      </PagePanel>
      <PagePanel>
        <header class="panel-header"><div><h2>记录策略</h2><p>控制平台本地执行轨迹的记录内容；聊天历史和额度结算不受这些开关影响。</p></div></header>
        <div class="policy-list">
          <div class="policy-row"><div><strong>安全审计</strong><p>记录凭证和配置变更，用于追溯管理操作，平台始终保留。</p></div><ElTag type="info" effect="plain">始终记录</ElTag></div>
          <div class="policy-row"><div><strong>平台本地 Trace</strong><p>记录 Agent 执行轨迹，用于排查运行问题。</p></div><ElSwitch v-model="policy.traceEnabled" :disabled="!canManage" aria-label="平台本地 Trace" /></div>
          <div class="policy-row"><div><strong>Trace 正文</strong><p>在执行轨迹中保留提问、模型输出和最终回答。</p></div><ElSwitch v-model="policy.conversationContentEnabled" :disabled="!canManage || !policy.traceEnabled" aria-label="Trace 正文" /></div>
          <div class="policy-row"><div><strong>Trace Token 用量</strong><p>在执行轨迹中记录输入、输出及总 Token 数。</p></div><ElSwitch v-model="policy.usageEnabled" :disabled="!canManage || !policy.traceEnabled" aria-label="Trace Token 用量" /></div>
        </div>
        <p class="policy-note">LangSmith 追踪由服务端观测配置管理。</p>
        <ElButton v-if="canManage" type="primary" :loading="savingPolicy" @click="savePolicy">保存策略</ElButton>
      </PagePanel>
    </div>
    <ElDialog v-model="formDialog" :title="editing ? '调整访问范围' : '创建 MCP 凭证'" width="min(640px, calc(100vw - 32px))" :close-on-click-modal="false">
      <ElForm label-position="top" @submit.prevent="saveCredential">
        <template v-if="!editing">
          <ElFormItem label="凭证名称"><ElInput v-model="form.name" placeholder="例如：内部 Agent 管理助手" maxlength="120" :disabled="saving" /></ElFormItem>
        </template>
        <div class="credential-fields">
          <ElFormItem label="工作区"><ElSelect :model-value="form.workspaceIds" multiple collapse-tags collapse-tags-tooltip placeholder="选择工作区" :disabled="saving" @update:model-value="updateWorkspaceSelection"><ElOption label="全部工作区（动态）" :value="ALL_WORKSPACES" /><ElOption v-for="item in workspace.items" :key="item.id" :label="item.name" :value="item.id" :disabled="!item.enabled" /></ElSelect></ElFormItem>
          <template v-if="!editing">
            <ElFormItem label="有效期">
              <div class="expiry-controls"><ElSwitch v-model="form.permanent" active-text="永久有效" :disabled="saving" /><div v-if="!form.permanent" class="expiry-days"><ElInputNumber v-model="form.expiresDays" :min="1" :max="3650" controls-position="right" :disabled="saving" /><span>天</span></div></div>
            </ElFormItem>
          </template>
        </div>
        <div v-if="editing" class="credential-context"><strong>{{ editingContext }}</strong></div>
        <section class="scopes-section" aria-labelledby="scopes-heading">
          <div class="scope-toolbar">
            <span id="scopes-heading">访问范围 <span class="muted">{{ form.scopes.includes("*") ? "全部权限" : `已选 ${form.scopes.length} / ${scopeOptions.length}` }}</span></span>
            <div><ElButton link type="primary" :disabled="allScopesSelected || saving" @click="selectAllScopes">全选</ElButton><ElButton link type="primary" :disabled="saving" @click="invertScopes">反选</ElButton></div>
          </div>
          <div class="all-scope-option">
            <ElCheckbox :model-value="form.scopes.includes('*')" :disabled="!canManage || saving" @change="(checked: unknown) => { form.scopes = checked ? ['*'] : [] }">全部权限（含未来新增工具）</ElCheckbox>
            <ElAlert v-if="form.scopes.includes('*')" class="all-scope-warning" title="高权限范围：每次调用仍会检查账号在目标工作区的实际权限。授权及变更会写入安全审计。" type="warning" :closable="false" />
          </div>
          <ElCheckboxGroup v-model="form.scopes" :disabled="!canManage || saving" class="scope-options">
            <div v-for="group in scopeGroups" :key="group.name" class="scope-row">
              <span class="scope-group-name">{{ group.name }}</span><ElCheckbox v-for="scope in group.options" :key="scope.value" :value="scope.value" :aria-label="`${group.name} ${scope.label}`">{{ scope.label }}</ElCheckbox>
            </div>
          </ElCheckboxGroup>
        </section>
      </ElForm>
      <template #footer><ElButton :disabled="saving" @click="formDialog = false">取消</ElButton><ElButton type="primary" :loading="saving" :disabled="!canManage || !form.name.trim() || !form.scopes.length || !form.workspaceIds.length" @click="saveCredential">{{ editing ? '保存范围' : '创建凭证' }}</ElButton></template>
    </ElDialog>
    <ElDialog v-model="tokenDialog" title="凭证已创建" width="min(560px, calc(100vw - 32px))" :close-on-click-modal="false" :close-on-press-escape="false" @closed="token = ''">
      <ElAlert title="令牌仅显示一次，请复制并妥善保存。" type="warning" :closable="false" />
      <ElInput :model-value="token" readonly type="textarea" :rows="3" class="token-field" aria-label="MCP 凭证令牌" />
      <template #footer><ElButton @click="copyToken">复制令牌</ElButton><ElButton type="primary" @click="tokenDialog = false">我已保存</ElButton></template>
    </ElDialog>
  </Page>
</template>

<style scoped>
.system-mcp-page { display: grid; gap: 16px; }
.panel-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.panel-header h2 { font-size: 16px; font-weight: 600; }
.panel-header p, .policy-row p, .policy-note { margin-top: 6px; font-size: 13px; color: var(--el-text-color-secondary); }
.panel-header > .el-button { flex-shrink: 0; }
.credential-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.expiry-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.expiry-days { display: flex; align-items: center; gap: 8px; }
.expiry-days .el-input-number { width: 110px; }
.credential-context { display: flex; flex-direction: column; gap: 6px; margin-bottom: 24px; }
.credential-context span, .muted { color: var(--el-text-color-secondary); font-size: 13px; }
.all-scope-warning { margin: 8px 0 12px; }
.all-scope-option { padding: 10px 12px; background: var(--el-fill-color-lighter); border-bottom: 1px solid var(--el-border-color-lighter); }
.muted { margin-left: 8px; }
.scope-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px; }
.scope-options { border-top: 1px solid var(--el-border-color-lighter); }
.scope-row { display: grid; grid-template-columns: minmax(100px, 1fr) 90px 90px; align-items: center; gap: 8px; min-height: 42px; border-bottom: 1px solid var(--el-border-color-lighter); }
.scope-group-name { font-size: var(--el-font-size-base); line-height: 1.5; color: var(--el-text-color-regular); }
.scope-row .el-checkbox { margin-right: 0; }
.scope-cell { display: flex; align-items: flex-start; gap: 8px; }
.scope-summary { min-width: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.6; }
.scope-count { color: var(--el-text-color-secondary); white-space: nowrap; flex-shrink: 0; line-height: 1.6; }
.policy-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 14px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.policy-row strong { font-weight: 500; }
.policy-row .el-tag, .policy-row .el-switch { flex-shrink: 0; }
.policy-note { margin: 12px 0 16px; }
.token-field { margin-top: 16px; }
@media (max-width: 600px) { .credential-fields { grid-template-columns: 1fr; gap: 0; } .panel-header { align-items: flex-start; } }
</style>
