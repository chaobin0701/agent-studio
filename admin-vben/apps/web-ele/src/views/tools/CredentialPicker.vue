<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useAccessStore } from "@vben/stores";
import {
  ElSelect,
  ElOption,
  ElButton,
  ElDialog,
  ElForm,
  ElFormItem,
  ElInput,
  ElMessage,
  ElTable,
  ElTableColumn,
  ElAlert,
} from "element-plus";
import { managementApi as api } from "#/api/management";
const selected = defineModel<number | undefined>();
const props = defineProps<{ disabled?: boolean }>();
const access = useAccessStore();
const credentials = ref<any[]>([]),
  open = ref(false),
  createOpen = ref(false),
  busy = ref(false),
  error = ref("");
const draft = ref({
  name: "",
  kind: "bearer",
  header: "X-API-Key",
  secret: "",
});
const rotation = ref<any>(),
  newSecret = ref("");
const canManage = () => access.accessCodes.includes("agent_config.manage");
function message(e: any) {
  return (
    e.response?.data?.error?.message ??
    e.response?.data?.message ??
    "凭证操作失败"
  );
}
async function load() {
  try {
    credentials.value = (
      await api.get("/external-tools/credentials")
    ).credentials;
  } catch (e) {
    error.value = String(message(e));
  }
}
async function run(work: () => Promise<void>) {
  busy.value = true;
  error.value = "";
  try {
    await work();
  } catch (e) {
    error.value = String(message(e));
  } finally {
    busy.value = false;
  }
}
async function create() {
  await run(async () => {
    const result = await api.post("/external-tools/credentials", draft.value);
    selected.value = result.id;
    draft.value = { name: "", kind: "bearer", header: "X-API-Key", secret: "" };
    createOpen.value = false;
    await load();
    ElMessage.success("凭证已加密保存");
  });
}
async function toggle(row: any) {
  await run(async () => {
    await api.patch(`/external-tools/credentials/${row.id}`, {
      revision: row.revision,
      enabled: !row.enabled,
    });
    await load();
  });
}
async function rotate() {
  await run(async () => {
    await api.patch(`/external-tools/credentials/${rotation.value.id}`, {
      revision: rotation.value.revision,
      secret: newSecret.value,
    });
    newSecret.value = "";
    rotation.value = undefined;
    await load();
    ElMessage.success("凭证已轮换");
  });
}
onMounted(load);
</script>
<template>
  <div class="flex w-full flex-wrap gap-2">
    <ElSelect
      v-model="selected"
      :disabled="props.disabled"
      clearable
      filterable
      placeholder="无认证"
      class="min-w-60 flex-1"
      ><ElOption
        v-for="row in credentials"
        :key="row.id"
        :value="row.id"
        :label="`${row.name} · ${row.kind}${row.enabled ? '' : '（已停用）'}`"
        :disabled="!row.enabled"
    /></ElSelect>
    <ElButton
      v-if="canManage()"
      :disabled="props.disabled"
      @click="
        open = true;
        load();
      "
      >管理凭证</ElButton
    >
    <ElAlert
      v-if="error && !open"
      type="error"
      :title="error"
      :closable="false"
    />
  </div>
  <ElDialog
    class="management-dialog"
    body-class="management-dialog-body"
    header-class="management-dialog-header"
    footer-class="management-dialog-footer"
    v-model="open"
    title="工具凭证"
    width="720px"
    append-to-body
  >
    <ElAlert
      title="密钥加密保存，不回显原文。轮换或停用会影响引用此凭证的 HTTP 和 MCP 工具。"
      type="info"
      :closable="false"
      class="mb-4"
    />
    <ElAlert
      v-if="error"
      type="error"
      :title="error"
      :closable="false"
      class="mb-4"
    />
    <ElButton type="primary" @click="createOpen = true" class="mb-4"
      >新增凭证</ElButton
    >
    <ElTable :data="credentials" v-loading="busy"
      ><ElTableColumn prop="name" label="名称" /><ElTableColumn
        prop="kind"
        label="类型"
      /><ElTableColumn label="状态"
        ><template #default="{ row }">{{
          row.enabled ? "启用" : "停用"
        }}</template></ElTableColumn
      ><ElTableColumn label="操作" width="170"
        ><template #default="{ row }"
          ><ElButton
            link
            @click="
              rotation = row;
              newSecret = '';
            "
            >轮换</ElButton
          ><ElButton link @click="toggle(row)">{{
            row.enabled ? "停用" : "启用"
          }}</ElButton></template
        ></ElTableColumn
      ></ElTable
    >
  </ElDialog>
  <ElDialog
    class="management-dialog"
    body-class="management-dialog-body"
    header-class="management-dialog-header"
    footer-class="management-dialog-footer"
    v-model="createOpen"
    title="新增工具凭证"
    width="520px"
    append-to-body
    :close-on-click-modal="false"
    @closed="draft.secret = ''"
  >
    <ElForm label-position="top"
      ><ElFormItem label="名称" required
        ><ElInput v-model="draft.name" /></ElFormItem
      ><ElFormItem label="认证方式"
        ><ElSelect v-model="draft.kind"
          ><ElOption value="bearer" label="Bearer Token" /><ElOption
            value="api_key"
            label="API Key 请求头" /></ElSelect></ElFormItem
      ><ElFormItem v-if="draft.kind === 'api_key'" label="请求头名称"
        ><ElInput v-model="draft.header" /></ElFormItem
      ><ElFormItem label="密钥" required
        ><ElInput
          v-model="draft.secret"
          type="password"
          show-password
          autocomplete="new-password" /></ElFormItem
    ></ElForm>
    <ElAlert v-if="error" :title="error" type="error" :closable="false" />
    <template #footer
      ><ElButton @click="createOpen = false">取消</ElButton
      ><ElButton
        type="primary"
        :loading="busy"
        :disabled="!draft.name || !draft.secret"
        @click="create"
        >保存</ElButton
      ></template
    >
  </ElDialog>
  <ElDialog
    class="management-dialog"
    body-class="management-dialog-body"
    header-class="management-dialog-header"
    footer-class="management-dialog-footer"
    :model-value="!!rotation"
    title="轮换凭证"
    width="480px"
    append-to-body
    @close="
      rotation = undefined;
      newSecret = '';
    "
  >
    <ElInput
      v-model="newSecret"
      type="password"
      show-password
      placeholder="输入新的密钥"
      autocomplete="new-password"
    /><ElAlert v-if="error" :title="error" type="error" :closable="false" />
    <template #footer
      ><ElButton
        type="primary"
        :loading="busy"
        :disabled="!newSecret"
        @click="rotate"
        >确认轮换</ElButton
      ></template
    >
  </ElDialog>
</template>
