<script setup lang="ts">
import { computed } from "vue";
import {
  ElAlert,
  ElCheckbox,
  ElCheckboxGroup,
  ElDivider,
  ElForm,
  ElFormItem,
  ElInput,
  ElOption,
  ElSelect,
  ElSwitch,
} from "element-plus";
import HelpTip from "#/components/HelpTip.vue";
import OptionalLimit from "#/components/OptionalLimit.vue";
const props = defineProps<{
  agents: any[];
  disabled?: boolean;
  basicOnly?: boolean;
}>();
const config = defineModel<any>({ required: true });
const origins = defineModel<string>("origins", { required: true });
const limits = [
  { key: "requestsPerMinute", label: "每分钟请求上限", max: 10000 },
  { key: "concurrency", label: "同时执行上限", max: 100 },
  { key: "dailyRequests", label: "每日请求上限", max: 1000000 },
  { key: "dailyTokenLimit", label: "每日 Token 上限", max: 1000000000000 },
];
function limitEnabled(key: string): boolean {
  return (
    config.value.limitSettings?.[key] ??
    (key === "dailyTokenLimit" ? config.value.dailyTokenLimit != null : true)
  );
}
function setLimitEnabled(key: string, value: boolean) {
  config.value.limitSettings = {
    ...Object.fromEntries(limits.map((v) => [v.key, limitEnabled(v.key)])),
    [key]: value,
  };
  if (value && config.value[key] == null)
    config.value[key] = key === "dailyTokenLimit" ? 1000000 : 1;
}
const selected = computed(() =>
  props.agents.find((a) => a.id === config.value.agentId),
);
</script>
<template>
  <ElForm
    label-position="top"
    :disabled="disabled"
    class="grid grid-cols-1 gap-x-4 sm:grid-cols-2"
  >
    <ElFormItem label="应用名称" required
      ><ElInput v-model="config.name" maxlength="100"
    /></ElFormItem>
    <ElFormItem label="Agent" required
      ><ElSelect
        v-model="config.agentId"
        filterable
        class="w-full"
        placeholder="选择 Agent"
      >
        <ElOption
          v-for="a in agents"
          :key="a.id"
          :value="a.id"
          :label="`${a.name}${!a.enabled ? ' · 停用' : !a.currentVersionId ? ' · 待发布' : ''}`"
          :disabled="
            !a.enabled ||
            ((config.websiteEnabled || config.apiEnabled) &&
              !a.currentVersionId)
          "
        /> </ElSelect
    ></ElFormItem>
    <ElAlert
      v-if="selected && !selected.currentVersionId"
      class="mb-4 sm:col-span-2"
      title="此 Agent 尚未发布，应用只能用于后台草稿试运行。"
      type="info"
      :closable="false"
    />
    <template v-if="!basicOnly">
      <ElFormItem label="应用状态"
        ><ElSwitch
          v-model="config.enabled"
          active-text="启用"
          inactive-text="停用"
      /></ElFormItem>
      <ElFormItem label="接入通道"
        ><div class="flex flex-wrap gap-4">
          <ElSwitch
            v-model="config.websiteEnabled"
            :disabled="!selected?.currentVersionId"
            active-text="网站"
          /><ElSwitch
            v-model="config.apiEnabled"
            :disabled="!selected?.currentVersionId"
            active-text="API"
          /></div
      ></ElFormItem>
      <ElFormItem
        v-if="config.websiteEnabled"
        label="网站授权 Origin"
        required
        class="sm:col-span-2"
        ><template #label
          ><span class="inline-flex items-center gap-1"
            >网站授权 Origin<HelpTip
              text="一行一个完整来源，例如 https://example.com。不填路径，不使用通配符。本地开发可使用 http://localhost:端口。"
              long /></span></template
        ><ElInput
          v-model="origins"
          type="textarea"
          :rows="3"
          placeholder="https://example.com"
      /></ElFormItem>
      <ElFormItem label="允许的操作" required class="sm:col-span-2"
        ><ElCheckboxGroup v-model="config.scopes"
          ><ElCheckbox value="chat:write">执行任务</ElCheckbox
          ><ElCheckbox value="conversations:read">读取会话</ElCheckbox
          ><ElCheckbox value="conversations:delete">删除会话</ElCheckbox
          ><ElCheckbox value="usage:read">读取用量</ElCheckbox></ElCheckboxGroup
        ></ElFormItem
      >
      <ElDivider class="sm:col-span-2">运行额度</ElDivider>
      <p class="mb-4 text-sm text-muted-foreground sm:col-span-2">
        业务限额按需开启；关闭后仍保留平台并发与防滥用保护，历史填写值不会丢失。
      </p>
      <ElFormItem v-for="limit in limits" :key="limit.key" :label="limit.label">
        <OptionalLimit
          v-model="config[limit.key]"
          :enabled="limitEnabled(limit.key)"
          :label="limit.label"
          :max="limit.max"
          @update:enabled="setLimitEnabled(limit.key, $event)"
        />
      </ElFormItem>
    </template>
  </ElForm>
</template>
