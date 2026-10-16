<script setup lang="ts">
import { ref, watch } from "vue";
import JsonEditor from "#/components/JsonEditor.vue";
import { sameJson } from "#/components/json-validation";
import {
  ElTable,
  ElTableColumn,
  ElInput,
  ElSelect,
  ElOption,
  ElCheckbox,
  ElButton,
  ElAlert,
  ElSwitch,
} from "element-plus";
const schema = defineModel<any>({ required: true });
const props = defineProps<{ disabled?: boolean; advancedOnly?: boolean }>();
const emit = defineEmits<{ valid: [value: boolean] }>();
const advanced = ref(!!props.advancedOnly),
  text = ref(""),
  error = ref(""),
  rows = ref<any[]>([]);
watch(
  () => schema.value,
  (value) => {
    if (!sameJson(text.value, value))
      text.value = JSON.stringify(value ?? {}, null, 2);
    rows.value = Object.entries(value?.properties ?? {}).map(
      ([name, definition]: any) => ({
        name,
        original: name,
        type: definition.type ?? "object",
        description: definition.description ?? "",
        required: (value.required ?? []).includes(name),
      }),
    );
  },
  { immediate: true, deep: true },
);
function jsonChange(value: unknown) {
  if (!sameJson(JSON.stringify(schema.value), value)) schema.value = value;
  error.value = "";
}
function apply() {
  const names = rows.value.map((row) => row.name.trim());
  if (names.some((name) => !name) || new Set(names).size !== names.length) {
    error.value = "参数名不能为空或重复";
    emit("valid", false);
    return;
  }
  const properties = Object.fromEntries(
    rows.value.map((row) => {
      const definition = {
        ...(schema.value?.properties?.[row.original] ?? {}),
        type: row.type,
        description: row.description,
      };
      if (row.type === "array" && !definition.items)
        definition.items = { type: "string" };
      return [row.name.trim(), definition];
    }),
  );
  schema.value = {
    ...schema.value,
    type: "object",
    properties,
    required: rows.value
      .filter((row) => row.required)
      .map((row) => row.name.trim()),
  };
  error.value = "";
  emit("valid", true);
}
function add() {
  rows.value.push({
    name: `param_${rows.value.length + 1}`,
    original: "",
    type: "string",
    description: "",
    required: false,
  });
  apply();
}
function remove(index: number) {
  rows.value.splice(index, 1);
  apply();
}
</script>
<template>
  <div class="w-full space-y-3">
    <div v-if="!advancedOnly" class="flex items-center gap-2">
      <ElSwitch v-model="advanced" :disabled="disabled || !!error" /><span
        >高级 JSON Schema 编辑</span
      >
    </div>
    <JsonEditor
      v-if="advanced || advancedOnly"
      v-model="text"
      :readonly="disabled"
      kind="object"
      label="JSON Schema"
      @parsed="jsonChange"
      @valid="emit('valid', $event)"
      @error="error = $event"
    />
    <template v-else
      ><ElTable :data="rows"
        ><ElTableColumn label="参数名"
          ><template #default="{ row }"
            ><ElInput
              v-model="row.name"
              :disabled="disabled"
              @change="apply" /></template></ElTableColumn
        ><ElTableColumn label="类型" width="145"
          ><template #default="{ row }"
            ><ElSelect v-model="row.type" :disabled="disabled" @change="apply"
              ><ElOption
                v-for="type in [
                  'string',
                  'integer',
                  'number',
                  'boolean',
                  'object',
                  'array',
                ]"
                :key="type"
                :value="type"
                :label="type" /></ElSelect></template></ElTableColumn
        ><ElTableColumn label="必填" width="75"
          ><template #default="{ row }"
            ><ElCheckbox
              v-model="row.required"
              :disabled="disabled"
              @change="apply" /></template></ElTableColumn
        ><ElTableColumn label="描述"
          ><template #default="{ row }"
            ><ElInput
              v-model="row.description"
              :disabled="disabled"
              @change="apply" /></template></ElTableColumn
        ><ElTableColumn width="75"
          ><template #default="{ $index }"
            ><ElButton link :disabled="disabled" @click="remove($index)"
              >移除</ElButton
            ></template
          ></ElTableColumn
        ></ElTable
      ><ElButton :disabled="disabled" @click="add">添加参数</ElButton></template
    >
    <ElAlert
      v-if="error && !(advanced || advancedOnly)"
      :title="error"
      type="error"
      :closable="false"
    />
  </div>
</template>
