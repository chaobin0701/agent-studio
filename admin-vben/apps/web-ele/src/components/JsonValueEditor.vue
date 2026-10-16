<script setup lang="ts">
import { ref, watch } from "vue";
import JsonEditor from "./JsonEditor.vue";
import { sameJson, type JsonKind } from "./json-validation";
withDefaults(
  defineProps<{
    readonly?: boolean;
    height?: number;
    label?: string;
    kind?: JsonKind;
    validateValue?: (value: unknown) => string | undefined;
  }>(),
  { kind: "any" },
);
const value = defineModel<any>({ required: true });
const text = ref(JSON.stringify(value.value ?? {}, null, 2));
const emit = defineEmits<{ valid: [value: boolean] }>();
watch(
  value,
  (next) => {
    if (!sameJson(text.value, next))
      text.value = JSON.stringify(next ?? {}, null, 2);
  },
  { deep: true },
);
function parsed(next: unknown) {
  if (JSON.stringify(next) !== JSON.stringify(value.value)) value.value = next;
}
</script>
<template>
  <JsonEditor
    v-model="text"
    :readonly="readonly"
    :height="height"
    :label="label"
    :kind="kind"
    :validate-value="validateValue"
    @parsed="parsed"
    @valid="emit('valid', $event)"
  />
</template>
