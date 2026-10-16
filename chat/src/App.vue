<script setup lang="ts">
import { ChatClient } from "@agent-studio/chat-ui";
import { ElEmpty } from "element-plus";
import { chat, appId } from "./service";
</script>
<template>
  <div class="studio-chat">
    <header class="studio-chat-brand">
      <strong>Agent Studio</strong><span>对话</span>
    </header>
    <main>
      <ChatClient v-if="appId" :client="chat" :show-inspect="false" /><ElEmpty
        v-else
        description="尚未指定接入应用"
        ><p>
          在后台创建应用并启用网站接入，将本页地址加入允许来源，再使用带 app
          参数的链接打开。
        </p>
        <code>/?app=应用ID</code></ElEmpty
      >
    </main>
  </div>
</template>
