<script setup lang="ts">
import { Page } from "@vben/common-ui";
import { useAccessStore } from "@vben/stores";
import { ChatClient } from "@agent-studio/chat-ui";
import { useRouter } from "vue-router";
import { useChatbotStore } from "#/store/chatbot";
const chat = useChatbotStore(),
  router = useRouter(),
  access = useAccessStore();
</script>
<template>
  <Page auto-content-height content-class="h-full"
    ><ChatClient
      v-if="chat.client"
      :key="chat.scope"
      :client="chat.client"
      :can-configure-models="
        access.accessCodes.includes('model_profiles.manage')
      "
      @configure-model="router.push(`/models/llm/plans/${$event}`)"
      :show-inspect="access.accessCodes.includes('conversations.read')"
      @inspect="router.push(`/executions/${$event}`)"
  /></Page>
</template>
