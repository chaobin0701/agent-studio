<script setup lang="ts">
import { Page } from "@vben/common-ui";
import ManagementHeader from "#/components/ManagementHeader.vue";
import RunPanel from "./RunPanel.vue";
</script>
<template>
  <Page
    ><ManagementHeader
      title="Agent 试运行"
      description="独立任务，不修改生效配置" /><RunPanel
  /></Page>
</template>
