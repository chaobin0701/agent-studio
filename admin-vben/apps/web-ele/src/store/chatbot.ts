import { shallowRef, watch, ref } from "vue";
import { defineStore } from "pinia";
import { useAccessStore, useUserStore } from "@vben/stores";
import { createChatbotClient, type ChatbotClient } from "@agent-studio/chat-ui";
import { chatbotApi } from "#/api/chatbot";
import { useWorkspaceStore } from "./workspace";
export const useChatbotStore = defineStore("chatbot", () => {
  const workspace = useWorkspaceStore(),
    user = useUserStore(),
    access = useAccessStore();
  const client = shallowRef<ChatbotClient>(),
    scope = ref("");
  watch(
    () => [
      workspace.id,
      workspace.generation,
      user.userInfo?.userId,
      !!access.accessToken,
    ],
    () => {
      client.value?.dispose();
      client.value = undefined;
      scope.value = `admin-chat:${workspace.id}:${user.userInfo?.userId}`;
      if (workspace.id && user.userInfo?.userId && access.accessToken) {
        let storage: Storage | undefined;
        try {
          storage = localStorage;
        } catch {}
        client.value = createChatbotClient(chatbotApi, scope.value, storage);
      }
    },
    { immediate: true },
  );
  function $reset() {
    client.value?.dispose();
    client.value = undefined;
  }
  return { client, scope, $reset };
});
