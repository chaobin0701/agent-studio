<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from "vue";
import { ElAlert, ElFormItem, ElInput } from "element-plus";
import { stringify } from "yaml";
import { frontmatterDiagnostics } from "./frontmatter";
import { readSkillMetadata, updateSkillMetadata } from "./metadata-fields";
import HelpTip from "#/components/HelpTip.vue";
const CodeEditor = defineAsyncComponent(() => import("./code-editor.vue"));
const MarkdownEditor = defineAsyncComponent(
  () => import("./markdown-editor.vue"),
);
const props = defineProps<{
  options?: any;
  resources?: any[];
  disabled?: boolean;
  canSave?: boolean;
  resourceKey?: string;
}>();
const config = defineModel<any>({ required: true });
const emit = defineEmits<{ save: []; valid: [value: boolean] }>();
const frontmatter = ref(""),
  body = ref(""),
  error = ref("");
const metadata = computed(() => readSkillMetadata(frontmatter.value));
function editMetadata(field: "name" | "description", value: string) {
  if (props.disabled || !metadata.value) return;
  frontmatter.value = updateSkillMetadata(frontmatter.value, field, value);
}
const portableName = computed({
  get: () => metadata.value?.name ?? "",
  set: (value: string) => editMetadata("name", value),
});
const description = computed({
  get: () => metadata.value?.description ?? "",
  set: (value: string) => editMetadata("description", value),
});
let adopting = false;
const assemble = () => `---\n${frontmatter.value}\n---\n${body.value}`;
function validate() {
  error.value = "";
  try {
    const diagnostic = frontmatterDiagnostics(frontmatter.value)[0];
    if (diagnostic) throw new Error(diagnostic.message);
    if (body.value.trim().length > 24000)
      throw new Error("Markdown 正文不能超过 24000 字符");
    if (assemble().length > 75000)
      throw new Error("Skill 文档不能超过 75000 字符");
  } catch (e: any) {
    error.value = e.message ?? "YAML 格式不正确";
  }
  emit("valid", !error.value);
}
watch(
  () => config.value,
  (value) => {
    const document = value.document as string | undefined;
    if (document === assemble()) return;
    adopting = true;
    const match =
      document &&
      /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(
        document.replace(/^\uFEFF/, ""),
      );
    if (match) {
      frontmatter.value = match[1]!;
      body.value = match[2]!;
    } else {
      // Published legacy bindings stay in JSON; only content belongs in the editor.
      const meta = {
        name:
          value.portableName ?? props.resourceKey?.replaceAll("_", "-") ?? "",
        description: value.description ?? "",
        ...(value.license ? { license: value.license } : {}),
        ...(value.compatibility ? { compatibility: value.compatibility } : {}),
        ...(value.metadata ? { metadata: value.metadata } : {}),
        ...(value.extraFrontmatter ?? {}),
      };
      frontmatter.value = stringify(meta).trimEnd();
      body.value = value.instructions ?? "";
    }
    validate();
    adopting = false;
  },
  { immediate: true, flush: "sync" },
);
watch(
  [frontmatter, body],
  () => {
    if (adopting) return;
    validate();
    config.value = { ...config.value, document: assemble() };
  },
  { flush: "sync" },
);
</script>
<template>
  <div v-if="metadata" class="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
    <ElFormItem label="Skill 标识" required>
      <template #label>
        <span class="inline-flex items-center gap-1"
          >Skill 标识<HelpTip
            text="用于 SKILL.md 的 name，默认由资源 Key 生成。使用小写字母、数字和短横线；修改不会改变资源 Key 或已有引用。"
            long
        /></span>
      </template>
      <ElInput
        v-model="portableName"
        :disabled="disabled"
        maxlength="64"
        placeholder="例如 document-review"
      />
    </ElFormItem>
    <ElFormItem label="用途 / 使用时机" required class="sm:col-span-2">
      <ElInput
        v-model="description"
        :disabled="disabled"
        type="textarea"
        :rows="2"
        maxlength="1024"
        placeholder="说明这个 Skill 能做什么、Agent 应在什么情况下使用。"
      />
    </ElFormItem>
  </div>
  <ElFormItem v-else label="修复 Frontmatter（YAML）" required>
    <template #label>
      <span class="inline-flex items-center gap-1"
        >修复 Frontmatter（YAML）<HelpTip
          text="当前元信息无法安全转换为表单。修复 YAML 后恢复普通表单；可选和自定义元信息会保留，完整编辑可进入 SKILL.md 源码。"
          long
      /></span>
    </template>
    <CodeEditor
      v-model="frontmatter"
      :readonly="disabled"
      :savable="canSave"
      @save="emit('save')"
    />
  </ElFormItem>
  <ElAlert
    v-if="error"
    :title="error"
    type="error"
    :closable="false"
    class="mb-3"
  />
  <ElAlert
    v-if="!body.trim()"
    title="正文待补充；草稿可保存，补充正文后才能验证和发布。"
    type="info"
    :closable="false"
    class="mb-3"
  />
  <ElFormItem label="操作指导" required class="skill-body">
    <template #label
      ><span class="inline-flex items-center gap-1"
        >操作指导<HelpTip
          text="编写任务步骤、业务规则、示例和注意事项。支持编辑与预览；内容中的代码不会在后台执行。" /></span
    ></template>
    <MarkdownEditor
      v-model="body"
      :readonly="disabled"
      :savable="canSave"
      @save="emit('save')"
    />
  </ElFormItem>
</template>
<style scoped>
.skill-body :deep(.el-form-item__content) {
  display: block;
}
</style>
