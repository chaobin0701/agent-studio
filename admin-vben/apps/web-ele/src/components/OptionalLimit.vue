<script setup lang="ts">
import { ElInputNumber, ElSwitch } from "element-plus";
defineProps<{
  modelValue?: number | null;
  enabled: boolean;
  label: string;
  min?: number;
  max?: number;
  step?: number;
}>();
defineEmits<{
  "update:modelValue": [value: number | undefined];
  "update:enabled": [value: boolean];
}>();
</script>
<template>
  <div class="flex w-full items-center gap-3">
    <ElSwitch
      :model-value="enabled"
      :aria-label="`启用${label}`"
      active-text="限制"
      inactive-text="未开启"
      @update:model-value="$emit('update:enabled', Boolean($event))"
    />
    <ElInputNumber
      class="min-w-0 flex-1"
      :model-value="modelValue ?? undefined"
      :min="min ?? 1"
      :max="max"
      :step="step ?? 1"
      :disabled="!enabled"
      controls-position="right"
      :aria-label="label"
      @update:model-value="$emit('update:modelValue', $event)"
    />
  </div>
</template>
