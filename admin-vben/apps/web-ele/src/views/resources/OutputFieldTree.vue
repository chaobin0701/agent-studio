<script setup lang="ts">
import { ref } from "vue";
import { ElButton, ElCheckbox, ElDialog, ElDropdown, ElDropdownItem, ElDropdownMenu, ElForm, ElFormItem, ElInput, ElInputNumber, ElOption, ElSelect, ElTable, ElTableColumn } from "element-plus";
import { FIELD_TYPES, addField, changeFieldType, copyField, fieldSiblings, type OutputField } from "./output-editor";
const props = defineProps<{ rows: OutputField[]; disabled?: boolean }>();
const emit = defineEmits<{ change: [] }>();
const editing = ref<OutputField>();
const settingsOpen = ref(false);
const labels: Record<string, string> = { string: "字符串", number: "数字", integer: "整数", boolean: "布尔值", object: "对象", array: "数组", null: "null" };
function command(action: string, candidate: unknown) {
  const row = candidate as OutputField;
  if (action === "settings") { editing.value = row; settingsOpen.value = true; return; }
  if (props.disabled) return;
  const siblings = fieldSiblings(props.rows, row.id);
  if (!siblings) return;
  if (action === "add") addField(row.children);
  if (action === "copy" && !row.isItem) copyField(siblings, row);
  if (action === "delete" && !row.isItem) siblings.splice(siblings.indexOf(row), 1);
  emit("change");
}
</script>
<template>
  <div class="min-w-0 space-y-3">
    <ElTable :data="rows" row-key="id" :tree-props="{ children: 'children' }" default-expand-all size="small" empty-text="添加第一个返回字段">
      <ElTableColumn label="字段名称" min-width="200">
        <template #default="{ row }">
          <span v-if="row.isItem" class="text-muted-foreground">数组元素</span>
          <ElInput v-else v-model="row.name" aria-label="字段名称" :disabled="disabled" @input="emit('change')" />
        </template>
      </ElTableColumn>
      <ElTableColumn label="类型" width="116">
        <template #default="{ row }">
          <ElSelect v-model="row.type" aria-label="字段类型" :disabled="disabled" @change="changeFieldType(row as OutputField); emit('change')">
            <ElOption v-for="type in FIELD_TYPES" :key="type" :value="type" :label="labels[type]" />
          </ElSelect>
        </template>
      </ElTableColumn>
      <ElTableColumn label="必须出现" width="85" align="center">
        <template #default="{ row }"><ElCheckbox v-if="!row.isItem" v-model="row.required" aria-label="字段必须出现" :disabled="disabled" @change="emit('change')" /></template>
      </ElTableColumn>
      <ElTableColumn label="允许 null" width="86" align="center">
        <template #default="{ row }"><ElCheckbox v-model="row.nullable" aria-label="允许 null" :disabled="disabled || row.type === 'null'" @change="emit('change')" /></template>
      </ElTableColumn>
      <ElTableColumn label="描述与约束" min-width="140">
        <template #default="{ row }">
          <ElButton link type="primary" @click="command('settings', row)">{{ row.description || '设置' }}</ElButton>
        </template>
      </ElTableColumn>
      <ElTableColumn v-if="!disabled" width="86" align="right">
        <template #default="{ row }">
          <ElDropdown trigger="click" @command="(action: string) => command(action, row)">
            <ElButton link aria-label="字段操作">操作</ElButton>
            <template #dropdown><ElDropdownMenu>
              <ElDropdownItem v-if="row.type === 'object'" command="add">添加子字段</ElDropdownItem>
              <ElDropdownItem v-if="!row.isItem" command="copy">复制字段</ElDropdownItem>
              <ElDropdownItem v-if="!row.isItem" command="delete">删除字段</ElDropdownItem>
              <ElDropdownItem command="settings">描述与约束</ElDropdownItem>
            </ElDropdownMenu></template>
          </ElDropdown>
        </template>
      </ElTableColumn>
    </ElTable>
    <ElButton v-if="!disabled" @click="addField(rows); emit('change')">添加字段</ElButton>
    <p class="text-xs leading-6 text-muted-foreground">“必须出现”控制字段能否省略，“允许 null”控制字段值。切换类型会重置该字段的子字段与类型约束；源码中的其他规则保留。</p>
    <ElDialog
      v-model="settingsOpen"
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      title="描述与约束"
      width="min(560px,95vw)"
      append-to-body
    >
      <ElForm v-if="editing" label-position="top" :disabled="disabled">
        <ElFormItem label="字段描述"><ElInput v-model="editing.description" type="textarea" :rows="2" aria-label="字段描述" @input="emit('change')" /></ElFormItem>
        <ElFormItem v-if="['string','number','integer','boolean','null'].includes(editing.type)" label="枚举（JSON 数组，可不填）">
          <ElInput v-model="editing.enumText" aria-label="字段枚举" placeholder='例如 ["已完成", "待处理"]' @input="emit('change')" />
        </ElFormItem>
        <div class="grid grid-cols-2 gap-x-4">
          <template v-for="limit in (
            editing.type === 'string' ? [{ key: 'minLength', label: '最短长度' }, { key: 'maxLength', label: '最长长度' }] :
            editing.type === 'array' ? [{ key: 'minItems', label: '最少元素' }, { key: 'maxItems', label: '最多元素' }] :
            ['number','integer'].includes(editing.type) ? [{ key: 'minimum', label: '最小值（含）' }, { key: 'maximum', label: '最大值（含）' }, { key: 'exclusiveMinimum', label: '最小值（不含）' }, { key: 'exclusiveMaximum', label: '最大值（不含）' }] : []
          )" :key="limit.key">
            <ElFormItem :label="limit.label"><ElInputNumber v-model="editing.schema[limit.key]" :aria-label="limit.label" :precision="['string','array'].includes(editing.type) ? 0 : undefined" :min="['string','array'].includes(editing.type) ? 0 : undefined" controls-position="right" @change="emit('change')" /></ElFormItem>
          </template>
        </div>
      </ElForm>
      <template #footer><ElButton @click="settingsOpen = false">完成</ElButton></template>
    </ElDialog>
  </div>
</template>
