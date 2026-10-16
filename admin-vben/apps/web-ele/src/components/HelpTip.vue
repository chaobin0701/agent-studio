<script setup lang="ts">
import { ref } from "vue";
import { ElButton, ElPopover, ElTooltip } from "element-plus";
defineProps<{ text: string; long?: boolean }>();
const visible = ref(false),
  pinned = ref(false);
</script>
<template>
  <ElPopover v-if="long" :visible="visible" width="320" :content="text">
    <template #reference
      ><ElButton
        link
        aria-label="说明"
        :aria-expanded="visible"
        @mouseenter="visible = true"
        @mouseleave="visible = pinned"
        @focus="visible = true"
        @blur="
          visible = false;
          pinned = false;
        "
        @click="
          pinned = !pinned;
          visible = pinned;
        "
        >ⓘ</ElButton
      ></template
    >
  </ElPopover>
  <ElTooltip v-else :content="text"
    ><ElButton link aria-label="说明">ⓘ</ElButton></ElTooltip
  >
</template>
