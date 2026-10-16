<script setup lang="ts">
import { computed, ref } from "vue";
import {
  ElAlert,
  ElButton,
  ElDialog,
  ElEmpty,
  ElForm,
  ElFormItem,
  ElInput,
  ElMessageBox,
  ElTable,
  ElTableColumn,
  ElUpload,
  type UploadFile,
  type UploadInstance,
} from "element-plus";
import HelpTip from "#/components/HelpTip.vue";
import { useUnsavedChanges } from "#/composables/use-unsaved-changes";
import {
  readResourceFile,
  resourceError,
  utf8Bytes,
  type SkillResource,
} from "./resources";

const props = defineProps<{ disabled?: boolean }>();
const files = defineModel<SkillResource[]>({ required: true });
const open = ref(false),
  reading = ref(false),
  index = ref(-1),
  error = ref("");
const path = ref("references/example.md"),
  content = ref(""),
  original = ref("");
const upload = ref<UploadInstance>();
let generation = 0;
const dirty = computed(
  () =>
    open.value &&
    !props.disabled &&
    JSON.stringify({ path: path.value, content: content.value }) !==
      original.value,
);
const confirmDiscard = useUnsavedChanges(dirty);
function edit(i = -1) {
  generation++;
  index.value = i;
  path.value = files.value[i]?.path ?? "references/example.md";
  content.value = files.value[i]?.content ?? "";
  original.value = JSON.stringify({ path: path.value, content: content.value });
  error.value = "";
  open.value = true;
}
async function close(done?: () => void) {
  if (reading.value || !(await confirmDiscard())) return;
  generation++;
  open.value = false;
  done?.();
}
async function importFile(file: UploadFile) {
  if (!file.raw || props.disabled || reading.value) return;
  const current = generation;
  reading.value = true;
  error.value = "";
  try {
    const text = await readResourceFile(file.raw);
    if (current !== generation) return;
    const parent =
      path.value.slice(0, path.value.lastIndexOf("/") + 1) || "references/";
    path.value = parent + file.name;
    content.value = text;
  } catch (e) {
    if (current === generation)
      error.value = e instanceof Error ? e.message : "读取失败";
  } finally {
    reading.value = false;
    upload.value?.clearFiles();
  }
}
function apply() {
  if (props.disabled || reading.value) return;
  const next = files.value.map((file) => ({ ...file }));
  const file = { path: path.value, content: content.value };
  if (index.value < 0) next.push(file);
  else next[index.value] = file;
  error.value = resourceError(next) ?? "";
  if (error.value) return;
  files.value = next;
  open.value = false;
}
async function remove(i: number) {
  if (props.disabled) return;
  try {
    await ElMessageBox.confirm(
      `从工作草稿移除 ${files.value[i]?.path}？历史发布版本不会改变。`,
      "移除辅助资料",
      { type: "warning" },
    );
  } catch {
    return;
  }
  files.value = files.value.filter((_, n) => n !== i);
}
</script>
<template>
  <section class="space-y-3" aria-label="Skill 辅助资料">
    <div class="flex flex-wrap items-center gap-2">
      <ElButton v-if="!disabled" :disabled="files.length >= 16" @click="edit()"
        >添加辅助资料</ElButton
      >
      <span>{{ files.length }} / 16 份</span>
      <HelpTip
        text="资料随 Skill 版本发布，Agent 按需读取，只读且不会执行代码。支持 references/ 参考文档、assets/ 文本模板、scripts/ 脚本源码。单份 64 KiB，总量 192 KiB；完整配置最多 384 KiB。"
        long
      />
    </div>
    <ElTable v-if="files.length" :data="files" row-key="path">
      <ElTableColumn prop="path" label="相对路径" min-width="240" />
      <ElTableColumn label="大小" width="120"
        ><template #default="{ row }"
          >{{ (utf8Bytes(row.content) / 1024).toFixed(1) }} KiB</template
        ></ElTableColumn
      >
      <ElTableColumn label="操作" width="180"
        ><template #default="{ $index }">
          <ElButton link type="primary" @click="edit($index)">{{
            disabled ? "查看" : "编辑"
          }}</ElButton>
          <ElButton v-if="!disabled" link type="danger" @click="remove($index)"
            >移除</ElButton
          >
        </template></ElTableColumn
      >
    </ElTable>
    <ElEmpty v-else description="没有辅助资料，仍可正常使用此 Skill" />
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      v-model="open"
      :title="disabled ? '查看辅助资料' : '编辑辅助资料'"
      width="min(860px, 92vw)"
      :before-close="close"
      :close-on-click-modal="false"
      destroy-on-close
    >
      <ElForm label-position="top" :disabled="reading">
        <ElFormItem label="相对路径" required
          ><ElInput
            v-model="path"
            placeholder="references/guide.md"
            :maxlength="160"
            :readonly="disabled"
        /></ElFormItem>
        <ElFormItem v-if="!disabled" label="导入文本文件">
          <ElUpload
            ref="upload"
            :auto-upload="false"
            :show-file-list="false"
            :on-change="importFile"
            :disabled="reading"
            drag
          >
            <span>点击或拖放 UTF-8 文本，先读取到编辑框，确认后添加</span>
            <template #tip
              ><span class="text-muted-foreground text-sm"
                >仅文本，每份不超过 64 KiB；不会自动上传或执行。</span
              ></template
            >
          </ElUpload>
        </ElFormItem>
        <ElFormItem label="文本内容"
          ><ElInput
            v-model="content"
            type="textarea"
            :rows="18"
            :readonly="disabled"
        /></ElFormItem>
      </ElForm>
      <ElAlert v-if="error" :title="error" type="error" :closable="false" />
      <template #footer>
        <ElButton :disabled="reading" @click="close()">{{
          disabled ? "关闭" : "取消"
        }}</ElButton>
        <ElButton
          v-if="!disabled"
          type="primary"
          :loading="reading"
          @click="apply"
          >{{ index < 0 ? "确认添加到草稿" : "确认更新草稿" }}</ElButton
        >
      </template>
    </ElDialog>
  </section>
</template>
