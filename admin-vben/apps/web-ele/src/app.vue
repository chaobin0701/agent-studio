<script lang="ts" setup>
import { useElementPlusDesignTokens } from "@vben/hooks";

import { ElConfigProvider } from "element-plus";

import { elementLocale } from "#/locales";

defineOptions({ name: "App" });

useElementPlusDesignTokens();
</script>

<template>
  <ElConfigProvider :locale="elementLocale" :dialog="{ alignCenter: true }">
    <RouterView />
  </ElConfigProvider>
</template>
